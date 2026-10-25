import { config, nodeRole } from 'config'
import { Identity, NodeState, User } from 'db/models'
import { logger } from '../../logger/logger.js'
import { fetchWithTimeout } from '../outbound-fetch.js'
import { readNodeToken } from '../relay/outbox-worker.js'
import { credentialFeedPass, dropDeadCredentials } from './onprem-credentials.service.js'
import { forgetIdentity } from './session.service.js'

/**
 * FR-20.43, FR-20.44 (plan step P2-5) — the identity feed: what changes about a master's people on
 * lgrai.app reaches the master, which updates its copies and ends their sessions.
 *
 * - **Global** (`identityChangesFor`) answers `GET /api/node/v1/identity-changes` with the people who
 *   are members of the node's orgs and changed after a cursor (`updatedAt`, then `_id`), oldest
 *   first. Every Identity writer moves `updatedAt`, so nothing has to remember to emit an event; a
 *   daily pass from the start catches whatever a raw write could have missed.
 * - ⚠ **Only who the person is**: email, names, `tokenVersion`, active (FR-20.44). Never a password
 *   hash, an OAuth link or a reset token. A test scans the payload.
 * - **The master** (`identityFeedTick`, every 30 s) applies them to the people it holds, and a
 *   changed `tokenVersion` or deactivation drops the person's cached session state at once
 *   (`forgetIdentity`): every session they hold here ends on its next request.
 * - A `tokenVersion` only ever goes up here. An Air-gapped master has no feed: it owns its people.
 * - **The people's local credentials** (FR-20.40, P2-4c) follow on the same tick, through their own
 *   feed (`onprem-credentials.service.ts`): sealed values, kept apart from who the person is. A
 *   `tokenVersion` bump or a deactivation here drops the credentials it ends.
 */

export interface IdentityChange {
  iid: string
  email: string
  firstName: string
  lastName: string
  tv: number
  active: boolean
}

const STATE_ID = 'identity-feed'
const PAGE = 200
const FULL_EVERY_MS = 24 * 60 * 60_000

function parseCursor(cursor: unknown): { at: Date; id: string } | null {
  const [iso, id] = typeof cursor === 'string' ? cursor.split('|') : []
  const at = new Date(iso ?? '')
  return Number.isFinite(at.getTime()) && /^[0-9a-f]{24}$/.test(id ?? '') ? { at, id } : null
}

/** Global: the node's people changed after `after`, oldest first, at most `limit`. */
export async function identityChangesFor(node: any, after: unknown, limit = PAGE): Promise<{ items: IdentityChange[]; cursor: string | null; more: boolean }> {
  const ids = await User.distinct('identityId', { orgId: { $in: node.orgIds ?? [] }, identityId: { $exists: true } })
  const from = parseCursor(after)
  const filter: Record<string, unknown> = { _id: { $in: ids } }
  if (from) filter.$or = [{ updatedAt: { $gt: from.at } }, { updatedAt: from.at, _id: { $gt: from.id } }]
  // ⚠ Clamped once and used for both: a limit above the page size used to fetch PAGE + 1 rows and
  // compare them with the unclamped limit, so `more` said false while there were more.
  const n = Math.min(Math.max(1, Number(limit) || PAGE), PAGE)
  const rows: any[] = await Identity.find(filter)
    .select('email firstName lastName tokenVersion isActive updatedAt')
    .sort({ updatedAt: 1, _id: 1 })
    .limit(n + 1)
    .lean()
  const more = rows.length > n
  const page = rows.slice(0, n)
  const last = page[page.length - 1]
  return {
    items: page.map(r => ({ iid: String(r._id), email: r.email, firstName: r.firstName ?? '', lastName: r.lastName ?? '', tv: r.tokenVersion ?? 0, active: !!r.isActive })),
    cursor: last ? `${new Date(last.updatedAt).toISOString()}|${last._id}` : typeof after === 'string' && from ? after : null,
    more,
  }
}

/** The master: apply changes to the people it holds. Returns how many changed. */
export async function applyIdentityChanges(items: readonly IdentityChange[]): Promise<number> {
  let changed = 0
  for (const it of items) {
    const local: any = await Identity.findById(it.iid).select('email firstName lastName tokenVersion isActive').lean()
    if (!local) continue
    const set: Record<string, unknown> = {}
    if (it.email && local.email !== it.email) set.email = it.email
    if (local.firstName !== it.firstName) set.firstName = it.firstName
    if (local.lastName !== it.lastName) set.lastName = it.lastName
    if ((local.tokenVersion ?? 0) < it.tv) set.tokenVersion = it.tv
    if (!!local.isActive !== it.active) set.isActive = it.active
    if (!Object.keys(set).length) continue
    try {
      await Identity.updateOne({ _id: it.iid }, { $set: set })
    } catch (e: any) {
      // Two people swapping addresses can collide on the unique email for a moment: the rest
      // still applies, and the next pass completes it.
      if (e?.code !== 11000) throw e
      delete set.email
      if (Object.keys(set).length) await Identity.updateOne({ _id: it.iid }, { $set: set })
    }
    forgetIdentity(it.iid)
    // FR-20.40: a password change or a sign-out everywhere on lgrai.app, or a deactivation, ends the
    // person's local credentials here too.
    if (set.tokenVersion !== undefined || set.isActive === false) await dropDeadCredentials(it.iid, it.tv, it.active)
    changed++
  }
  return changed
}

let running = false

/** The master's scheduler tick: pull what changed since the cursor, a full pass once a day. */
export async function identityFeedTick(now = new Date(), fetchImpl: typeof fetch = fetch): Promise<number> {
  if (nodeRole() !== 'master' || running) return 0
  const token = readNodeToken(config.outbox.tokenFile, now.getTime())
  if (!token) return 0
  running = true
  try {
    const state: any = (await NodeState.findById(STATE_ID).lean())?.value ?? {}
    const full = !state.fullAt || now.getTime() - new Date(state.fullAt).getTime() > FULL_EVERY_MS
    let cursor: string | undefined = full ? undefined : state.cursor
    let changed = 0
    for (let page = 0; page < 50; page++) {
      const url = new URL('/api/node/v1/identity-changes', token.server)
      if (cursor) url.searchParams.set('after', cursor)
      url.searchParams.set('limit', String(PAGE))
      const res = await fetchWithTimeout(url, { headers: { authorization: `Bearer ${token.token}` } }, { timeoutMs: 20_000, fetchImpl })
      if (!res.ok) {
        logger.warn({ status: res.status }, 'the identity feed was refused this round')
        break
      }
      const body: any = await res.json()
      changed += await applyIdentityChanges(Array.isArray(body?.items) ? body.items : [])
      cursor = typeof body?.cursor === 'string' ? body.cursor : cursor
      const done = !body?.more
      await NodeState.updateOne(
        { _id: STATE_ID },
        { $set: { value: { cursor, fullAt: full && done ? now : state.fullAt ?? null } } },
        { upsert: true },
      )
      if (done) break
    }
    if (changed) logger.info({ changed }, 'Applied identity changes from lgrai.app')
    // After the people, so a credential set at a `tokenVersion` this master has just learned is live.
    await credentialFeedPass(token, now, fetchImpl).catch(e => logger.warn({ err: String(e?.message ?? e) }, 'the credential feed failed this round'))
    return changed
  } catch (e: any) {
    logger.warn({ err: String(e?.message ?? e) }, 'the identity feed failed this round')
    return 0
  } finally {
    running = false
  }
}
