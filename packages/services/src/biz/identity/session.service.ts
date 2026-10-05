import { Identity, Org, User, type IIdentity, type IUser } from 'db/models'
import { normalizeEmail } from './email.js'

/**
 * Signing in as a PERSON (multi-org sign-in, Phase 2): who a sign-in names, which org it lands
 * in, the identity-only token for someone who has not picked one yet, and session revocation.
 *
 * A session stays org-scoped: the token `tokenize()` mints for ONE membership, so the tenant guard
 * and every permission check are untouched. A person in several orgs holds one such token per org
 * they switch into; `iid` and `tv` on it tie it back to the person, which is what lets a password
 * change end every session they hold (`identityStillValid`).
 *
 * Imports nothing from `auth.service`, which builds sessions on top of this (no import cycle).
 */

// ── Who a sign-in names ─────────────────────────────────────────────────────────────────────

/** Never-activated memberships count (the person learns why they cannot sign in); deactivated do not. */
const LIVE_OR_PENDING = { $or: [{ isActive: true }, { isActive: false, deactivatedAt: null }] }
const ANY_CASE = { locale: 'en', strength: 2 } as const

export type LoginCandidate =
  | { kind: 'identity'; identity: IIdentity }
  /** A user the migration has not linked yet: it signs in as before, to its own org only. */
  | { kind: 'user'; user: IUser }

/**
 * Every person a sign-in identifier could name. An email names at most one person; a username
 * names everyone who uses it in an org (it is unique per org only). A user whose `identityId`
 * points at nothing (a per-org backup restored without `identities`) is treated as unlinked, so a
 * restore never locks its people out.
 *
 * Password hashes are selected: the caller verifies exactly one of them (`verifyPassword`).
 */
export async function findLoginCandidates(identifier: string): Promise<LoginCandidate[]> {
  const id = (identifier ?? '').trim()
  if (!id) return []

  if (id.includes('@')) {
    const address = normalizeEmail(id)
    const identity = await Identity.findOne({ email: address }).select('+password').exec()
    const users = await User.find({ email: address, ...LIVE_OR_PENDING }).collation(ANY_CASE).exec()
    return withUnlinked(identity ? [identity] : [], users)
  }

  const users = await User.find({ username: id, ...LIVE_OR_PENDING }).exec()
  const ids = [...new Set(users.filter(u => u.identityId).map(u => String(u.identityId)))]
  const identities = ids.length ? await Identity.find({ _id: { $in: ids } }).select('+password').exec() : []
  return withUnlinked(identities, users)
}

function withUnlinked(identities: IIdentity[], users: IUser[]): LoginCandidate[] {
  const known = new Set(identities.map(i => String(i._id)))
  const unlinked = users.filter(u => !u.identityId || !known.has(String(u.identityId)))
  return [
    ...identities.map(identity => ({ kind: 'identity' as const, identity })),
    ...unlinked.map(user => ({ kind: 'user' as const, user })),
  ]
}

// ── One bounded password check ──────────────────────────────────────────────────────────────

/**
 * argon2id costs ~64 MiB per verify. Unbounded, a burst of sign-in attempts is a memory
 * exhaustion attack on the pod; a semaphore makes the burst queue instead. Rule 1 of the plan:
 * at most ONE verify per sign-in request, and at most this many at once in the process.
 */
const MAX_CONCURRENT_VERIFIES = 4
let verifying = 0
const queue: Array<() => void> = []

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  if (verifying >= MAX_CONCURRENT_VERIFIES) await new Promise<void>(resolve => queue.push(resolve))
  verifying++
  try {
    return await Bun.password.verify(password, hash)
  } catch {
    return false // a malformed stored hash is a wrong password, never a 500
  } finally {
    verifying--
    queue.shift()?.()
  }
}

// ── Where a person lands ────────────────────────────────────────────────────────────────────

export interface Membership {
  user: IUser
  org: { id: string; name: string; slug: string }
}

/** The person's active memberships, with their orgs, in a stable order (org name). */
export async function membershipsOf(identityId: unknown): Promise<Membership[]> {
  const users = await User.find({ identityId, isActive: true }).exec()
  const orgs = await Org.find({ _id: { $in: users.map(u => u.orgId) } }, { name: 1, slug: 1 }).lean().exec()
  const byId = new Map(orgs.map(o => [String(o._id), o]))
  return users
    .filter(u => byId.has(String(u.orgId)))
    .map(user => {
      const o = byId.get(String(user.orgId))!
      return { user, org: { id: String(o._id), name: o.name, slug: o.slug } }
    })
    .sort((a, b) => a.org.name.localeCompare(b.org.name))
}

/**
 * Rule 5: never land in an org the person did not pick. In order: the org this browser was last
 * in (`preferredOrgId`, sent by the client), the person's last org, their only membership.
 * Otherwise `null`: they choose (and an org a membership was planted in is never a default).
 */
export function chooseLanding(
  identity: Pick<IIdentity, 'lastOrgId'>,
  memberships: Membership[],
  preferredOrgId?: string,
): Membership | null {
  const pick = (orgId: unknown) => (orgId ? memberships.find(m => m.org.id === String(orgId)) : undefined)
  return pick(preferredOrgId) ?? pick(identity.lastOrgId) ?? (memberships.length === 1 ? memberships[0] : null)
}

// ── The identity-only token ─────────────────────────────────────────────────────────────────

/**
 * A person who has proven who they are and is in no org yet. It carries no `id`/`orgId`, so
 * `asSessionUser` refuses it and no org route can be reached with it; only the identity routes
 * (`services/biz/identity-routes.ts`) accept it.
 */
export interface IdentityClaims {
  type: 'identity'
  iid: string
  tv: number
  email: string
}

export function identityClaims(identity: Pick<IIdentity, '_id' | 'tokenVersion' | 'email'>): IdentityClaims {
  return { type: 'identity', iid: String(identity._id), tv: identity.tokenVersion ?? 0, email: identity.email }
}

export function asIdentityClaims(payload: unknown): IdentityClaims | null {
  if (!payload || typeof payload !== 'object') return null
  const p = payload as Record<string, unknown>
  if (p.type !== 'identity' || typeof p.iid !== 'string' || !p.iid) return null
  return p as unknown as IdentityClaims
}

// ── Revocation ──────────────────────────────────────────────────────────────────────────────

/**
 * A token naming a person (`iid`) is live only while the person is active and its `tv` is their
 * current `tokenVersion`: a password change or reset bumps it and every older session ends.
 *
 * Cached per process for a minute, because the auth derive runs on every request. A change made
 * in this process is seen at once (`forgetIdentity`); another pod sees it within a minute. A token
 * without `iid` (a membership the migration has not linked, or one issued before Phase 2) is not
 * checked here: it expires on its own within the session TTL.
 */
const REVOCATION_TTL_MS = 60_000
const MAX_CACHED = 10_000
const live = new Map<string, { at: number; isActive: boolean; tokenVersion: number }>()

export async function identityStillValid(iid: string, tv: unknown): Promise<boolean> {
  let entry = live.get(iid)
  if (!entry || Date.now() - entry.at > REVOCATION_TTL_MS) {
    const doc = await Identity.findById(iid, { isActive: 1, tokenVersion: 1 }).lean().exec().catch(() => null)
    if (live.size >= MAX_CACHED) live.clear()
    entry = { at: Date.now(), isActive: !!doc?.isActive, tokenVersion: doc ? (doc.tokenVersion ?? 0) : -1 }
    live.set(iid, entry)
  }
  return entry.isActive && entry.tokenVersion === (typeof tv === 'number' ? tv : 0)
}

/** Drop the cached state of a person whose password or activity just changed in this process. */
export function forgetIdentity(iid: unknown): void {
  live.delete(String(iid))
}

/**
 * The session a verified token stands for, if it is still live: a token naming a person must
 * match their current state (`identityStillValid`). Called by all eight auth plugins right after
 * `asSessionUser`, so the rule cannot drift between them.
 */
export async function liveSessionUser<T extends object>(user: T | null): Promise<T | null> {
  const claims = user as { iid?: unknown; tv?: unknown } | null
  if (claims && typeof claims.iid === 'string' && !(await identityStillValid(claims.iid, claims.tv))) return null
  return user
}
