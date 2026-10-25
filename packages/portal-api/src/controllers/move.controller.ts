import { Elysia, t } from 'elysia'
import { nodeRole } from 'config'
import { AuthService } from '../auth/auth.service.js'
import { fiscalInFlight } from 'fiscal/in-flight'
import { MoveError, abortMove, currentMove, preflightMove, startMove } from 'services/biz/move/move.service'

/**
 * Moving an org to its master (FR-20.79, plan step P3-6a): the org admin's side, on lgrai.app.
 * Global only: 404 on a master.
 *
 * - **`admin.settings`**, as the Servers page: the move names one of the org's registered servers.
 * - ⚠ **The home gate lets these through** (`GLOBAL_STATE_WRITES`): they write global's record of the
 *   move, never the org's data, and the abort must work while the org is frozen.
 */

const NOT_FOUND = { message: 'Not found' }
const NODE_ID = '^master-[a-z2-7]{16}$'
const OBJECT_ID = '^[0-9a-f]{24}$'

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
      return preflightMove(orgId, body.nodeId, body.allowMissing ?? [], fiscalInFlight())
    },
    { isSignIn: true, body: t.Object({ nodeId: t.String({ pattern: NODE_ID }), allowMissing: t.Optional(t.Array(t.String({ pattern: OBJECT_ID }), { maxItems: 1000 })) }) },
  )

  /** Start the move: the org freezes on lgrai.app at once (FR-20.79 step 2). */
  .post(
    '/',
    async ({ params: { orgId }, body, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })
      if (!canAdmin(user)) return status(403, { message: 'Forbidden' })
      try {
        return { move: toWire(await startMove(orgId, body.nodeId, { id: user.id, operatorCode: user.operatorCode }, body.allowMissing ?? [], fiscalInFlight())) }
      } catch (e) {
        return fail(status, e)
      }
    },
    { isSignIn: true, body: t.Object({ nodeId: t.String({ pattern: NODE_ID }), allowMissing: t.Optional(t.Array(t.String({ pattern: OBJECT_ID }), { maxItems: 1000 })) }) },
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
