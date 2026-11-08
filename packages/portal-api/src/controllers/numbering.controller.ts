import { Elysia, t } from 'elysia'
import { nodeRole } from 'config'
import { OrgHome } from 'db/models'
import { thisNode } from 'db/home/home'
import { AuthService } from '../auth/auth.service.js'
import { MoveError } from 'services/biz/move/move.service'
import { legalSeriesOf, recordLastNumbers } from 'services/biz/move/promote.service'
import { lockLegalSeries, mirrorLegalSeries } from 'services/biz/home/series-lock.service'
import { legalMarkOf } from 'services/biz/home/legal-mark.service'
import { deviceEvidence, type DeviceReading } from 'services/biz/home/device-witness.service'
import { recordAuditEntry } from 'services/biz/audit-log.service'
import { getPrinter, isDeviceConnected } from 'fiscal/fiscal-device.service'

/**
 * Whether the org's legal numbering waits for the last numbers issued at a site, and recording them
 * (FR-20.51, FR-20.81): on every node. lgrai.app after a promotion (P3-6d), and a master whose
 * database went back in time: a restore, a reverted snapshot, a clone (P3-7).
 *
 * On a master, lgrai.app's mirror of the org is a floor too, when it can be asked: numbering
 * resumes above the highest of the person's reading and the mirror's. With the link down, the
 * person's reading stands alone, and the audit says so. This server's own mark of what it issued
 * (#549, `legal-mark.service.ts`) is a floor as well, link or not, and is shown beside the series.
 *
 * And on a master, a person locks numbering by hand (`POST /lock`): the runbook's step after a
 * revert nothing here can see (the backup drive put back too, or no drive at all).
 *
 * While it waits, each fiscal device of the org is asked for its last document (AC 49), beside the
 * last receipt this database recorded on it. Evidence for the person, kept in the audit with their
 * reading: never a lock or a floor by itself (`device-witness.service.ts` says why).
 */

const READ_TIMEOUT_MS = 5_000

/** One device's last document number, if it is connected here and its protocol reports one. */
async function readDevice(deviceId: string): Promise<DeviceReading> {
  if (!isDeviceConnected(deviceId)) return { state: 'not_connected' }
  const printer = getPrinter(deviceId)
  if (typeof printer.getLastReceiptNumber !== 'function') return { state: 'unsupported' }
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const n = await Promise.race([
      printer.getLastReceiptNumber(),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`no answer within ${READ_TIMEOUT_MS / 1000} s`)), READ_TIMEOUT_MS) }),
    ])
    return n === undefined || !Number.isSafeInteger(n) ? { state: 'unsupported' } : { state: 'read', lastDocument: n, readAt: new Date() }
  } catch (e: any) {
    return { state: 'error', error: String(e?.message ?? e).slice(0, 200) }
  } finally {
    clearTimeout(timer)
  }
}

function canAdmin(user: any): boolean {
  return user?.role === 'admin' || !!user?.permissions?.includes('admin.settings')
}

export const numberingController = new Elysia({ prefix: '/org/:orgId/numbering' })
  .use(AuthService)

  /** Whether legal numbering waits here, why, the series a person must give, and the mirror's when linked. */
  .get(
    '/last-numbers',
    async ({ params: { orgId }, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })
      if (!canAdmin(user)) return status(403, { message: 'Forbidden' })
      const home: any = await OrgHome.findOne({ orgId }, { seriesFrozen: 1 }).lean()
      const frozen = home?.seriesFrozen
      const [mirror, devices] = frozen?.since
        ? await Promise.all([nodeRole() === 'master' ? mirrorLegalSeries(orgId) : null, deviceEvidence(orgId, readDevice)])
        : [null, []]
      return {
        frozen: !!frozen?.since,
        since: frozen?.since ?? null,
        reason: frozen?.reason ?? null,
        detail: frozen?.detail ?? null,
        series: await legalSeriesOf(orgId),
        mirror,
        // #549: what this server's mark says it issued (null off a master). Numbering resumes above it.
        mark: nodeRole() === 'master' ? await legalMarkOf(orgId) : null,
        devices,
      }
    },
    { isSignIn: true },
  )

  /**
   * Lock legal numbering by hand, on the server the org is written on (the runbook: restored from a
   * disk image or a snapshot that nothing here can see). It stays locked until a person records the
   * last numbers. Already locked, nothing changes. 404 on lgrai.app, where no shop restores a disk.
   */
  .post(
    '/lock',
    async ({ params: { orgId }, body, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })
      if (nodeRole() !== 'master') return status(404, { message: 'Numbering is locked by hand on the organization\'s server' })
      if (!canAdmin(user)) return status(403, { message: 'Forbidden' })
      const home: any = await OrgHome.findOne({ orgId }, { home: 1, state: 1, seriesFrozen: 1 }).lean()
      if (!home || home.home !== thisNode()) {
        return status(409, { code: 'not_home', message: 'The organization is not written on this server: its numbering is locked where it is.' })
      }
      if (home.seriesFrozen?.since) {
        return { locked: true, already: true, since: home.seriesFrozen.since, reason: home.seriesFrozen.reason ?? null, detail: home.seriesFrozen.detail ?? null }
      }
      const who = [user.firstName, user.lastName].filter(Boolean).join(' ').trim() || user.username || user.email || String(user.id)
      const note = (body?.note ?? '').trim()
      const detail = `locked by ${who}${note ? `: ${note}` : ''}`
      const now = new Date()
      const locked = await lockLegalSeries(orgId, 'restored', detail, now)
      if (locked) {
        await recordAuditEntry({
          orgId, userId: user.id, operatorCode: user.operatorCode, action: 'update', module: 'admin',
          entityType: 'sequence', entityId: orgId, entityName: 'legal numbering locked by hand',
          changes: [{ field: 'legal numbering', oldValue: 'open', newValue: 'locked' }, ...(note ? [{ field: 'note', oldValue: null, newValue: note }] : [])],
        })
      }
      // Lost to a lock that landed in between: that one stands, with its own reason.
      const after: any = await OrgHome.findOne({ orgId }, { seriesFrozen: 1 }).lean()
      return {
        locked: !!after?.seriesFrozen?.since,
        already: !locked,
        since: after?.seriesFrozen?.since ?? null,
        reason: after?.seriesFrozen?.reason ?? null,
        detail: after?.seriesFrozen?.detail ?? null,
      }
    },
    { isSignIn: true, body: t.Object({ note: t.Optional(t.String({ maxLength: 300 })) }) },
  )

  /** The last numbers issued at the site: each legal series resumes above them, and numbering opens. */
  .post(
    '/last-numbers',
    async ({ params: { orgId }, body, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })
      if (!canAdmin(user)) return status(403, { message: 'Forbidden' })
      try {
        const [floor, devices] = await Promise.all([nodeRole() === 'master' ? mirrorLegalSeries(orgId) : null, deviceEvidence(orgId, readDevice)])
        return { series: await recordLastNumbers(orgId, { id: user.id, operatorCode: user.operatorCode }, body.series, floor, devices) }
      } catch (e) {
        if (e instanceof MoveError) return status(e.statusCode, { code: e.code, message: e.message, ...(e.extra ?? {}) })
        throw e
      }
    },
    {
      isSignIn: true,
      body: t.Object({ series: t.Array(t.Object({ prefix: t.String({ maxLength: 40 }), year: t.Integer({ minimum: 0 }), last: t.Integer({ minimum: 0 }) }), { maxItems: 200 }) }),
    },
  )
