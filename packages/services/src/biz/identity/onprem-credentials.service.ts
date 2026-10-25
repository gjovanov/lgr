import { config, nodeRole } from 'config'
import { Identity, LocalCredential, NodeState, OnpremCredential, Org, ServerNode, User, type OnpremCredentialKind } from 'db/models'
import { logger } from '../../logger/logger.js'
import { isSealPublicKey, openSealed, sealTo } from '../crypto/node-seal.js'
import { publishSealKey } from '../node/node-seal-key.js'
import { fetchWithTimeout } from '../outbound-fetch.js'
import { hasOwnCredential } from './account.service.js'
import { pinRuleViolation } from './local-credentials.service.js'
import { verifyPassword } from './session.service.js'

/**
 * Local credentials for an org's on-prem server, set on lgrai.app (FR-20.40, plan step P2-4c).
 *
 * A person works on a master with "Sign in with LGR" while the line is up (FR-20.39), and with a
 * local password (or, at a till, operator code + PIN) when it is not. They set those HERE, on their
 * account, before the org moves too (§8). Then:
 * 1. **Global keeps only an argon2id verifier** (`OnpremCredential`, node state), and refuses a local
 *    password equal to the person's lgrai.app one.
 * 2. **The credential feed delivers it sealed** (`GET /api/node/v1/credential-changes`): each value
 *    sealed to that master's seal key, which the master's NODE key vouches for (`node-seal-key.ts`),
 *    so a TLS-inspecting proxy on the way (FR-20.53) reads nothing it could guess a PIN from.
 * 3. **The master opens it** into `local_credentials` (`source: 'lgrai'`), where its PIN sign-in
 *    (P1-5) and its password sign-in (`auth.service.ts#passwordHashFor`) find it.
 *
 * - **Invalidation** (FR-20.40): a credential is live while the person's `tokenVersion` is the one it
 *   was set at, and they are active. A password change or a sign-out everywhere ends it on lgrai.app
 *   and, through the identity feed, on the master (`dropDeadCredentials`).
 * - **One per person and kind on a master** (P1-5's model), so a person with credentials for two orgs
 *   on one master gets the newer. A credential the person set on the master itself wins when newer,
 *   and the feed never removes one.
 */

export class OnpremCredentialError extends Error {
  constructor(readonly statusCode: number, readonly code: string, message: string) {
    super(message)
  }
}

const KINDS: readonly OnpremCredentialKind[] = ['password', 'pin']
export const isOnpremCredentialKind = (v: unknown): v is OnpremCredentialKind => KINDS.includes(v as OnpremCredentialKind)

/** S-09's rule for a password, here too: a local password stands in for the global one. */
export const LOCAL_PASSWORD_MIN = 12

function requireGlobal(): void {
  if (nodeRole() !== 'global') throw new OnpremCredentialError(404, 'not_found', 'Not found.')
}

const OBJECT_ID = /^[0-9a-f]{24}$/

// ── Global: the person's account ────────────────────────────────────────────────────────────

export interface OnpremOrgView {
  orgId: string
  orgName: string
  orgSlug: string
  /** A PIN signs in with an operator code; without one there is nothing for it to prove. */
  operatorCode: boolean
  /** The org's on-prem servers. `ready`: it can receive credentials (its seal key is registered). */
  servers: Array<{ id: string; name: string; ready: boolean }>
  password: { setAt: string; live: boolean } | null
  pin: { setAt: string; live: boolean } | null
}

/** The person's orgs that have an on-prem server, and what they have set for each. */
export async function onpremServersOf(identityId: string): Promise<OnpremOrgView[]> {
  requireGlobal()
  const identity: any = await Identity.findById(identityId, { tokenVersion: 1, isActive: 1 }).lean()
  if (!identity) return []
  const members: any[] = await User.find({ identityId, isActive: true }, { orgId: 1, operatorCode: 1 }).lean()
  const orgIds = members.map(m => m.orgId)
  const nodes: any[] = await ServerNode.find({ orgIds: { $in: orgIds }, status: 'active' }, { name: 1, orgIds: 1, sealKey: 1 }).lean()
  if (!nodes.length) return []
  const [orgs, creds]: [any[], any[]] = await Promise.all([
    Org.find({ _id: { $in: orgIds } }, { name: 1, slug: 1 }).lean(),
    OnpremCredential.find({ identityId, orgId: { $in: orgIds }, removedAt: { $exists: false } }, { orgId: 1, kind: 1, setAt: 1, tvAtSet: 1 }).lean(),
  ])
  const tv = identity.tokenVersion ?? 0
  const view = (orgId: string, kind: OnpremCredentialKind) => {
    const c = creds.find(x => String(x.orgId) === orgId && x.kind === kind)
    return c ? { setAt: new Date(c.setAt).toISOString(), live: identity.isActive !== false && c.tvAtSet === tv } : null
  }
  const out: OnpremOrgView[] = []
  for (const m of members) {
    const orgId = String(m.orgId)
    const servers = nodes.filter(n => (n.orgIds ?? []).some((o: unknown) => String(o) === orgId))
    const org = orgs.find(o => String(o._id) === orgId)
    if (!servers.length || !org) continue
    out.push({
      orgId,
      orgName: org.name,
      orgSlug: org.slug,
      operatorCode: !!m.operatorCode,
      servers: servers.map(n => ({ id: String(n._id), name: n.name, ready: isSealPublicKey(n.sealKey) })),
      password: view(orgId, 'password'),
      pin: view(orgId, 'pin'),
    })
  }
  return out.sort((a, b) => a.orgName.localeCompare(b.orgName))
}

/**
 * Set (or change) the person's local password or PIN for an org's on-prem server.
 *
 * - **Proven by the person's password** when they have one, which must be their own (rule 3: a
 *   password an admin set may be known to that admin, who would then hold the person's way into the
 *   master as well). A provider-only person proves it with a confirmed sign-in, as rule 3 says.
 * - ⚠ **A local password equal to the lgrai.app one is refused** (FR-20.40): a master never holds
 *   the global password, and a person who reused it would have put it there.
 */
export async function setOnpremCredential(input: {
  identityId: string
  orgId: string
  kind: OnpremCredentialKind
  secret: string
  currentPassword?: string
}): Promise<{ setAt: Date }> {
  requireGlobal()
  if (!OBJECT_ID.test(input.orgId)) throw new OnpremCredentialError(404, 'not_a_member', 'You are not a member of that organization.')
  const identity = await Identity.findById(input.identityId).select('+password tokenVersion isActive passwordSetBy oauthProviders').exec()
  if (!identity || identity.isActive === false) throw new OnpremCredentialError(401, 'not_a_person', 'Sign in again.')
  if (identity.password) {
    if (!(await verifyPassword(input.currentPassword ?? '', identity.password))) {
      throw new OnpremCredentialError(403, 'wrong_password', 'That is not your password.')
    }
  }
  if (!hasOwnCredential(identity)) {
    throw new OnpremCredentialError(403, 'own_password_required', 'Choose a password of your own first: the one you have was set for you.')
  }
  const member: any = await User.findOne({ identityId: identity._id, orgId: input.orgId, isActive: true }, { operatorCode: 1 }).lean()
  if (!member) throw new OnpremCredentialError(404, 'not_a_member', 'You are not a member of that organization.')
  if (!(await ServerNode.exists({ orgIds: input.orgId, status: 'active' }))) {
    throw new OnpremCredentialError(409, 'no_server', 'That organization has no on-prem server.')
  }

  if (input.kind === 'password') {
    if (input.secret.length < LOCAL_PASSWORD_MIN) {
      throw new OnpremCredentialError(422, 'password_rule', `A local password has at least ${LOCAL_PASSWORD_MIN} characters.`)
    }
    if (identity.password && (await verifyPassword(input.secret, identity.password))) {
      throw new OnpremCredentialError(422, 'same_as_global', 'Choose a local password different from your lgrai.app password.')
    }
  } else {
    if (!member.operatorCode) {
      throw new OnpremCredentialError(422, 'no_operator_code', 'A PIN signs in with an operator code, and you have none in that organization.')
    }
    const violation = pinRuleViolation(input.secret)
    if (violation) throw new OnpremCredentialError(422, 'pin_rule', violation)
  }

  const verifier = await Bun.password.hash(input.secret, { algorithm: 'argon2id' })
  const setAt = new Date()
  await OnpremCredential.updateOne(
    { identityId: identity._id, orgId: input.orgId, kind: input.kind },
    { $set: { verifier, tvAtSet: identity.tokenVersion ?? 0, setAt }, $unset: { removedAt: 1 } },
    { upsert: true },
  ).exec()
  return { setAt }
}

/** Remove it. The tombstone tells the master, which removes its copy. */
export async function removeOnpremCredential(identityId: string, orgId: string, kind: OnpremCredentialKind): Promise<boolean> {
  requireGlobal()
  if (!OBJECT_ID.test(orgId)) return false
  const r = await OnpremCredential.updateOne(
    { identityId, orgId, kind, removedAt: { $exists: false } },
    { $set: { removedAt: new Date() }, $unset: { verifier: 1 } },
  ).exec()
  return r.modifiedCount > 0
}

// ── The credential feed ─────────────────────────────────────────────────────────────────────

export interface CredentialChange {
  iid: string
  org: string
  kind: OnpremCredentialKind
  /** The `tokenVersion` it was set at: on the master it works only while the person is there. */
  tv: number
  setAt: string
  /** The verifier, sealed to the master's seal key. Null: the master has none (any more). */
  sealed: string | null
}

const CRED_PAGE = 100
const CRED_STATE_ID = 'credential-feed'
const FULL_EVERY_MS = 24 * 60 * 60_000

/** What a sealed value is bound to: this master, and every clear field of its item. */
export const credentialAad = (nodeId: string, c: Omit<CredentialChange, 'sealed'>): string =>
  `onprem-credential|${nodeId}|${c.iid}|${c.org}|${c.kind}|${c.tv}|${c.setAt}`

function parseCursor(cursor: unknown): { at: Date; id: string } | null {
  const [iso, id] = typeof cursor === 'string' ? cursor.split('|') : []
  const at = new Date(iso ?? '')
  return Number.isFinite(at.getTime()) && OBJECT_ID.test(id ?? '') ? { at, id } : null
}

/**
 * Global: the credentials of the node's orgs changed after `after`, oldest first, each live one
 * sealed to the node's seal key. A dead one (removed, superseded by a password change, a person or a
 * membership no longer active) travels as `sealed: null`, so the master removes its copy.
 */
export async function credentialChangesFor(node: any, after: unknown, limit = CRED_PAGE): Promise<{ items: CredentialChange[]; cursor: string | null; more: boolean; sealKey: string }> {
  requireGlobal()
  // A cloned disk holds this server's seal key too: nothing more is delivered until an administrator
  // registers the real one again (FR-20.51).
  if (node.cloneAlarm?.at) {
    throw new OnpremCredentialError(409, 'clone_alarm', 'Another machine is connected as this server: no credentials are delivered until an administrator registers the real one again.')
  }
  if (!isSealPublicKey(node.sealKey)) {
    throw new OnpremCredentialError(409, 'no_seal_key', 'This server has not registered its seal key yet.')
  }
  const n = Math.min(Math.max(1, Number(limit) || CRED_PAGE), CRED_PAGE)
  const from = parseCursor(after)
  const filter: Record<string, unknown> = { orgId: { $in: node.orgIds ?? [] } }
  if (from) filter.$or = [{ updatedAt: { $gt: from.at } }, { updatedAt: from.at, _id: { $gt: from.id } }]
  const rows: any[] = await OnpremCredential.find(filter).select('+verifier').sort({ updatedAt: 1, _id: 1 }).limit(n + 1).lean()
  const page = rows.slice(0, n)
  const iids = [...new Set(page.map(r => String(r.identityId)))]
  const [people, members]: [any[], any[]] = await Promise.all([
    Identity.find({ _id: { $in: iids } }, { tokenVersion: 1, isActive: 1 }).lean(),
    User.find({ identityId: { $in: iids }, orgId: { $in: node.orgIds ?? [] }, isActive: true }, { identityId: 1, orgId: 1 }).lean(),
  ])
  const person = new Map(people.map(p => [String(p._id), p]))
  const member = new Set(members.map(m => `${m.identityId}|${m.orgId}`))
  const items = page.map((r): CredentialChange => {
    const clear = { iid: String(r.identityId), org: String(r.orgId), kind: r.kind as OnpremCredentialKind, tv: r.tvAtSet ?? 0, setAt: new Date(r.setAt).toISOString() }
    const p = person.get(clear.iid)
    const live = !r.removedAt && typeof r.verifier === 'string' && !!p && p.isActive !== false
      && (p.tokenVersion ?? 0) === clear.tv && member.has(`${clear.iid}|${clear.org}`)
    return { ...clear, sealed: live ? sealTo(node.sealKey, JSON.stringify({ verifier: r.verifier }), credentialAad(String(node._id), clear)) : null }
  })
  const last = page[page.length - 1]
  return {
    items,
    cursor: last ? `${new Date(last.updatedAt).toISOString()}|${last._id}` : from && typeof after === 'string' ? after : null,
    more: rows.length > n,
    sealKey: node.sealKey,
  }
}

const shapeOk = (it: any): it is CredentialChange =>
  !!it && OBJECT_ID.test(it.iid) && OBJECT_ID.test(it.org) && isOnpremCredentialKind(it.kind)
  && Number.isInteger(it.tv) && it.tv >= 0 && typeof it.setAt === 'string' && Number.isFinite(new Date(it.setAt).getTime())
  && (it.sealed === null || typeof it.sealed === 'string')

/**
 * The master: apply a page. A value that does not open is not applied, and the caller does not move
 * past it: lgrai.app sealed it to a key this master no longer has, and seals to the new one once the
 * supervisor has signed it in (within ten minutes).
 */
export async function applyCredentialChanges(
  items: readonly unknown[],
  key: { privateKey: string },
  nodeId: string,
): Promise<{ applied: number; unopened: number; live: string[] }> {
  let applied = 0
  let unopened = 0
  const live: string[] = []
  for (const raw of items) {
    if (!shapeOk(raw)) continue
    const it = raw
    // Only the people this master holds: it never creates anyone.
    const person: any = await Identity.findById(it.iid, { tokenVersion: 1, isActive: 1 }).lean()
    if (!person) continue
    // Set before a password change this master already knows of: dead on arrival, so it is not kept.
    const stale = person.isActive === false || it.tv < (person.tokenVersion ?? 0)
    if (it.sealed === null || stale) {
      const r = await LocalCredential.deleteOne({ identityId: it.iid, kind: it.kind, source: 'lgrai', forOrgId: it.org }).exec()
      applied += r.deletedCount
      continue
    }
    let verifier: unknown
    try {
      verifier = JSON.parse(openSealed(key.privateKey, it.sealed, credentialAad(nodeId, it)) ?? 'null')?.verifier
    } catch {
      verifier = undefined
    }
    if (typeof verifier !== 'string' || !verifier.startsWith('$argon2')) {
      unopened++
      continue
    }
    live.push(`${it.iid}|${it.kind}|${it.org}`)
    const setAt = new Date(it.setAt)
    const held: any = await LocalCredential.findOne({ identityId: it.iid, kind: it.kind }, { setAt: 1, source: 1, forOrgId: 1, tvAtSet: 1 }).lean()
    // Newest wins, and what is already here is left alone: the daily full pass must not reset a
    // failure streak by writing the same credential again.
    if (held && new Date(held.setAt).getTime() > setAt.getTime()) continue
    if (held?.source === 'lgrai' && String(held.forOrgId) === it.org && new Date(held.setAt).getTime() === setAt.getTime() && held.tvAtSet === it.tv) continue
    await LocalCredential.updateOne(
      { identityId: it.iid, kind: it.kind },
      { $set: { verifier, tvAtSet: it.tv, setAt, source: 'lgrai', forOrgId: it.org, failures: 0 }, $unset: { nextAttemptAt: 1 } },
      { upsert: true },
    ).exec()
    applied++
  }
  return { applied, unopened, live }
}

/**
 * The master, after the identity feed has made a person's `tokenVersion` or active state current:
 * their credentials set before it are dead, here as on lgrai.app (FR-20.40), so they go.
 */
export async function dropDeadCredentials(identityId: string, tv: number, active: boolean): Promise<number> {
  const filter = active ? { identityId, tvAtSet: { $lt: tv } } : { identityId }
  return (await LocalCredential.deleteMany(filter).exec()).deletedCount
}

/**
 * The master's credential pass, run by the identity feed's tick after its own: what changed since
 * the cursor, and once a day everything, after which a delivered credential lgrai.app no longer has
 * goes (a tombstone it missed).
 */
export async function credentialFeedPass(
  token: { server: string; token: string },
  now: Date,
  fetchImpl: typeof fetch = fetch,
): Promise<number> {
  const nodeId = config.node.id
  const key = await publishSealKey()
  if (!key || !nodeId) return 0
  const state: any = (await NodeState.findById(CRED_STATE_ID).lean())?.value ?? {}
  // A new seal key: everything sealed before was sealed to the old one, so start from the beginning.
  const full = !state.fullAt || state.sealKey !== key.publicKey || now.getTime() - new Date(state.fullAt).getTime() > FULL_EVERY_MS
  let cursor: string | undefined = full ? undefined : state.cursor
  let applied = 0
  let complete = false
  const live = new Set<string>()
  for (let page = 0; page < 50; page++) {
    const url = new URL('/api/node/v1/credential-changes', token.server)
    if (cursor) url.searchParams.set('after', cursor)
    url.searchParams.set('limit', String(CRED_PAGE))
    const res = await fetchWithTimeout(url, { headers: { authorization: `Bearer ${token.token}` } }, { timeoutMs: 20_000, fetchImpl })
    const body: any = await res.json().catch(() => ({}))
    if (res.status === 409 && body?.code === 'no_seal_key') return applied // the supervisor has not signed it in yet
    if (!res.ok) {
      logger.warn({ status: res.status }, 'the credential feed was refused this round')
      return applied
    }
    if (body?.sealKey !== key.publicKey) {
      logger.info('lgrai.app does not have this master\'s seal key yet; the credential feed waits')
      return applied
    }
    const r = await applyCredentialChanges(Array.isArray(body?.items) ? body.items : [], key, nodeId)
    applied += r.applied
    for (const k of r.live) live.add(k)
    if (r.unopened) {
      logger.warn({ unopened: r.unopened }, 'credentials from lgrai.app did not open; the credential feed waits')
      return applied
    }
    cursor = typeof body?.cursor === 'string' ? body.cursor : cursor
    complete = !body?.more
    await NodeState.updateOne(
      { _id: CRED_STATE_ID },
      { $set: { value: { cursor, sealKey: key.publicKey, fullAt: full && complete ? now : state.sealKey === key.publicKey ? state.fullAt ?? null : null } } },
      { upsert: true },
    )
    if (complete) break
  }
  if (full && complete) {
    const delivered: any[] = await LocalCredential.find({ source: 'lgrai' }, { identityId: 1, kind: 1, forOrgId: 1 }).lean()
    const gone = delivered.filter(c => !live.has(`${c.identityId}|${c.kind}|${c.forOrgId}`)).map(c => c._id)
    if (gone.length) {
      applied += (await LocalCredential.deleteMany({ _id: { $in: gone } }).exec()).deletedCount
    }
  }
  if (applied) logger.info({ applied }, 'Applied local credentials from lgrai.app')
  return applied
}
