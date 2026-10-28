import { createHash, randomBytes } from 'node:crypto'
import { config } from 'config'
import { Identity, IdpCode, Org, ServerNode, User } from 'db/models'
import { logger } from '../../logger/logger.js'
import { ephemeralSigningKey, signingKeyFrom, type SigningKey } from '../crypto/ed-jws.js'
import { BUILT_IN_IDP_KEYS, allowIdpKeyInDevelopment, signAssertion } from './idp-token.js'
import { activeLabelsOf } from '../address/org-address.service.js'

/**
 * FR-20.39 (plan step P2-4) — "Sign in with LGR", global's side: an authorization-code flow with
 * PKCE, in which lgrai.app is the identity provider and a registered master the client.
 *
 * 1. The master's sign-in page sends the browser to lgrai.app's `/idp/authorize` with its node id,
 *    a redirect, a state and an S256 challenge.
 * 2. lgrai.app's page, with the person's own lgrai.app session (read from the tab, never a cookie:
 *    FR-20.72), shows which server and which org, and on Continue gets a 60-second single-use code
 *    (`authorize`), redirecting back.
 * 3. The master redeems it with its node token and the browser's verifier (`redeem`) for an
 *    assertion signed by global's identity key, which it verifies with the key built into its
 *    package, maps to the membership, and turns into its own session.
 *
 * ⚠ A global password never reaches a master, and a code is worth nothing without both the
 * server's node key and the browser's verifier.
 */

export class IdpError extends Error {
  constructor(public statusCode: number, public code: string, message: string) {
    super(message)
  }
}

const CODE_TTL_MS = 60_000
const sha = (s: string) => createHash('sha256').update(s).digest('base64url')

type IssuerKey = { ok: true; key: SigningKey } | { ok: false; reason: string }
let issuer: IssuerKey | undefined

/** The key global signs assertions with: `IDP_SIGNING_KEY`, a built-in one in production. */
export function idpIssuerKey(): IssuerKey {
  if (issuer) return issuer
  const production = process.env.NODE_ENV === 'production'
  const raw = config.idp.signingKey
  if (!raw) {
    if (production) issuer = { ok: false, reason: 'IDP_SIGNING_KEY is not set' }
    else {
      const key = ephemeralSigningKey()
      allowIdpKeyInDevelopment(key)
      issuer = { ok: true, key }
    }
  } else {
    try {
      const key = signingKeyFrom(raw)
      if (production && !BUILT_IN_IDP_KEYS.has(key.kid)) {
        issuer = { ok: false, reason: `IDP_SIGNING_KEY (kid ${key.kid}) is not one of the keys built into this release` }
      } else {
        if (!production) allowIdpKeyInDevelopment(key)
        issuer = { ok: true, key }
      }
    } catch (e: any) {
      issuer = { ok: false, reason: `IDP_SIGNING_KEY is not a base64 PKCS#8 Ed25519 key (${e?.message ?? e})` }
    }
  }
  if (!issuer.ok) logger.error(`Sign in with LGR is off: ${issuer.reason}`)
  return issuer
}

/** Tests: read the key again. */
export function resetIdpIssuerKey(): void {
  issuer = undefined
}

/**
 * Where a server may send the person back: the desktop's `lgr://login`; a loopback address of the
 * machine (the console, the desktop's own proxy, RFC 8252's rule for native clients); or the address
 * of one of its orgs under lgrai.app (FR-20.78, plan step P3-4). Always to `/auth/idp/callback`.
 */
export function redirectAllowed(redirectUri: string, orgSlugs: readonly string[]): boolean {
  if (redirectUri === 'lgr://login') return true
  let u: URL
  try {
    u = new URL(redirectUri)
  } catch {
    return false
  }
  if (u.username || u.password || u.search || u.hash || u.pathname !== '/auth/idp/callback') return false
  if (['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)) return u.protocol === 'http:' || u.protocol === 'https:'
  const apex = config.idp.addressApex
  const label = u.hostname.endsWith(`.${apex}`) ? u.hostname.slice(0, -apex.length - 1) : ''
  return u.protocol === 'https:' && !u.port && /^[a-z0-9-]+$/.test(label) && orgSlugs.includes(label)
}

async function loadNode(clientId: string) {
  const node: any = await ServerNode.findOne({ _id: clientId, status: 'active' }).lean()
  if (!node) throw new IdpError(404, 'unknown_client', 'There is no such server.')
  if (node.cloneAlarm?.at) throw new IdpError(409, 'clone_alarm', 'Another machine is connected as this server: nobody signs in to it until an administrator registers the real one again.')
  return node
}

export interface IdpClientView {
  node: { id: string; name: string }
  /** The person's orgs on that server: where they may sign in. */
  orgs: Array<{ id: string; slug: string; name: string }>
}

/** What the authorize page shows: the server, and the person's orgs on it. */
export async function idpClient(input: { clientId: string; redirectUri: string; identityId: string }): Promise<IdpClientView> {
  const node = await loadNode(input.clientId)
  const orgs: any[] = await Org.find({ _id: { $in: node.orgIds } }).select('name slug').lean()
  // FR-20.72 (P3-4a): back to an org's ADDRESS, as issued: a rename does not move it, and an org
  // without one has nowhere on lgrai.app to be sent back to.
  if (!redirectAllowed(input.redirectUri, await activeLabelsOf(node.orgIds ?? []))) throw new IdpError(400, 'bad_redirect_uri', 'This server cannot be signed in to from there.')
  const members: any[] = await User.find({ identityId: input.identityId, orgId: { $in: node.orgIds }, isActive: true }).select('orgId').lean()
  const mine = new Set(members.map(m => String(m.orgId)))
  return {
    node: { id: String(node._id), name: node.name },
    orgs: orgs.filter(o => mine.has(String(o._id))).map(o => ({ id: String(o._id), slug: o.slug, name: o.name })),
  }
}

/** The person agreed: a 60-second code for this server, this redirect and this browser. */
export async function authorize(input: {
  identityId: string
  amr: readonly string[]
  clientId: string
  orgId: string
  redirectUri: string
  codeChallenge: string
  codeChallengeMethod: string
}, now = new Date()): Promise<{ code: string }> {
  if (input.codeChallengeMethod !== 'S256' || !/^[A-Za-z0-9_-]{43}$/.test(input.codeChallenge)) {
    throw new IdpError(400, 'bad_challenge', 'PKCE with S256 is required.')
  }
  const key = idpIssuerKey()
  if (!key.ok) throw new IdpError(503, 'idp_unavailable', 'Sign in with LGR is not available right now.')
  const client = await idpClient(input)
  if (!client.orgs.some(o => o.id === input.orgId)) throw new IdpError(403, 'not_a_member', 'You are not a member of that organization on this server.')
  const member: any = await User.findOne({ identityId: input.identityId, orgId: input.orgId, isActive: true }).select('_id').lean()
  if (!member) throw new IdpError(403, 'not_a_member', 'You are not a member of that organization on this server.')
  const code = randomBytes(32).toString('base64url')
  await IdpCode.create({
    codeHash: sha(code),
    nodeId: client.node.id,
    orgId: input.orgId,
    identityId: input.identityId,
    userId: member._id,
    redirectUri: input.redirectUri,
    codeChallenge: input.codeChallenge,
    amr: [...new Set(input.amr.length ? input.amr : ['pwd'])].slice(0, 5),
    expiresAt: new Date(now.getTime() + CODE_TTL_MS),
  })
  return { code }
}

const invalidGrant = () => new IdpError(400, 'invalid_grant', 'The code is unknown, used, expired, or not this server\'s.')

/**
 * The server redeems a code: claimed once (a conditional update), then checked against this server,
 * the redirect and the verifier. A mismatch spends the code. The answer is an assertion on the
 * person and the membership as they are NOW.
 */
export async function redeem(node: any, input: { code: string; codeVerifier: string; redirectUri: string }, now = new Date()): Promise<{ assertion: string; expiresAt: Date }> {
  const key = idpIssuerKey()
  if (!key.ok) throw new IdpError(503, 'idp_unavailable', 'Sign in with LGR is not available right now.')
  if (!/^[A-Za-z0-9._~-]{43,128}$/.test(input.codeVerifier ?? '')) throw invalidGrant()
  const row: any = await IdpCode.findOneAndUpdate(
    { codeHash: sha(String(input.code ?? '')), usedAt: { $exists: false }, expiresAt: { $gt: now } },
    { $set: { usedAt: now } },
    { new: false },
  ).lean()
  if (!row) throw invalidGrant()
  if (row.nodeId !== String(node._id) || row.redirectUri !== input.redirectUri || sha(input.codeVerifier) !== row.codeChallenge) {
    logger.warn({ nodeId: String(node._id), codeNode: row.nodeId }, 'A Sign in with LGR code was redeemed with the wrong server, redirect or verifier: spent')
    throw invalidGrant()
  }
  if (node.cloneAlarm?.at) throw new IdpError(409, 'clone_alarm', 'Another machine is connected as this server.')
  if (!(node.orgIds ?? []).some((id: any) => String(id) === String(row.orgId))) throw invalidGrant()
  const [identity, member]: any[] = await Promise.all([
    Identity.findById(row.identityId).select('email tokenVersion isActive').lean(),
    User.findOne({ _id: row.userId, orgId: row.orgId, identityId: row.identityId, isActive: true }).select('_id').lean(),
  ])
  if (!identity?.isActive || !member) throw new IdpError(403, 'not_a_member', 'That person is no longer a member there.')
  const { jws, expiresAt } = signAssertion({
    aud: String(node._id),
    sub: String(row.identityId),
    org: String(row.orgId),
    uid: String(row.userId),
    email: identity.email,
    tv: identity.tokenVersion ?? 0,
    amr: row.amr ?? ['pwd'],
  }, key.key, now.getTime())
  return { assertion: jws, expiresAt }
}
