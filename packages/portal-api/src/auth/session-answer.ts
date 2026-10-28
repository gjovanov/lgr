import { Identity, Org, type IIdentity, type IUser } from 'db/models'
import { sessionFor, type SessionUser } from 'services/biz/auth.service'
import { membershipsOf, type Membership } from 'services/biz/identity/session.service'
import { createAuditEntry } from 'services/biz/audit-log.service'
import { setSessionCookie, SESSION_TTL_SECONDS } from './session-cookie.js'

/**
 * What the sign-in endpoints answer (multi-org sign-in), shared by the auth and invite
 * controllers so that "you are now in org X" means one thing wherever it is said.
 */

/** What the org menu lists: the person's orgs, with their role in each and the current one marked. */
export function orgList(memberships: Membership[], currentOrgId?: string) {
  return memberships.map(m => ({
    orgId: m.org.id,
    name: m.org.name,
    slug: m.org.slug,
    role: m.user.role,
    current: m.org.id === currentOrgId,
  }))
}

export function personSummary(identity: Pick<IIdentity, '_id' | 'email' | 'firstName' | 'lastName'>) {
  return { id: String(identity._id), email: identity.email, firstName: identity.firstName, lastName: identity.lastName }
}

/** A non-empty `Authorization: Bearer …` header (rule 7: some actions refuse a cookie alone). */
export const bearerPresent = (authorization?: string) => /^bearer\s+\S/i.test((authorization ?? '').trim())

/** Rule 7's refusal: switching, joining, founding and password changes act on THIS tab's token. */
export const BEARER_REQUIRED = { message: 'This needs the token this tab holds.', code: 'bearer_required' }

/** A session for a membership the migration has not linked yet: there is no person to act as. */
export const NOT_A_PERSON = {
  message: 'This account is not linked to a person yet; sign in to each organization separately.',
  code: 'not_a_person',
}

/** The signed-in person behind a request: an org session's, or an identity-only token's. */
export const callerOf = (user: unknown, person: unknown) => (user ?? person) as { iid?: string; exp?: number } | null

export type SignInMethod = 'password' | 'switch' | 'oauth' | 'join' | 'new_org' | 'pin' | 'lgr'

/** Every way into an org is a sign-in to it (Н-18, Appendix 29), with how it happened. */
export function auditSignIn(user: SessionUser, method: SignInMethod) {
  createAuditEntry({
    orgId: user.orgId,
    userId: user.id,
    operatorCode: user.operatorCode,
    action: 'login',
    module: 'auth',
    entityType: 'user',
    entityId: user.id,
    entityName: `${user.firstName} ${user.lastName}`,
    changes: [{ field: 'method', oldValue: null, newValue: method }],
  })
}

/**
 * Enter one org as the person: an ordinary org session for `member`, which the tenant guard and
 * every permission check treat like a sign-in's. It ends when the token it came from does (`exp`
 * is carried over, never extended), sets the cookie, records the sign-in, and makes this org where
 * the person lands next time.
 */
export async function enterOrg(
  ctx: { jwt: { sign: (payload: Record<string, unknown>) => Promise<string> }; cookie: Record<string, any> },
  member: IUser,
  identity: Pick<IIdentity, '_id' | 'tokenVersion'>,
  exp: number | undefined,
  method: SignInMethod,
) {
  const org = await Org.findById(member.orgId, { name: 1, slug: 1 }).lean().exec()
  const claims = await sessionFor(member, identity)
  const now = Math.floor(Date.now() / 1000)
  const until = exp ?? now + SESSION_TTL_SECONDS
  const token = await ctx.jwt.sign({ ...claims, exp: until })
  setSessionCookie(ctx.cookie, token, Math.max(0, until - now))

  member.lastLoginAt = new Date()
  await member.save()
  await Identity.updateOne({ _id: identity._id }, { $set: { lastOrgId: member.orgId } }).exec()
  auditSignIn(claims, method)

  return {
    user: claims,
    token,
    org: { id: String(member.orgId), name: org?.name ?? '', slug: org?.slug ?? '' },
    orgs: orgList(await membershipsOf(identity._id), claims.orgId),
    needsOrgChoice: false,
  }
}
