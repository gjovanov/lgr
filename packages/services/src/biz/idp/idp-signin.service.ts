import { config, nodeRole } from 'config'
import { Identity, User, type IIdentity, type IUser } from 'db/models'
import { isHomeHere } from 'db/home/home'
import { logger } from '../../logger/logger.js'
import { fetchWithTimeout } from '../outbound-fetch.js'
import { readNodeToken } from '../relay/outbox-worker.js'
import { acceptedIdpKeys, verifyAssertion } from './idp-token.js'

/**
 * FR-20.39 (plan step P2-4) — "Sign in with LGR", a master's side: redeem the code lgrai.app sent
 * the browser back with, verify the assertion with the identity keys built into this package, and
 * find the membership it names. The session is then the master's own (`enterOrg`).
 *
 * The code is redeemed with the node token the supervisor keeps (`state/node-token.json`), through
 * the egress proxy. A master that is not linked, or cannot reach lgrai.app, says so: its people then
 * sign in with their local credentials (FR-20.40).
 */

export class IdpSignInError extends Error {
  constructor(public statusCode: number, public code: string, message: string) {
    super(message)
  }
}

/** Whether this master offers Sign in with LGR, and where it sends the browser. */
export function idpConfig(): { enabled: boolean; server?: string; clientId?: string } {
  if (nodeRole() !== 'master' || !config.node.id) return { enabled: false }
  const token = readNodeToken()
  return token ? { enabled: true, server: token.server, clientId: config.node.id } : { enabled: false }
}

export async function signInWithLgr(
  input: { code: string; codeVerifier: string; redirectUri: string },
  fetchImpl: typeof fetch = fetch,
): Promise<{ member: IUser; identity: IIdentity }> {
  if (nodeRole() !== 'master' || !config.node.id) throw new IdpSignInError(404, 'not_found', 'Not found.')
  const token = readNodeToken()
  if (!token) throw new IdpSignInError(503, 'not_linked', 'This server cannot reach lgrai.app right now. Sign in with your local password.')
  let res: Response
  try {
    res = await fetchWithTimeout(`${token.server}/api/node/v1/idp/redeem`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token.token}`, 'content-type': 'application/json' },
      body: JSON.stringify(input),
    }, { timeoutMs: 20_000, fetchImpl })
  } catch (e: any) {
    throw new IdpSignInError(503, 'global_unreachable', `lgrai.app could not be reached (${e?.message ?? e}). Sign in with your local password.`)
  }
  const body: any = await res.json().catch(() => ({}))
  if (!res.ok) {
    const refused = res.status === 400 || res.status === 403
    throw new IdpSignInError(refused ? 401 : 502, String(body?.code ?? 'refused'), String(body?.message ?? 'lgrai.app refused the sign-in.'))
  }
  const v = verifyAssertion(body?.assertion, config.node.id, acceptedIdpKeys())
  if (!v.ok) {
    logger.error({ reason: v.reason }, 'A Sign in with LGR assertion did not verify against the built-in identity keys')
    throw new IdpSignInError(502, 'bad_assertion', 'lgrai.app\'s answer did not verify. Sign in with your local password, and tell an administrator.')
  }
  const c = v.claims
  // A session here is for an org this server writes: anything else would fail on its first write.
  if (!(await isHomeHere(c.org))) throw new IdpSignInError(409, 'org_home_elsewhere', 'That organization is not on this server. Sign in on lgrai.app.')
  const [member, identity] = await Promise.all([
    User.findOne({ _id: c.uid, orgId: c.org, identityId: c.sub, isActive: true }),
    Identity.findById(c.sub),
  ])
  if (!member || !identity?.isActive) throw new IdpSignInError(403, 'not_a_member_here', 'You are not a member of that organization on this server.')
  // Global's tokenVersion is the truth about revocation: this copy catches up to it. The identity
  // feed (plan step P2-5) keeps it current between sign-ins.
  if ((identity.tokenVersion ?? 0) < c.tv) {
    identity.tokenVersion = c.tv
    await identity.save()
  }
  return { member, identity }
}
