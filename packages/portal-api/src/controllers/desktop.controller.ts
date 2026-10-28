import { Elysia, t } from 'elysia'
import { AuthService } from '../auth/auth.service.js'
import { createAuditEntry } from 'services/biz/audit-log.service'
import { paginateQuery } from 'services/utils/pagination'
import { Desktop, DesktopEnrollmentCode, DesktopEnrollmentKey, DesktopEnrollmentKeyUse, Org } from 'db/models'
import {
  DesktopError,
  mintEnrollmentCode,
  mintEnrollmentKey,
  presenceOf,
  revokeDesktop,
  rotateDesktopKey,
  updateDesktop,
} from 'services/biz/desktop/desktop.service'
import { START_PATH_PATTERN } from 'services/biz/desktop/desktop-crypto'
import { isDesktopOnline, notifyDesktopRevoked, requestDesktopUpdate } from '../websocket/desktop.js'
import { stopDesktopBridges } from '../websocket/fiscal-bridge.js'

/**
 * The admin side of desktop registration — what the Desktops page (FR-14.23) talks to.
 *
 * ## Why `admin.settings` and not a new permission
 *
 * ⚠ A new permission needs a model change, a PermissionSet backfill **and a re-login** before it
 * takes effect, because a JWT carries the permission list it was issued with. That ordering hazard
 * is what made the Reports tile silently vanish in FR-06 P2, and FR-13.26 avoided it the same way.
 * `admin.settings` is already exactly this audience.
 *
 * ⚠ Tenancy needs nothing here: these routes carry `:orgId`, so `AuthService`'s unconditional
 * `isForeignOrg` guard already refuses a caller whose JWT names a different org. Every query still
 * filters by `orgId` as well — `tenantPlugin` adds the field and does NOT filter.
 */

/** Admin-or-`admin.settings`, the same expression the other admin controllers use. */
function canAdmin(user: any): boolean {
  return user?.role === 'admin' || !!user?.permissions?.includes('admin.settings')
}

function fail(status: any, e: unknown) {
  if (e instanceof DesktopError) return status(e.statusCode, { code: e.code, message: e.message })
  throw e
}

/** What the list and detail endpoints return. Presence is computed, never stored. */
function toWire(d: any) {
  return {
    id: String(d._id),
    name: d.name,
    nameAdminSet: !!d.nameAdminSet,
    machineId: d.machineId,
    installationId: d.installationId,
    os: d.os,
    hostname: d.hostname,
    status: d.status,
    ephemeral: !!d.ephemeral,
    appVersion: d.appVersion,
    capabilities: d.capabilities,
    fiscalDeviceIds: (d.fiscalDeviceIds ?? []).map(String),
    startPath: d.startPath,
    lastSeenAt: d.lastSeenAt,
    clockSkewMs: d.lastPresence?.clockSkewMs,
    keyEpoch: d.keyEpoch,
    enrolledAt: d.enrolledAt,
    revokedAt: d.revokedAt,
    revokeReason: d.revokeReason,
    presence: presenceOf(d, isDesktopOnline(String(d._id))),
    // ⚠ `publicKey` is deliberately NOT here. It is not a secret, but nothing in the UI needs it,
    // and a field nobody needs is one nobody has to think about later.
  }
}

export const desktopController = new Elysia({ prefix: '/org/:orgId/desktops' })
  .use(AuthService)

  // ── The list ──────────────────────────────────────────────────────────────────────────────
  .get(
    '/',
    async ({ params: { orgId }, query, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })
      if (!canAdmin(user)) return status(403, { message: 'Forbidden' })

      const filter: Record<string, any> = { orgId }
      // ⚠ Revoked rows are hidden by default. The field lanes create and revoke dozens of
      // ephemeral desktops, and without this the real tills drown in them.
      if (query.includeRevoked !== 'true') filter.status = 'active'
      if (query.search) {
        const rx = new RegExp(String(query.search).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')
        filter.$or = [{ name: rx }, { hostname: rx }]
      }

      const result = await paginateQuery(Desktop as any, filter, query, { sortBy: 'lastSeenAt', size: 25 })
      // The store destructures a named key — never `{ data }` (CLAUDE.md's store contract).
      return { desktops: result.items.map(toWire), total: result.total, page: result.page, pageSize: result.size }
    },
    { isSignIn: true },
  )

  .get(
    '/:id',
    async ({ params: { orgId, id }, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })
      if (!canAdmin(user)) return status(403, { message: 'Forbidden' })
      const d = await Desktop.findOne({ _id: id, orgId }).lean()
      if (!d) return status(404, { message: 'Desktop not found' })
      return { desktop: toWire(d) }
    },
    { isSignIn: true },
  )

  // ── Rename / assign ───────────────────────────────────────────────────────────────────────
  .put(
    '/:id',
    async ({ params: { orgId, id }, body, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })
      if (!canAdmin(user)) return status(403, { message: 'Forbidden' })
      try {
        const before = await Desktop.findOne({ _id: id, orgId }).lean()
        if (!before) return status(404, { message: 'Desktop not found' })
        const d = await updateDesktop(orgId, id, body)
        createAuditEntry({
          orgId, userId: user.id, operatorCode: user.operatorCode,
          action: 'update', module: 'admin', entityType: 'desktop',
          entityId: id, entityName: d.name,
          changes: [
            ...(body.name !== undefined && body.name !== (before as any).name
              ? [{ field: 'name', oldValue: (before as any).name, newValue: body.name }] : []),
            ...(body.startPath !== undefined && body.startPath !== (before as any).startPath
              ? [{ field: 'startPath', oldValue: (before as any).startPath ?? null, newValue: body.startPath }] : []),
            ...(body.fiscalDeviceIds !== undefined
              ? [{
                  field: 'fiscalDeviceIds',
                  oldValue: ((before as any).fiscalDeviceIds ?? []).map(String),
                  newValue: body.fiscalDeviceIds,
                }] : []),
          ],
        })
        return { desktop: toWire(d) }
      } catch (e) {
        return fail(status, e)
      }
    },
    {
      isSignIn: true,
      body: t.Object({
        name: t.Optional(t.String({ minLength: 1, maxLength: 120 })),
        fiscalDeviceIds: t.Optional(t.Array(t.String(), { maxItems: 16 })),
        // `''` clears it — the UI's "no assigned start path" case.
        //
        // ⚠ The pattern comes from `START_PATH_PATTERN`, not written out here. The obvious
        // `^$|^/[A-Za-z0-9._~/-]*$` ACCEPTS `//evil.example`, `///x`, `/pos/../admin` and
        // `/../etc` — four holes, and `//evil.example` is the exact trap FR-14.12 names. One
        // canonical rule, one place to fix it.
        startPath: t.Optional(t.String({ maxLength: 200, pattern: START_PATH_PATTERN })),
      }),
    },
  )

  // ── Revoke ────────────────────────────────────────────────────────────────────────────────
  .post(
    '/:id/revoke',
    async ({ params: { orgId, id }, body, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })
      if (!canAdmin(user)) return status(403, { message: 'Forbidden' })
      try {
        const d = await revokeDesktop(orgId, id, user.id, body?.reason)
        createAuditEntry({
          orgId, userId: user.id, operatorCode: user.operatorCode,
          action: 'update', module: 'admin', entityType: 'desktop',
          entityId: id, entityName: d.name,
          changes: [{ field: 'status', oldValue: 'active', newValue: d.ephemeral ? 'deleted' : 'revoked' }],
        })
        // ⚠ Revocation takes effect because every desktop request re-reads the row; the socket
        // notice below (FR-14.22) is a courtesy that makes it visible at once, not the mechanism.
        // It was written and never called: the first field lane (vmtest T-0) revoked a desktop and
        // its shell still did not know two minutes later, waiting for its next token.
        //
        // ⚠ The fiscal bridge is the ONE exception, and it is not a courtesy (FR-14.26, C18). A
        // bridge is a socket that is already authenticated and holding a serial port: it re-reads
        // nothing until it reconnects, so without this a revoked till would keep printing. The
        // shell stops its own bridge when it learns it was revoked, but it may be offline or
        // mid-print, and revocation must not depend on the till cooperating.
        const bridges = await stopDesktopBridges(id)
        const org: any = await Org.findById(orgId).select('name').lean()
        notifyDesktopRevoked(id, org?.name ?? 'the organization')
        return { ok: true, status: d.ephemeral ? 'deleted' : 'revoked', bridgesStopped: bridges }
      } catch (e) {
        return fail(status, e)
      }
    },
    { isSignIn: true, body: t.Optional(t.Object({ reason: t.Optional(t.String({ maxLength: 200 })) })) },
  )

  // ── Rotate key ────────────────────────────────────────────────────────────────────────────
  .post(
    '/:id/rotate-key',
    async ({ params: { orgId, id }, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })
      if (!canAdmin(user)) return status(403, { message: 'Forbidden' })
      try {
        const d = await rotateDesktopKey(orgId, id)
        createAuditEntry({
          orgId, userId: user.id, operatorCode: user.operatorCode,
          action: 'update', module: 'admin', entityType: 'desktop',
          entityId: id, entityName: d.name,
          changes: [{ field: 'keyEpoch', oldValue: (d.keyEpoch ?? 1) - 1, newValue: d.keyEpoch }],
        })
        // A rotation invalidates every token already issued, so the bridge's credential is dead
        // too — drop the socket rather than leaving it printing on a token the hub would now
        // refuse. The shell re-authenticates and reconnects by itself.
        await stopDesktopBridges(id)
        return { ok: true, keyEpoch: d.keyEpoch }
      } catch (e) {
        return fail(status, e)
      }
    },
    { isSignIn: true },
  )

  // ── Update now / update all ───────────────────────────────────────────────────────────────
  .post(
    '/:id/update',
    async ({ params: { orgId, id }, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })
      if (!canAdmin(user)) return status(403, { message: 'Forbidden' })
      const d = await Desktop.findOne({ _id: id, orgId, status: 'active' }).lean()
      if (!d) return status(404, { message: 'Desktop not found' })
      const delivered = requestDesktopUpdate(String((d as any)._id))
      createAuditEntry({
        orgId, userId: user.id, operatorCode: user.operatorCode,
        action: 'update', module: 'admin', entityType: 'desktop',
        entityId: id, entityName: (d as any).name,
        changes: [{ field: 'updateRequested', oldValue: null, newValue: delivered ? 'sent' : 'offline' }],
      })
      // ⚠ `delivered: false` is not an error. A till that is switched off checks for updates when it
      // next starts; reporting a failure would invite someone to keep clicking.
      return { ok: true, delivered }
    },
    { isSignIn: true },
  )

  .post(
    '/update-all',
    async ({ params: { orgId }, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })
      if (!canAdmin(user)) return status(403, { message: 'Forbidden' })
      const rows = await Desktop.find({ orgId, status: 'active' }).select('_id name').lean()
      let delivered = 0
      for (const r of rows) if (requestDesktopUpdate(String((r as any)._id))) delivered++
      createAuditEntry({
        orgId, userId: user.id, operatorCode: user.operatorCode,
        action: 'update', module: 'admin', entityType: 'desktop',
        entityId: orgId, entityName: 'all desktops',
        changes: [{ field: 'updateRequested', oldValue: null, newValue: `${delivered}/${rows.length}` }],
      })
      return { ok: true, requested: rows.length, delivered }
    },
    { isSignIn: true },
  )

  // ── Enrollment codes ──────────────────────────────────────────────────────────────────────
  .post(
    '/enrollment-codes',
    async ({ params: { orgId }, user, status, request }) => {
      if (!user) return status(401, { message: 'Unauthorized' })
      if (!canAdmin(user)) return status(403, { message: 'Forbidden' })
      const origin = new URL(request.url).origin
      const minted = await mintEnrollmentCode(orgId, user.id, origin)
      createAuditEntry({
        orgId, userId: user.id, operatorCode: user.operatorCode,
        action: 'create', module: 'admin', entityType: 'desktop',
        entityId: minted.id, entityName: 'enrollment code',
        // ⚠ The code itself is never audit-logged. An audit trail readable by every admin.audit
        // holder must not contain live credentials.
        changes: [{ field: 'enrollmentCode', oldValue: null, newValue: 'minted' }],
      })
      return minted
    },
    { isSignIn: true },
  )

  /** Lets the Register dialog close itself when the desktop appears (FR-14.23). */
  .get(
    '/enrollment-codes/:id',
    async ({ params: { orgId, id }, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })
      if (!canAdmin(user)) return status(403, { message: 'Forbidden' })
      const row = await DesktopEnrollmentCode.findOne({ _id: id, orgId }).lean()
      if (!row) return status(404, { message: 'Code not found' })
      const r: any = row
      const state = r.usedAt ? 'used' : r.expiresAt.getTime() < Date.now() ? 'expired' : 'unused'
      let usedBy: string | undefined
      if (r.usedByDesktopId) {
        const d = await Desktop.findById(r.usedByDesktopId).select('name').lean()
        usedBy = (d as any)?.name
      }
      return { id: String(r._id), state, expiresAt: r.expiresAt, usedAt: r.usedAt, usedBy }
    },
    { isSignIn: true },
  )

  // ── Ephemeral enrollment keys (field-test lanes) ───────────────────────────────────────────
  .get(
    '/enrollment-keys',
    async ({ params: { orgId }, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })
      if (!canAdmin(user)) return status(403, { message: 'Forbidden' })
      const rows = await DesktopEnrollmentKey.find({ orgId }).sort({ createdAt: -1 }).lean()
      return {
        enrollmentKeys: rows.map((r: any) => ({
          id: String(r._id),
          name: r.name,
          // The prefix only — the key itself is shown once, at creation, and stored hashed.
          keyPrefix: r.keyPrefix,
          maxUses: r.maxUses,
          uses: r.uses,
          expiresAt: r.expiresAt,
          revokedAt: r.revokedAt,
          ephemeralTtlSec: r.ephemeralTtlSec,
          createdAt: r.createdAt,
        })),
        total: rows.length,
      }
    },
    { isSignIn: true },
  )

  .post(
    '/enrollment-keys',
    async ({ params: { orgId }, body, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })
      if (!canAdmin(user)) return status(403, { message: 'Forbidden' })
      try {
        const minted = await mintEnrollmentKey(orgId, user.id, {
          name: body.name,
          maxUses: body.maxUses,
          expiresAt: body.expiresAt ? new Date(body.expiresAt) : undefined,
          ephemeralTtlSec: body.ephemeralTtlSec,
        })
        createAuditEntry({
          orgId, userId: user.id, operatorCode: user.operatorCode,
          action: 'create', module: 'admin', entityType: 'desktop',
          entityId: minted.id, entityName: `enrollment key: ${body.name}`,
          changes: [{ field: 'enrollmentKey', oldValue: null, newValue: 'minted' }],
        })
        return minted
      } catch (e) {
        return fail(status, e)
      }
    },
    {
      isSignIn: true,
      body: t.Object({
        name: t.String({ minLength: 1, maxLength: 80 }),
        maxUses: t.Optional(t.Number({ minimum: 0, maximum: 10000 })),
        expiresAt: t.Optional(t.String()),
        ephemeralTtlSec: t.Optional(t.Number({ minimum: 60, maximum: 86400 })),
      }),
    },
  )

  .delete(
    '/enrollment-keys/:id',
    async ({ params: { orgId, id }, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })
      if (!canAdmin(user)) return status(403, { message: 'Forbidden' })
      const row = await DesktopEnrollmentKey.findOne({ _id: id, orgId })
      if (!row) return status(404, { message: 'Key not found' })
      row.revokedAt = new Date()
      row.revokedBy = user.id as any
      await row.save()
      createAuditEntry({
        orgId, userId: user.id, operatorCode: user.operatorCode,
        action: 'delete', module: 'admin', entityType: 'desktop',
        entityId: id, entityName: `enrollment key: ${row.name}`,
        changes: [{ field: 'revokedAt', oldValue: null, newValue: row.revokedAt }],
      })
      return { ok: true }
    },
    { isSignIn: true },
  )

  .get(
    '/enrollment-keys/:id/uses',
    async ({ params: { orgId, id }, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })
      if (!canAdmin(user)) return status(403, { message: 'Forbidden' })
      const rows = await DesktopEnrollmentKeyUse.find({ orgId, keyId: id })
        .sort({ createdAt: -1 })
        .limit(200)
        .lean()
      return {
        uses: rows.map((r: any) => ({
          id: String(r._id),
          desktopId: String(r.desktopId),
          installationId: r.installationId,
          hostname: r.hostname,
          ip: r.ip,
          createdAt: r.createdAt,
        })),
        total: rows.length,
      }
    },
    { isSignIn: true },
  )
