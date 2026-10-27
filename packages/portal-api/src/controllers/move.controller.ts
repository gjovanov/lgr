import { Elysia, t } from 'elysia'
import { nodeRole } from 'config'
import { AuthService } from '../auth/auth.service.js'
import { fiscalInFlight } from 'fiscal/in-flight'
import { MoveError, abortMove, currentMove, preflightMove, startMove } from 'services/biz/move/move.service'
import { preflightMoveBack, startMoveBack } from 'services/biz/move/move-back.service'
import { legalSeriesOf, preflightPromote, promote, recordLastNumbers } from 'services/biz/move/promote.service'
import { fencedExportsOf } from 'services/biz/move/fenced-export.service'
import { requestFencedImport } from 'services/biz/move/fenced-import.service'
import { OrgHome } from 'db/models'
import { rewelcomeNode } from '../websocket/uplink.js'

/**
 * Moving an org to its master (FR-20.79, plan step P3-6a), and back (FR-20.80, P3-6c, `to: 'global'`):
 * the org admin's side, on lgrai.app. Global only: 404 on a master.
 *
 * - **`admin.settings`**, as the Servers page: the move names one of the org's registered servers.
 * - ⚠ **The home gate lets these through** (`GLOBAL_STATE_WRITES`): they write global's record of the
 *   move, never the org's data, and the abort must work while the org is frozen.
 */

const NOT_FOUND = { message: 'Not found' }
const NODE_ID = '^master-[a-z2-7]{16}$'
const OBJECT_ID = '^[0-9a-f]{24}$'

/** A move to one of the org's servers (`nodeId`), or back to lgrai.app (`to: 'global'`). */
const MOVE_BODY = t.Object({
  nodeId: t.Optional(t.String({ pattern: NODE_ID })),
  to: t.Optional(t.Literal('global')),
  allowMissing: t.Optional(t.Array(t.String({ pattern: OBJECT_ID }), { maxItems: 1000 })),
  allowMissingFiles: t.Optional(t.Boolean()),
})

function canAdmin(user: any): boolean {
  return user?.role === 'admin' || !!user?.permissions?.includes('admin.settings')
}

function fail(status: any, e: unknown) {
  if (e instanceof MoveError) return status(e.statusCode, { code: e.code, message: e.message, ...(e.extra ?? {}) })
  throw e
}

/** What the page shows of a move. Never a file path. */
function toWire(m: any) {
  if (!m) return null
  return {
    id: String(m._id),
    kind: m.kind,
    state: m.state,
    from: m.from,
    to: m.to,
    epochFrom: m.epochFrom,
    epochTo: m.epochTo,
    startedAt: m.startedAt,
    endedAt: m.endedAt ?? null,
    error: m.error ?? null,
    copy: m.bundle ? { documents: m.bundle.documents, bytes: m.bundle.bytes, files: m.files?.count ?? 0 } : null,
    // A move back: what it waits for now, and what putting the files back found.
    waiting: m.waiting ? { on: m.waiting.on, since: m.waiting.since, detail: m.waiting.detail ?? null } : null,
    placed: m.placed ?? null,
    // A promotion: what was attested, and from when the mirror's copy is all there is.
    evidence: m.evidence ? { hardware: m.evidence.hardware, silenceSince: m.evidence.silenceSince ?? null } : null,
    lossFrom: m.lossFrom ?? null,
    steps: (m.steps ?? []).map((s: any) => ({ name: s.name, at: s.at, ok: s.ok, detail: s.detail ?? null })),
  }
}

export const moveController = new Elysia({ prefix: '/org/:orgId/moves' })
  .use(AuthService)
  .onBeforeHandle(({ status }) => {
    if (nodeRole() !== 'global') return status(404, NOT_FOUND)
  })

  /** What stands in the way of a move to `nodeId`, all of it at once. Writes nothing. */
  .post(
    '/preflight',
    async ({ params: { orgId }, body, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })
      if (!canAdmin(user)) return status(403, { message: 'Forbidden' })
      if (body.to === 'global') return preflightMoveBack(orgId, !!body.allowMissingFiles)
      if (!body.nodeId) return status(422, { code: 'node_required', message: 'A move to a server names the server.' })
      return preflightMove(orgId, body.nodeId, body.allowMissing ?? [], fiscalInFlight())
    },
    { isSignIn: true, body: MOVE_BODY },
  )

  /** Start the move: the org freezes on lgrai.app at once (FR-20.79 step 2). */
  .post(
    '/',
    async ({ params: { orgId }, body, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })
      if (!canAdmin(user)) return status(403, { message: 'Forbidden' })
      try {
        if (body.to === 'global') {
          const move: any = await startMoveBack(orgId, { id: user.id }, { allowMissingFiles: !!body.allowMissingFiles })
          // Welcomed again, its pump learns the files travel now, even for an org that chose records only.
          rewelcomeNode(move.from)
          return { move: toWire(move) }
        }
        if (!body.nodeId) return status(422, { code: 'node_required', message: 'A move to a server names the server.' })
        return { move: toWire(await startMove(orgId, body.nodeId, { id: user.id, operatorCode: user.operatorCode }, body.allowMissing ?? [], fiscalInFlight())) }
      } catch (e) {
        return fail(status, e)
      }
    },
    { isSignIn: true, body: MOVE_BODY },
  )

  /**
   * FR-20.81 (P3-6d): promoting lgrai.app's mirror when the org's server is lost for good. What stands
   * in the way, the loss window, and whether the server's silence is long enough. Writes nothing.
   */
  .post(
    '/promote/preflight',
    async ({ params: { orgId }, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })
      if (!canAdmin(user)) return status(403, { message: 'Forbidden' })
      return preflightPromote(orgId)
    },
    { isSignIn: true },
  )

  /** Promote it, on the admin's attestation; the legal series freeze until the site's last numbers are in. */
  .post(
    '/promote',
    async ({ params: { orgId }, body, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })
      if (!canAdmin(user)) return status(403, { message: 'Forbidden' })
      try {
        return { move: toWire(await promote(orgId, { id: user.id }, body)) }
      } catch (e) {
        return fail(status, e)
      }
    },
    {
      isSignIn: true,
      body: t.Object({ hardware: t.Union([t.Literal('off'), t.Literal('destroyed')]), tillsDisconnected: t.Boolean(), slug: t.String({ maxLength: 200 }) }),
    },
  )

  /**
   * FR-20.84 (P3-6e): what a replaced server did after the cutoff, as its exports reached lgrai.app,
   * each sale checked against what lgrai.app holds now: new here, already here, or its number given
   * to another document. For a person to review; nothing is imported.
   */
  .get(
    '/fenced-exports',
    async ({ params: { orgId }, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })
      if (!canAdmin(user)) return status(403, { message: 'Forbidden' })
      return { exports: await fencedExportsOf(orgId) }
    },
    { isSignIn: true },
  )

  /**
   * FR-20.84 (P3-6e): bring a received export into the books, through the audited import. Asked once;
   * global's tick runs it in batches, and the review shows what became of each document.
   */
  .post(
    '/fenced-exports/:exportId/import',
    async ({ params: { orgId, exportId }, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })
      if (!canAdmin(user)) return status(403, { message: 'Forbidden' })
      try {
        await requestFencedImport(orgId, exportId, { id: user.id, operatorCode: user.operatorCode })
        return { exports: await fencedExportsOf(orgId) }
      } catch (e) {
        return fail(status, e)
      }
    },
    { isSignIn: true },
  )

  /** Whether legal numbering waits for the site's last numbers, and the series a person must give. */
  .get(
    '/last-numbers',
    async ({ params: { orgId }, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })
      if (!canAdmin(user)) return status(403, { message: 'Forbidden' })
      const home: any = await OrgHome.findOne({ orgId }, { seriesFrozen: 1 }).lean()
      return { frozen: !!home?.seriesFrozen?.since, since: home?.seriesFrozen?.since ?? null, series: await legalSeriesOf(orgId) }
    },
    { isSignIn: true },
  )

  /** The last numbers issued at the site: each legal series resumes above them, and numbering opens. */
  .post(
    '/last-numbers',
    async ({ params: { orgId }, body, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })
      if (!canAdmin(user)) return status(403, { message: 'Forbidden' })
      try {
        return { series: await recordLastNumbers(orgId, { id: user.id, operatorCode: user.operatorCode }, body.series) }
      } catch (e) {
        return fail(status, e)
      }
    },
    {
      isSignIn: true,
      body: t.Object({ series: t.Array(t.Object({ prefix: t.String({ maxLength: 40 }), year: t.Integer({ minimum: 0 }), last: t.Integer({ minimum: 0 }) }), { maxItems: 200 }) }),
    },
  )

  /** The org's live move, or its last one. */
  .get(
    '/current',
    async ({ params: { orgId }, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })
      if (!canAdmin(user)) return status(403, { message: 'Forbidden' })
      return { move: toWire(await currentMove(orgId)) }
    },
    { isSignIn: true },
  )

  /** Undo a move before its flip: lgrai.app unfreezes, and nothing else changed. */
  .post(
    '/:id/abort',
    async ({ params: { orgId, id }, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })
      if (!canAdmin(user)) return status(403, { message: 'Forbidden' })
      const live = await currentMove(orgId)
      if (!live || String(live._id) !== id) return status(404, NOT_FOUND)
      try {
        return { move: toWire(await abortMove(id, 'aborted by an administrator', { id: user.id, operatorCode: user.operatorCode })) }
      } catch (e) {
        return fail(status, e)
      }
    },
    { isSignIn: true, params: t.Object({ orgId: t.String(), id: t.String({ pattern: OBJECT_ID }) }) },
  )
