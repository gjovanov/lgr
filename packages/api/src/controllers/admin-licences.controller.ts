import { Elysia, t } from 'elysia'
import { nodeRole } from 'config'
import { NODE_ID_PATTERN, Org, OrgLicence, ServerNode } from 'db/models'
import { AuthService } from '../auth/auth.service.js'
import { notifyEntitlementsChanged } from '../websocket/uplink.js'
import { entitlementsOf, issueLicences, issuerKey } from 'services/biz/licence/licence-issue.service'
import { GRACE_DAYS, graceEndsAt } from 'services/biz/licence/licence-token'
import { isSysAdmin } from 'services/biz/sys-admin'
import { logger } from 'services/logger'

/**
 * The sys-admins' licences (FR-20.55, plan step P2-3b): which orgs are entitled to run on a master
 * and why, the pilots, and a licence FILE for an air-gapped master that never talks to global.
 * Global only: 404 on a master. `BACKUP_SYS_ADMINS` only, like All servers.
 *
 * ⚠ The org is `:id` (its id, or its slug), never `:orgId`: the tenant guard would read a sys-admin's
 * own org into it.
 *
 * ⚠ Revoking a pilot stops its RENEWALS. A licence a master already holds is signed and verified
 * offline, so it runs out on its own dates; that is the price of a shop that works with the
 * internet down.
 */

const OBJECT_ID = /^[0-9a-f]{24}$/
const MAX_PILOT_DAYS = 730
const NOT_FOUND = { message: 'Not found' }

/** An org by its id or its slug: an air-gapped master's org is in no list here until it has a pilot. */
async function findOrg(idOrSlug: string): Promise<any | null> {
  if (OBJECT_ID.test(idOrSlug)) return Org.findById(idOrSlug).select('slug name').lean()
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(idOrSlug)) return null
  return Org.findOne({ slug: idOrSlug }).select('slug name').lean()
}

/** A date-only `until` covers the whole of that day (UTC); a full timestamp is taken as it is. */
export function parseUntil(raw: string): Date | null {
  const s = String(raw ?? '').trim()
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s)
  const d = day ? new Date(Date.UTC(+day[1], +day[2] - 1, +day[3], 23, 59, 59, 999)) : new Date(s)
  return Number.isFinite(d.getTime()) ? d : null
}

export const adminLicencesController = new Elysia({ prefix: '/admin/licences' })
  .use(AuthService)
  .onBeforeHandle(({ status }) => {
    if (nodeRole() !== 'global') return status(404, NOT_FOUND)
  })
  .get(
    '/',
    async ({ user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })
      if (!isSysAdmin(user)) return status(403, { message: 'This page requires a system administrator' })
      const [pilots, nodes] = await Promise.all([
        OrgLicence.find({}).sort({ until: -1 }).limit(500).lean(),
        ServerNode.find({ status: 'active' }).select('orgIds').lean(),
      ])
      const masters = new Map<string, number>()
      for (const n of nodes as any[]) for (const id of n.orgIds ?? []) masters.set(String(id), (masters.get(String(id)) ?? 0) + 1)
      const ids = [...new Set([...pilots.map((p: any) => String(p.orgId)), ...masters.keys()])]
      const [orgs, entitled] = await Promise.all([
        Org.find({ _id: { $in: ids } }).select('name slug subscription.plan subscription.status subscription.currentPeriodEnd').lean(),
        entitlementsOf(ids),
      ])
      const pilotOf = new Map(pilots.map((p: any) => [String(p.orgId), p]))
      const signing = issuerKey()
      return {
        signing: signing.ok ? { ok: true, kid: signing.key.kid } : { ok: false, reason: signing.reason },
        graceDays: GRACE_DAYS,
        orgs: (orgs as any[]).map(o => {
          const id = String(o._id)
          const p: any = pilotOf.get(id)
          const e = entitled.get(id)
          return {
            id, slug: o.slug, name: o.name,
            masters: masters.get(id) ?? 0,
            subscription: { plan: o.subscription?.plan, status: o.subscription?.status, currentPeriodEnd: o.subscription?.currentPeriodEnd ?? null },
            pilot: p ? { until: p.until, note: p.note ?? '', issuedBy: p.issuedBy, issuedAt: p.issuedAt, revokedAt: p.revokedAt ?? null, revokedBy: p.revokedBy ?? null } : null,
            entitlement: e ? { plan: e.plan, paidThrough: e.paidThrough, graceEndsAt: graceEndsAt({ paidThrough: e.paidThrough.toISOString(), graceDays: GRACE_DAYS }) } : null,
          }
        }).sort((a, b) => a.name.localeCompare(b.name)),
      }
    },
    { isSignIn: true },
  )

  /** Issue a pilot, or move its date. Its masters hear it at once on this pod, within 10 minutes on any. */
  .put(
    '/:id',
    async ({ params: { id }, body, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })
      if (!isSysAdmin(user)) return status(403, { message: 'This page requires a system administrator' })
      const org = await findOrg(id)
      if (!org) return status(404, NOT_FOUND)
      const orgId = String(org._id)
      const until = parseUntil(body.until)
      const now = Date.now()
      if (!until || until.getTime() < now) return status(422, { code: 'bad_until', message: 'The pilot runs until a date that has not passed.' })
      if (until.getTime() > now + MAX_PILOT_DAYS * 86_400_000) return status(422, { code: 'bad_until', message: `A pilot runs at most ${MAX_PILOT_DAYS} days; a longer one is a subscription.` })
      const by = String(user.email || user.id)
      const row = await OrgLicence.findOneAndUpdate(
        { orgId },
        { $set: { kind: 'pilot', until, note: body.note ?? '', issuedBy: by, issuedAt: new Date() }, $unset: { revokedAt: 1, revokedBy: 1 } },
        { upsert: true, new: true },
      ).lean()
      logger.info({ orgId, org: org.slug, until: until.toISOString(), by }, 'Pilot licence issued')
      const told = await notifyEntitlementsChanged(orgId).catch(() => 0)
      return { pilot: row, told }
    },
    { isSignIn: true, body: t.Object({ until: t.String({ maxLength: 40 }), note: t.Optional(t.String({ maxLength: 500 })) }) },
  )

  /** Revoke a pilot: no more renewals. What a master holds runs out on its own dates. */
  .delete(
    '/:id',
    async ({ params: { id }, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })
      if (!isSysAdmin(user)) return status(403, { message: 'This page requires a system administrator' })
      if (!OBJECT_ID.test(id)) return status(404, NOT_FOUND)
      const by = String(user.email || user.id)
      const row = await OrgLicence.findOneAndUpdate({ orgId: id, revokedAt: { $exists: false } }, { $set: { revokedAt: new Date(), revokedBy: by } }, { new: true }).lean()
      if (!row) return status(404, NOT_FOUND)
      logger.info({ orgId: id, by }, 'Pilot licence revoked')
      return { pilot: row }
    },
    { isSignIn: true },
  )

  /**
   * A licence FILE for an air-gapped master (`lgr-server licence import <file>` there). It names the
   * master: the operator reads its id off `lgr-server status`.
   */
  .post(
    '/:id/file',
    async ({ params: { id }, body, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })
      if (!isSysAdmin(user)) return status(403, { message: 'This page requires a system administrator' })
      const nodeId = String(body.nodeId ?? '').trim()
      if (!NODE_ID_PATTERN.test(nodeId)) return status(422, { code: 'bad_node', message: 'A server id looks like master- and 16 letters and digits, as `lgr-server status` shows it.' })
      const signing = issuerKey()
      if (!signing.ok) return status(503, { code: 'licence_signing_unavailable', message: signing.reason })
      const org = await findOrg(id)
      if (!org) return status(404, NOT_FOUND)
      const orgId = String(org._id)
      const issued = (await issueLicences(nodeId, [orgId])).get(orgId)
      if (!issued) return status(409, { code: 'not_entitled', message: 'This organisation has no Enterprise subscription and no pilot: there is nothing to license.' })
      logger.info({ orgId, nodeId, paidThrough: issued.entitlement.paidThrough.toISOString(), by: String(user.email || user.id) }, 'Licence file issued')
      return {
        fileName: `lgr-licence-${org.slug}-${nodeId}.jws`,
        jws: issued.jws,
        plan: issued.entitlement.plan,
        paidThrough: issued.entitlement.paidThrough,
        graceEndsAt: graceEndsAt({ paidThrough: issued.entitlement.paidThrough.toISOString(), graceDays: GRACE_DAYS }),
      }
    },
    { isSignIn: true, body: t.Object({ nodeId: t.String({ maxLength: 40 }) }) },
  )
