import { createHash, randomBytes } from 'crypto'
import { config } from 'config'
import { User, Org, OAuthHandoff, OAuthPendingRegistration, Desktop, Identity, type IUser, type IOrg } from 'db/models'
import { DEFAULT_ROLE_PERMISSIONS, type Role } from 'config/constants'
import {
  type LoginResult,
  type SessionUser,
  type UserTokenized,
  defaultOrgSettings,
  landInOrg,
  provisionNewOrg,
  sessionFor,
} from './auth.service.js'
import {
  asIdentityClaims,
  chooseLanding,
  identityStillValid,
  membershipsOf,
  type IdentityClaims,
} from './identity/session.service.js'
import { allocateOperatorCode } from './sequence.service.js'
import {
  IdentityError,
  createIdentity,
  discardIdentity,
  emailInUse,
  linkProviderToIdentity,
  normalizeEmail,
  resolveOAuthJoin,
  type OAuthJoin,
} from './identity/identity.service.js'
import { logger } from '../logger/logger.js'
import { inviteDao } from '../dao/invite.dao.js'
import { fetchWithTimeout } from './outbound-fetch.js'

/** FR-20.53: an OAuth provider gets 15 s; a sign-in must not hang on one. */
const providerFetch = (url: string, init?: RequestInit) => fetchWithTimeout(url, init, { timeoutMs: 15_000 })

export interface OAuthUserInfo {
  provider: string
  providerId: string
  email: string
  name: string
  avatarUrl?: string
  /**
   * Whether the PROVIDER vouched that this account controls `email` (S-20). It is the gate for
   * linking an OAuth sign-in to an existing account by email: an address a provider did not verify
   * is forgeable, and trusting one is the published "nOAuth" account takeover. Each `userInfoFetcher`
   * sets it from the provider's own signal — Google `verified_email`, LinkedIn `email_verified`,
   * GitHub's `/user/emails` list — and `false` for providers that give none (Microsoft, Facebook).
   */
  emailVerified: boolean
}

interface TokenResponse {
  access_token: string
}

const PROVIDERS: Record<
  string,
  {
    authUrl: (clientId: string, redirectUri: string, state: string) => string
    tokenUrl: string
    tokenParams: (clientId: string, clientSecret: string, code: string, redirectUri: string) => Record<string, string>
    tokenMethod: 'POST' | 'GET'
    userInfoFetcher: (accessToken: string) => Promise<OAuthUserInfo>
  }
> = {
  google: {
    authUrl: (clientId, redirectUri, state) =>
      `https://accounts.google.com/o/oauth2/v2/auth?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=email+profile&state=${encodeURIComponent(state)}&access_type=offline`,
    tokenUrl: 'https://oauth2.googleapis.com/token',
    tokenParams: (clientId, clientSecret, code, redirectUri) => ({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    }),
    tokenMethod: 'POST',
    userInfoFetcher: async (accessToken) => {
      const resp = await providerFetch('https://www.googleapis.com/userinfo/v2/me', {
        headers: { Authorization: `Bearer ${accessToken}` },
      })
      const data = await resp.json() as any
      return {
        provider: 'google',
        providerId: data.id,
        email: data.email || '',
        name: data.name || `${data.given_name || ''} ${data.family_name || ''}`.trim(),
        avatarUrl: data.picture,
        // Google tells us whether it verified the address; S-20 trusts the link only when it did.
        emailVerified: data.verified_email === true,
      }
    },
  },
  facebook: {
    authUrl: (clientId, redirectUri, state) =>
      `https://www.facebook.com/v18.0/dialog/oauth?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=email&state=${encodeURIComponent(state)}`,
    tokenUrl: 'https://graph.facebook.com/v18.0/oauth/access_token',
    tokenParams: (clientId, clientSecret, code, redirectUri) => ({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
    }),
    tokenMethod: 'GET',
    userInfoFetcher: async (accessToken) => {
      const resp = await providerFetch(
        `https://graph.facebook.com/v18.0/me?fields=email,name,picture.type(large)&access_token=${accessToken}`,
      )
      const data = await resp.json() as any
      return {
        provider: 'facebook',
        providerId: data.id,
        email: data.email || '',
        name: data.name || '',
        avatarUrl: data.picture?.data?.url,
        // Facebook sends no verification signal, so an email from it may never link an existing
        // account (S-20), nor found a new person (a sign-up, or joining by invite as someone new):
        // that would put an address nobody proved on an account. An already-linked identity works.
        emailVerified: false,
      }
    },
  },
  github: {
    authUrl: (clientId, redirectUri, state) =>
      `https://github.com/login/oauth/authorize?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=user+user:email&state=${encodeURIComponent(state)}`,
    tokenUrl: 'https://github.com/login/oauth/access_token',
    tokenParams: (clientId, clientSecret, code, redirectUri) => ({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
    }),
    tokenMethod: 'POST',
    userInfoFetcher: async (accessToken) => {
      const resp = await providerFetch('https://api.github.com/user', {
        headers: { Authorization: `Bearer ${accessToken}`, 'User-Agent': 'lgr-app' },
      })
      const data = await resp.json() as any

      // ⚠ S-20 — `/user` returns an email but no verification flag, so the chosen address is
      // confirmed against `/user/emails`, which does carry `verified`. This is the SAME list the
      // fallback already consulted; the change is that the public `data.email` path is now checked
      // against it too, instead of being trusted blind. With no list (missing scope, API error),
      // nothing is treated as verified — fail closed.
      let emails: any[] = []
      try {
        const emailResp = await providerFetch('https://api.github.com/user/emails', {
          headers: { Authorization: `Bearer ${accessToken}`, 'User-Agent': 'lgr-app' },
        })
        const body = await emailResp.json()
        if (Array.isArray(body)) emails = body
      } catch {
        // leave emails empty — nothing can be verified against a list we do not have
      }
      const isVerified = (addr: string) =>
        !!addr && emails.some((e: any) => e?.verified && String(e.email).toLowerCase() === addr.toLowerCase())

      let email: string = data.email || ''
      if (!email) {
        // No public email: fall back to the address GitHub itself marks primary AND verified.
        const primary = emails.find((e: any) => e?.primary && e?.verified)
        email = primary?.email || ''
      }

      return {
        provider: 'github',
        // Not `String(data.id)`: an error body has no id, and that would be the string "undefined".
        providerId: data.id == null ? '' : String(data.id),
        email,
        name: data.login,
        avatarUrl: data.avatar_url,
        emailVerified: isVerified(email),
      }
    },
  },
  linkedin: {
    authUrl: (clientId, redirectUri, state) =>
      `https://www.linkedin.com/oauth/v2/authorization?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=openid+profile+email&state=${encodeURIComponent(state)}`,
    tokenUrl: 'https://www.linkedin.com/oauth/v2/accessToken',
    tokenParams: (clientId, clientSecret, code, redirectUri) => ({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    }),
    tokenMethod: 'POST',
    userInfoFetcher: async (accessToken) => {
      const resp = await providerFetch('https://api.linkedin.com/v2/userinfo', {
        headers: { Authorization: `Bearer ${accessToken}` },
      })
      const data = await resp.json() as any
      return {
        provider: 'linkedin',
        providerId: data.sub || '',
        email: data.email || '',
        name: data.name || `${data.given_name || ''} ${data.family_name || ''}`.trim(),
        avatarUrl: data.picture,
        // LinkedIn's OIDC userinfo carries the standard `email_verified` claim; S-20 links only on it.
        emailVerified: data.email_verified === true,
      }
    },
  },
  microsoft: {
    authUrl: (clientId, redirectUri, state) =>
      `https://login.microsoftonline.com/common/oauth2/v2.0/authorize?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=openid+profile+email+User.Read&state=${encodeURIComponent(state)}`,
    tokenUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    tokenParams: (clientId, clientSecret, code, redirectUri) => ({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    }),
    tokenMethod: 'POST',
    userInfoFetcher: async (accessToken) => {
      const resp = await providerFetch('https://graph.microsoft.com/v1.0/me', {
        headers: { Authorization: `Bearer ${accessToken}` },
      })
      const data = await resp.json() as any
      return {
        provider: 'microsoft',
        providerId: data.id,
        email: data.mail || data.userPrincipalName || '',
        name: data.displayName || data.givenName || '',
        avatarUrl: undefined,
        // ⚠ S-20 — ALWAYS false. Graph `mail` is set by the admin of any Entra tenant and verified
        // by nobody, and the UPN is no proof of the mailbox either. Production's Microsoft app is
        // multi-tenant (/common), so trusting `mail` here is the exact nOAuth takeover. A Microsoft
        // sign-in may create a new org or use an already-linked identity, but never link by email.
        emailVerified: false,
      }
    },
  },
}

const ENV_MAP: Record<string, { id: string; secret: string }> = {
  google: { id: 'GOOGLE_OAUTH_CLIENT_ID', secret: 'GOOGLE_OAUTH_CLIENT_SECRET' },
  facebook: { id: 'FACEBOOK_CLIENT_ID', secret: 'FACEBOOK_CLIENT_SECRET' },
  github: { id: 'GITHUB_CLIENT_ID', secret: 'GITHUB_CLIENT_SECRET' },
  linkedin: { id: 'LINKEDIN_CLIENT_ID', secret: 'LINKEDIN_CLIENT_SECRET' },
  microsoft: { id: 'MICROSOFT_CLIENT_ID', secret: 'MICROSOFT_CLIENT_SECRET' },
}

function getProviderConfig(provider: string) {
  const p = (config.oauth as any)?.[provider]
  const envKeys = ENV_MAP[provider]
  const clientId = p?.clientId || (envKeys ? process.env[envKeys.id] : '') || ''
  const clientSecret = p?.clientSecret || (envKeys ? process.env[envKeys.secret] : '') || ''
  if (!clientId) throw new Error(`OAuth provider "${provider}" is not configured`)
  return { clientId, clientSecret }
}

function callbackUrl(provider: string): string {
  return `${config.oauth.baseUrl}/api/oauth/callback/${provider}`
}

/**
 * Start an OAuth flow.
 *
 * ⚠ `nonce` is supplied by the CALLER, and that is the whole of the CSRF fix. This function
 * used to mint one itself (`crypto.randomUUID()`) and drop it into the state — where nothing
 * ever looked at it again. A nonce the server does not remember is decoration: `parseState`
 * base64-decoded whatever came back from the provider and trusted it, so `state` carried no
 * evidence about WHO started the flow and the callback would complete for anybody.
 *
 * The controller now generates the nonce, puts it in an httpOnly cookie on THIS response, and
 * requires the callback's state to match that cookie. Passing it in is what lets one value be
 * in both places.
 */
/**
 * The providers this deployment has client credentials for: what the sign-in page offers. Names
 * only; nothing about the credentials themselves leaves the server.
 */
export function configuredProviders(): string[] {
  return Object.keys(PROVIDERS).filter(provider => {
    try {
      getProviderConfig(provider)
      return true
    } catch {
      return false
    }
  })
}

export function buildAuthUrl(
  provider: string,
  orgSlug: string | undefined,
  mode: string,
  nonce: string,
  inviteCode?: string,
  /** FR-14.14 — set when a desktop shell started this flow, with its PKCE challenge. */
  desktop?: { desktopId: string; codeChallenge: string },
  /** Multi-org: the org this browser was last in. Honoured only if it is one of the person's. */
  prefer?: string,
): string {
  const providerDef = PROVIDERS[provider]
  if (!providerDef) throw new Error(`Unknown OAuth provider: ${provider}`)
  if (!nonce) throw new Error('buildAuthUrl requires a nonce')
  const { clientId } = getProviderConfig(provider)
  // ⚠ These ride in `state`, not in the provider's query: the provider echoes `state` back
  // verbatim, which is how the callback learns this was a desktop flow without a second
  // server-side record to look up.
  const state = JSON.stringify({
    orgSlug,
    mode,
    nonce,
    inviteCode,
    desktopId: desktop?.desktopId,
    codeChallenge: desktop?.codeChallenge,
    prefer,
  })
  const stateEncoded = Buffer.from(state).toString('base64url')
  return providerDef.authUrl(clientId, callbackUrl(provider), stateEncoded)
}

export async function exchangeCodeForToken(provider: string, code: string): Promise<string> {
  const providerDef = PROVIDERS[provider]
  if (!providerDef) throw new Error(`Unknown OAuth provider: ${provider}`)
  const { clientId, clientSecret } = getProviderConfig(provider)
  const params = providerDef.tokenParams(clientId, clientSecret, code, callbackUrl(provider))

  let resp: Response
  if (providerDef.tokenMethod === 'GET') {
    const qs = new URLSearchParams(params).toString()
    resp = await providerFetch(`${providerDef.tokenUrl}?${qs}`, {
      headers: { Accept: 'application/json' },
    })
  } else {
    resp = await providerFetch(providerDef.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams(params).toString(),
    })
  }

  const data = await resp.json() as TokenResponse
  if (!data.access_token) throw new Error(`Failed to exchange code for token: ${JSON.stringify(data)}`)
  return data.access_token
}

export async function fetchUserInfo(provider: string, accessToken: string): Promise<OAuthUserInfo> {
  const providerDef = PROVIDERS[provider]
  if (!providerDef) throw new Error(`Unknown OAuth provider: ${provider}`)
  const info = await providerDef.userInfoFetcher(accessToken)
  // ⚠ S-20 — the account id is what a linked identity is FOUND by: `getOrCreateUser`,
  // `signInWithOAuth` and `resolveOAuthJoin` all `$elemMatch` on `{ provider, providerId }`. A
  // userinfo ERROR body carries no id, and an `undefined` in that filter is harmless only because
  // the driver sends it as `null`, which matches no stored link. With `ignoreUndefined` set the
  // key is DROPPED instead, and the filter becomes "any account linked to this provider"
  // (measured 2026-10-10). An answer that names no account is no sign-in at all.
  if (info.providerId === undefined || info.providerId === null || String(info.providerId).trim() === '') {
    throw new Error(`The ${provider} sign-in did not identify an account`)
  }
  return info
}

/**
 * Sign in an OAuth identity against an EXISTING organisation.
 *
 * ⚠ This function used to create a `member` account in whatever org the caller named, for
 * anyone who could authenticate with any Google/GitHub/Facebook/LinkedIn/Microsoft account.
 * `orgSlug` arrives from the `org_slug` query parameter, by way of the OAuth `state` — it is
 * the caller's choice, never a fact about them. So:
 *
 *     GET /api/oauth/google?org_slug=<any org>   → sign in with a personal Google account
 *                                                → active `member` of that organisation
 *
 * with `accounting.read`, `inventory.read`, `invoicing.read`, `payroll.read` and
 * `reports.read` — the payslips included. No invite, no approval, nothing for the target org
 * to notice. It also made the #41 tenant guard irrelevant to this path: the attacker ends up
 * holding a perfectly legitimate JWT for the victim's org, so there is no boundary left to
 * cross. Proven against a seeded org before the fix.
 *
 * ⚠ Verifying the OAuth `state` does NOT close this, which is why the two fixes are separate.
 * The state check proves the browser that finishes the flow is the one that started it — and
 * here it is: the attacker's own. Self-enrolment is an AUTHORISATION hole and needs an
 * authorisation answer.
 *
 * So membership must now pre-exist, or be granted by an invite — the same object
 * `register()` already requires for joining an org with a password, carrying the same
 * `targetEmail` pin, expiry and use count. An OAuth identity is proof of an EMAIL. It has
 * never been proof of belonging anywhere.
 */
export async function getOrCreateUser(
  info: OAuthUserInfo,
  orgSlug: string,
  inviteCode?: string,
): Promise<{ user: UserTokenized; isNew: boolean }> {
  const org = await Org.findOne({ slug: orgSlug.toLowerCase() })
  if (!org) throw new Error(`Organization "${orgSlug}" not found`)

  // ⚠ S-20 — an OAuth identity is proof of an EMAIL, and only if the provider verified that email.
  // This function used to find the member by `info.email` alone and sign in as them, which is the
  // published "nOAuth" account takeover: Microsoft Graph's `mail` (and Facebook's address) is set
  // by the tenant admin and verified by nobody, so an attacker mints an Entra tenant, sets `mail`
  // to a victim admin's address, and is logged in as that admin — payroll and accounting included.
  // S-17 closed self-ENROLMENT (joining an org you are not in); this is the EXISTING-member path
  // S-17 left untouched, and it is exactly where this attack lands. `info.emailVerified` is the gate.
  //
  // ⚠ One refusal string for every reason that turns on WHO the caller is — not a member, an
  // unverified email, a deactivated account. Distinct messages would turn this endpoint into a
  // membership oracle (ask it about an address, read whether it was "deny" or "wrong password").
  // The specific reason is logged server-side, never the email.
  const refuseSignIn =
    `This sign-in can't be used for "${org.name}". If you already have an account there, ` +
    `sign in with your password, or with the provider you linked before. ` +
    `Ask an administrator for an invitation.`

  let isNew = false

  // 1. A LINKED identity signs in whatever its email now says. This is the one lookup that trusts
  //    the provider identity itself, and it is safe to: the (provider, providerId) pair was written
  //    onto this account on an earlier sign-in that was already authorised, so honouring it again
  //    grants nothing new. `providerId` is `required` on the sub-document, so a blank or missing one
  //    cannot $elemMatch a stored row.
  let user = await User.findOne({
    orgId: org._id,
    oauthProviders: { $elemMatch: { provider: info.provider, providerId: info.providerId } },
  })
  if (user && user.isActive === false) {
    // Password login already refuses `!isActive` (auth.service.ts); the OAuth path must match, or a
    // disabled user signs straight back in with a linked Google/Microsoft identity.
    logger.warn(
      { orgId: org._id, userId: user._id, provider: info.provider, reason: 'deactivated_linked_identity' },
      'OAuth sign-in refused',
    )
    throw new Error(refuseSignIn)
  }

  // 2. Otherwise the member with this email — but ONLY if the provider verified the address, and the
  //    account is live. Emails are stored verbatim (the schema sets no `lowercase` and the
  //    `{email, orgId}` index is case-sensitive), so this lookup matches exactly, as it always has.
  if (!user) {
    const byEmail = await User.findOne({ email: info.email, orgId: org._id })
    if (byEmail) {
      if (byEmail.isActive === false) {
        logger.warn(
          { orgId: org._id, userId: byEmail._id, provider: info.provider, reason: 'deactivated_email_match' },
          'OAuth sign-in refused',
        )
        throw new Error(refuseSignIn)
      }
      if (!info.emailVerified) {
        // The whole attack is a forged-but-matching address. Refuse, and link nothing.
        logger.warn(
          { orgId: org._id, userId: byEmail._id, provider: info.provider, reason: 'unverified_email_match' },
          'OAuth sign-in refused',
        )
        throw new Error(refuseSignIn)
      }
      user = byEmail
    }
  }

  // 3. Still nobody: an invite is the only way in, and it must name THIS org and THIS email.
  let invite: Awaited<ReturnType<typeof inviteDao.findByCode>> = null
  if (!user) {
    if (!inviteCode) {
      logger.warn(
        { orgId: org._id, provider: info.provider, reason: 'no_member_no_invite' },
        'OAuth sign-in refused',
      )
      throw new Error(refuseSignIn)
    }
    invite = await inviteDao.findByCode(inviteCode)
    if (!invite) throw new Error('Invalid invite code')

    const validation = inviteDao.validate(invite)
    if (!validation.valid) throw new Error(validation.reason || 'Invite is not valid')

    // ⚠ The invite decides the org, not the URL. Honouring `org_slug` alongside a valid invite
    // for somewhere else would hand back exactly the self-enrolment this check removes, with
    // one extra step.
    if (String(invite.orgId) !== String(org._id)) {
      throw new Error('This invite is for a different organisation')
    }
    if (invite.targetEmail && invite.targetEmail.toLowerCase() !== info.email.toLowerCase()) {
      throw new Error('This invite is for a different email address')
    }
    // ⚠ S-20 — a `targetEmail` pin only means something if the email was verified. An unverified
    // address can be set to anything, so a pinned invite plus an unverified email gives the pin no
    // force at all — refuse. An UNPINNED invite is a bearer secret by design (whoever holds the code
    // may join), so verification is not part of that gate and is not checked here.
    if (invite.targetEmail && !info.emailVerified) {
      throw new Error(
        'This invitation is tied to a specific email address that your sign-in provider has not verified. Complete your sign-up with a password instead.',
      )
    }
  }

  // Multi-org (Phase 1B): who is joining, decided before the invite is consumed so a refusal costs
  // it nothing. An unverified email never founds a person (`resolveOAuthJoin`).
  let join: OAuthJoin | undefined
  if (!user) {
    join = await resolveOAuthJoin(info)
    if (join.kind === 'existing') {
      // Already a member here under a row the lookups above could not see (another address case):
      // this IS that person, so they sign in to their own membership and the invite stays unused.
      const own = await User.findOne({ identityId: join.identity._id, orgId: org._id }).exec()
      if (own) {
        if (own.isActive === false) throw new Error(refuseSignIn)
        user = own
      }
    }
  }

  if (user) {
    // Link OAuth provider if not already linked
    const already = (user.oauthProviders || []).some(
      (p) => p.provider === info.provider && p.providerId === info.providerId,
    )
    if (!already) {
      user.oauthProviders = user.oauthProviders || []
      user.oauthProviders.push({
        provider: info.provider,
        providerId: info.providerId,
      })
      await user.save()
    }
    // The person's own link too, once the provider vouched for the very address they hold. That is
    // also how a link the migration copied unverified becomes trusted (Phase 2 signs in by it).
    if (user.identityId && info.emailVerified) {
      const person = await Identity.findById(user.identityId, { email: 1 }).lean().exec()
      if (person && person.email === normalizeEmail(info.email)) await linkProviderToIdentity(user.identityId, info)
    }
  } else {
    // Create new user
    const nameParts = info.name.split(' ')
    const firstName = nameParts[0] || info.name
    const lastName = nameParts.slice(1).join(' ') || info.name
    const username = `${info.name.toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '')}_${Date.now().toString(36).slice(-4)}`

    // The invite says what they get. `member` is the floor, not the default for anyone asking.
    const role = (invite!.assignRole || 'member') as Role
    const permissions = DEFAULT_ROLE_PERMISSIONS[role] || DEFAULT_ROLE_PERMISSIONS.member

    // ⚠ Consume the invite BEFORE creating the user. `incrementUseCount` is the atomic check
    // that the last remaining use is ours; creating first and claiming after would let two
    // simultaneous callbacks both pass `validate()` and both get an account from a
    // single-use invite.
    const claimed = await inviteDao.incrementUseCount(String(invite!._id))
    if (!claimed) throw new Error('Invite could not be used')

    // The person: the one they already are, a new one, or (before the migration, while unlinked
    // users of this address wait to be grouped) none yet.
    let identityId: unknown
    let createdIdentity = false
    if (join!.kind === 'existing') {
      identityId = join!.identity._id
      await linkProviderToIdentity(identityId, info)
    } else if (join!.kind === 'new') {
      const person = await createIdentity(
        {
          email: info.email,
          firstName,
          lastName,
          avatar: info.avatarUrl,
          isActive: true,
          emailVerified: true, // resolveOAuthJoin admits no other kind of new person
          oauthProvider: { provider: info.provider, providerId: info.providerId },
        },
        'account_exists',
      )
      identityId = person._id
      createdIdentity = true
    }

    // A membership carries its person's address: an existing person keeps the one they have, even
    // when the provider reports another today (found by the link, or after an address change).
    const memberEmail =
      join!.kind === 'existing' ? join!.identity.email : identityId ? normalizeEmail(info.email) : info.email

    try {
      // What `register()` gives an invited user, and what this path skipped (S-23): the fiscal
      // operator code a POS receipt is printed under, and the start of their role history (Н-18).
      const operatorCode = await allocateOperatorCode(String(org._id))
      user = await User.create({
        email: memberEmail,
        username,
        firstName,
        lastName,
        role,
        operatorCode,
        orgId: org._id,
        identityId,
        isActive: true,
        avatar: info.avatarUrl,
        permissions,
        roleHistory: [{ role, startDate: new Date(), assignedAt: new Date() }],
        oauthProviders: [
          { provider: info.provider, providerId: info.providerId },
        ],
      })
    } catch (err) {
      if (createdIdentity) await discardIdentity(identityId)
      await inviteDao.releaseUse(String(invite!._id)).catch(() => undefined)
      throw err
    }
    isNew = true
    logger.info({ orgId: org._id, userId: user._id, provider: info.provider }, 'OAuth user created')
  }

  user.lastLoginAt = new Date()
  await user.save()

  // ⚠ S-23: the claims come from `tokenize()`, the same function password login uses. They were
  // built by hand here, from `user.permissions` (the role's defaults), so a user narrowed by a
  // permission set — read-only, or own-records-only — got the role's full rights by signing in with
  // Google instead of a password, the Administrator set's every-permission never applied, and the
  // fiscal `operatorCode` was missing. Two answers to "what may this person do" drift; one cannot.
  // `sessionFor` is `tokenize()` plus, for a linked membership, the person (`iid`/`tv`), so this
  // session ends with the person's password like any other.
  const person = user.identityId ? await Identity.findById(user.identityId, { tokenVersion: 1 }).lean().exec() : null
  return { user: await sessionFor(user, person), isNew }
}

export async function registerWithOAuth(
  info: OAuthUserInfo,
  orgName: string,
  orgSlug: string,
  username: string,
): Promise<{ user: UserTokenized; isNew: boolean }> {
  // Multi-org: founding an org makes a new person, so the address must be one the provider
  // verified (never squat an address nobody proved) and one no account has yet (that person signs
  // in, then founds the org as themselves).
  if (!info.emailVerified) throw new IdentityError('unverified_email')
  if (await emailInUse(info.email)) throw new IdentityError('account_exists')

  const existingOrg = await Org.findOne({ slug: orgSlug.toLowerCase() })
  if (existingOrg) throw new Error(`Organization slug "${orgSlug}" is already taken`)

  const nameParts = info.name.split(' ')
  const firstName = nameParts[0] || info.name
  const lastName = nameParts.slice(1).join(' ') || info.name

  const person = await createIdentity(
    {
      email: info.email,
      firstName,
      lastName,
      avatar: info.avatarUrl,
      isActive: true,
      emailVerified: true,
      oauthProvider: { provider: info.provider, providerId: info.providerId },
    },
    'account_exists',
  )

  let org: IOrg | undefined
  let user: IUser | undefined
  try {
    // ⚠ S-23: the same org a password registration builds. This copy enabled no modules, seeded no
    // permission sets and created no app rows, and its admin had no operator code or role history, so
    // the founder held the admin ROLE's defaults rather than the Administrator set's every-permission.
    org = await Org.create({
      name: orgName,
      slug: orgSlug.toLowerCase(),
      settings: defaultOrgSettings(),
      subscription: { plan: 'free', maxUsers: 5 },
    })

    const operatorCode = await allocateOperatorCode(String(org._id))
    user = await User.create({
      email: normalizeEmail(info.email),
      username,
      firstName,
      lastName,
      role: 'admin',
      operatorCode,
      orgId: org._id,
      identityId: person._id,
      isActive: true,
      avatar: info.avatarUrl,
      permissions: DEFAULT_ROLE_PERMISSIONS.admin,
      roleHistory: [{ role: 'admin', startDate: new Date(), assignedAt: new Date() }],
      oauthProviders: [
        { provider: info.provider, providerId: info.providerId },
      ],
    })

    await provisionNewOrg(org, user)
  } catch (err) {
    await discardIdentity(person._id)
    if (user) await User.deleteOne({ _id: user._id }).catch(() => undefined)
    if (org) await Org.deleteOne({ _id: org._id }).catch(() => undefined)
    throw err
  }

  logger.info({ orgId: org._id, userId: user._id, provider: info.provider }, 'OAuth registration completed')

  return { user: await sessionFor(user, person), isNew: true }
}

/**
 * The org an invitation is for. An org-less OAuth sign-in that carries an invite joins THAT org
 * (`getOrCreateUser` then checks the invite in full: org, pinned address, uses).
 */
export async function inviteOrgSlug(code: string): Promise<string> {
  const invite = await inviteDao.findByCode(code)
  const org = invite ? await Org.findById(invite.orgId, { slug: 1 }).lean().exec() : null
  if (!org) throw new Error('Invalid invite code')
  return org.slug
}

/** Why an org-less OAuth sign-in found no way in (the callback redirects with the code). */
export class OAuthSignInError extends Error {
  constructor(readonly code: 'no_account' | 'not_activated', message: string) {
    super(message)
  }
}

/**
 * An org-less OAuth sign-in (multi-org Phase 2): the provider account names a PERSON, who then
 * lands like a password sign-in (rule 5), or chooses.
 *
 * Who it is, in order (rule 4):
 *   - the person who holds this provider account. A link the migration copied is unconfirmed
 *     (before S-20 an unverified email was enough to make one), so it counts only when the
 *     provider vouches, right now, for the person's own address; it is then confirmed.
 *     Otherwise `link_unconfirmed`: no proof of who this is, and someone else's link;
 *   - else the person whose address the provider VERIFIED; the account is linked for next time.
 *     An unverified address (Microsoft, Facebook) names nobody;
 *   - else no account (`no_account`). Joining an org is an invitation, never a sign-in.
 *
 * Before the migration has linked them, existing users are not people yet, so this finds them
 * not: the org path (`org_slug`) still signs them in as before.
 */
export async function signInWithOAuth(info: OAuthUserInfo, opts: { prefer?: string } = {}): Promise<LoginResult> {
  const address = normalizeEmail(info.email)
  let identity = await Identity.findOne({
    oauthProviders: { $elemMatch: { provider: info.provider, providerId: info.providerId } },
  }).exec()
  if (identity) {
    const link = identity.oauthProviders.find(l => l.provider === info.provider && l.providerId === info.providerId)
    const vouched = info.emailVerified && address === identity.email
    if (!link?.verified && !vouched) throw new IdentityError('link_unconfirmed')
    if (!link?.verified) await linkProviderToIdentity(identity._id, info)
  } else if (info.emailVerified) {
    identity = await Identity.findOne({ email: address }).exec()
    if (identity) await linkProviderToIdentity(identity._id, info)
  }
  if (!identity) {
    throw new OAuthSignInError('no_account', 'There is no LGR account for this sign-in. Ask your organization for an invitation.')
  }
  if (!identity.isActive) {
    throw new OAuthSignInError('not_activated', 'Account not activated. Check your email for the activation link.')
  }
  // The provider has just proven the person holds their own address.
  if (info.emailVerified && address === identity.email && !identity.emailVerified) {
    await Identity.updateOne({ _id: identity._id }, { $set: { emailVerified: true, emailVerifiedAt: new Date() } }).exec()
  }

  const memberships = await membershipsOf(identity._id)
  const landing = chooseLanding(identity, memberships, opts.prefer)
  if (!landing) {
    await Identity.updateOne({ _id: identity._id }, { $set: { lastLoginAt: new Date() } }).exec()
    return { kind: 'choose', identity, memberships }
  }
  const org = await Org.findById(landing.user.orgId).exec()
  if (!org) throw new OAuthSignInError('no_account', 'There is no LGR account for this sign-in. Ask your organization for an invitation.')
  return landInOrg(landing.user, identity, org, memberships)
}

/**
 * Decode the `state` the provider handed back.
 *
 * ⚠ This returns ATTACKER-INFLUENCED data and always did — `state` makes a round trip through
 * the user's browser, so anything in it can be rewritten before the callback lands. Nothing
 * here authenticates it; `nonce` is returned so the CALLER can compare it against the cookie
 * it set when the flow began, and no field below may be trusted until that comparison passes.
 *
 * Fields are read individually and coerced rather than spread, so a crafted state cannot
 * introduce keys the callback never asked for.
 */
export function parseState(stateStr: string): {
  orgSlug?: string
  mode?: string
  nonce?: string
  inviteCode?: string
  desktopId?: string
  codeChallenge?: string
  prefer?: string
} {
  try {
    const decoded = Buffer.from(stateStr, 'base64url').toString('utf8')
    const raw = JSON.parse(decoded)
    if (!raw || typeof raw !== 'object') throw new Error('not an object')
    const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined)
    return {
      orgSlug: str(raw.orgSlug),
      mode: str(raw.mode),
      nonce: str(raw.nonce),
      inviteCode: str(raw.inviteCode),
      // ⚠ As attacker-influenced as every other field here, and usable for the same reason:
      // only AFTER the caller's nonce comparison passes. A crafted `desktopId` then names a
      // desktop in a flow the attacker started in their own browser, which signs in nobody but
      // them — and the code it produces still needs the verifier they do not have.
      desktopId: str(raw.desktopId),
      codeChallenge: str(raw.codeChallenge),
      // Only ever a landing PREFERENCE among the person's own memberships (`chooseLanding`), so a
      // rewritten value can at most land them in another org they already belong to.
      prefer: str(raw.prefer),
    }
  } catch {
    throw new Error('Invalid OAuth state parameter')
  }
}

// ── The sign-in handoff: no credential in a URL ─────────────────────────────────────────────
//
// The callback used to finish with `…/auth/oauth-callback?token=<JWT>`, and the view stored
// whatever `?token=` it found. That is login fixation: an attacker who starts their own OAuth
// flow, then sends the victim that URL within the token's life, signs the victim into the
// attacker's account and org. It survived FR-14.24 because the callback route is the one place
// that gate has to be exempted — `token` means something else there.
//
// So the claims go into a one-time server-side record and the code goes into an httpOnly
// cookie. An attacker cannot set a cookie on our origin, so a planted `/auth/oauth-callback`
// URL now carries nothing at all. This is FR-14.14's rule ("no JWT ever travels in a URL")
// applied to the browser flow, not only to the desktop one.

/** How long the browser has to finish the handoff. It is one redirect plus one POST. */
const HANDOFF_TTL_MS = 120_000

/** One message for every refusal, so the endpoint cannot be used as an oracle. */
export const HANDOFF_REFUSED = 'No sign-in is in progress. Please sign in again.'

/** Thrown for every reason a handoff cannot be redeemed, so the caller cannot tell which. */
export class HandoffError extends Error {}

function hashHandoffCode(code: string): string {
  return createHash('sha256').update(code).digest('hex')
}

/**
 * Mint a one-time code for `payload`, returning the code to put in the httpOnly cookie.
 *
 * 32 random bytes: this is a bearer credential for two minutes, so it is sized like one, not
 * like the human-typed 8-character codes elsewhere in the system.
 */
export async function createLoginHandoff(payload: UserTokenized | IdentityClaims): Promise<string> {
  const code = randomBytes(32).toString('base64url')
  // An org session names its membership; an identity-only sign-in (no org chosen yet) its person.
  const person = asIdentityClaims(payload)
  await OAuthHandoff.create({
    codeHash: hashHandoffCode(code),
    ...(person
      ? { identityId: person.iid }
      : { userId: (payload as UserTokenized).id, orgId: (payload as UserTokenized).orgId }),
    payload,
    expiresAt: new Date(Date.now() + HANDOFF_TTL_MS),
  })
  return code
}

/**
 * Redeem a handoff code: mark it used and return the claims to sign.
 *
 * ⚠ Single use is enforced by a **conditional** update (`usedAt: null` in the filter), not by a
 * read followed by a write. Two simultaneous redeems would both pass a read-then-write check,
 * and the point of a one-time code is that exactly one of them wins.
 *
 * Every failure — unknown, expired, already used — raises the same message. Distinguishing them
 * would tell an attacker whether a guessed code had ever existed.
 */
export async function redeemLoginHandoff(
  code: unknown,
): Promise<{ user: SessionUser; org: IOrg; person?: undefined } | { person: IdentityClaims; user?: undefined; org?: undefined }> {
  if (typeof code !== 'string' || !code) throw new HandoffError(HANDOFF_REFUSED)

  const row = await OAuthHandoff.findOneAndUpdate(
    // ⚠ `desktopId: null` — a DESKTOP handoff must not be redeemable through the browser route,
    // which asks for no verifier. Without this clause the cookie path would be a way around
    // PKCE for anyone who could plant the cookie.
    { codeHash: hashHandoffCode(code), usedAt: null, expiresAt: { $gt: new Date() }, desktopId: null },
    { $set: { usedAt: new Date() } },
    { new: true },
  ).exec()
  if (!row) throw new HandoffError(HANDOFF_REFUSED)

  // An identity-only sign-in: the person re-checked like a session (still active, still on the
  // same tokenVersion), in the same single refusal as every other failure.
  const person = asIdentityClaims(row.payload)
  if (person) {
    if (!(await identityStillValid(person.iid, person.tv))) throw new HandoffError(HANDOFF_REFUSED)
    return { person }
  }

  const org = await Org.findById(row.orgId).exec()
  if (!org) throw new HandoffError(HANDOFF_REFUSED)

  // ⚠ S-20 — re-check the account is still live. The handoff was minted at the end of the OAuth
  // callback, where `getOrCreateUser` had just confirmed the account was active; if an admin
  // deactivates (or deletes) the user in the window before the SPA redeems the code, the stored
  // claims would otherwise still mint a full session. Same refusal as every other failure, so a
  // redeemer cannot tell a deactivated account from an expired or unknown code.
  const live = await User.findById(row.userId).exec()
  if (!live || live.isActive === false) throw new HandoffError(HANDOFF_REFUSED)

  // The claims come back as the callback assembled them, so the token this produces is the one
  // the callback would have signed. Re-deriving them here would be a second, drifting
  // implementation of what a session says about a user. A session naming a person must also
  // still match them (a password changed in the window ends it here too).
  const user = row.payload as unknown as SessionUser
  if (user.iid && !(await identityStillValid(user.iid, user.tv))) throw new HandoffError(HANDOFF_REFUSED)
  return { user, org }
}

// ── The DESKTOP handoff: the same record, delivered over `lgr://` and locked with PKCE ───────
//
// FR-14.14. The desktop never runs a provider page inside its webview — Google refuses embedded
// webviews it detects (`disallowed_useragent`), and WHICH ones it detects changes without
// notice. So the handshake runs in the system browser and comes back through `lgr://login`.
//
// ⚠ That scheme is claimable by any program on the machine, so the code alone must not be a
// credential. The shell sends an S256 challenge when it starts the flow and keeps the verifier;
// a thief of the deep link holds a code it cannot redeem.

/**
 * 60 seconds (FR-14.14): the gap between the browser redirecting and the shell navigating its
 * own window. ⚠ Shorter than the browser handoff's two minutes on purpose — this one crosses a
 * scheme any application can register, so its window is as small as the flow allows.
 */
const DESKTOP_HANDOFF_TTL_MS = 60_000

/** base64url, unpadded — what a web client produces with `btoa` + replace, and what RFC 7636 specifies. */
function s256(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url')
}

/**
 * Mint a one-time code bound to a desktop and a challenge.
 *
 * ⚠ The challenge is stored, never the verifier — storing the verifier would make a dump of this
 * collection redeemable, which is exactly what hashing the code already prevents.
 */
/**
 * The slug of the org a REGISTERED, active desktop belongs to; undefined for an id that names no
 * such desktop (unknown, malformed or revoked).
 *
 * ⚠ Why the OAuth start needs it: a desktop sign-in must land in ONE org (the shell cannot show an
 * org picker), and that org used to arrive as `org_slug` from the login page. Since multi-org
 * sign-in the page sends `org_slug` only when its hidden org field was opened, so every desktop
 * Google/Microsoft sign-in answered 400 "org_slug query parameter is required for a desktop
 * sign-in" (prod, 2026-10-14). The desktop already belongs to exactly one org, so that is the org.
 *
 * Not an authorization step: `desktopId` is not authenticated at this point, but it only picks
 * the org to sign in to, and the provider account must still be a member there. The redeem
 * re-checks that the desktop is active.
 */
export async function desktopOrgSlug(desktopId: unknown): Promise<string | undefined> {
  if (typeof desktopId !== 'string' || !/^[0-9a-f]{24}$/i.test(desktopId)) return undefined
  const desktop = await Desktop.findOne({ _id: desktopId, status: 'active' }, { orgId: 1 }).lean().exec()
  if (!desktop) return undefined
  const org = await Org.findById((desktop as any).orgId, { slug: 1 }).lean().exec()
  return (org as any)?.slug || undefined
}

export async function createDesktopHandoff(
  payload: UserTokenized,
  desktopId: string,
  codeChallenge: string,
): Promise<string> {
  const code = randomBytes(32).toString('base64url')
  await OAuthHandoff.create({
    codeHash: hashHandoffCode(code),
    userId: payload.id,
    orgId: payload.orgId,
    payload,
    desktopId,
    codeChallenge,
    expiresAt: new Date(Date.now() + DESKTOP_HANDOFF_TTL_MS),
  })
  return code
}

// ── The sign-up handoff: no credential in a URL either ────────────────────────────────────
//
// In register mode the callback used to finish with `…/auth/register?oauth_token=<JWT>`, an
// `oauth_pending` token carrying the provider identity. The register view posted back whatever
// token was in the URL, so an attacker who started their own sign-up and sent the victim that
// URL got an org and an admin account created by the victim but linked to the ATTACKER's
// provider identity, which the attacker could then sign in to. The token also sat in the
// history, the access log, `Referer` and page analytics.
//
// Same fix as the sign-in handoff above: the identity goes into a one-time record, its code
// into an httpOnly cookie, and the register form reads the prefill and completes the sign-up
// through that cookie. A planted register URL now carries nothing.
//
// Two differences from the sign-in handoff, both because a person fills in a form in between:
// the code lives longer, and a sign-up that FAILS releases it (a taken org slug is corrected
// and resubmitted, not restarted at the provider).

/** How long the person has to fill in the register form. */
export const PENDING_REGISTRATION_TTL_MS = 30 * 60_000

/** One message for every refusal, so the endpoints cannot be used as an oracle. */
export const PENDING_REGISTRATION_REFUSED =
  'No sign-up is in progress. Please continue with your provider again.'

/** Thrown for every reason a pending sign-up cannot be read or used, so the caller cannot tell which. */
export class PendingRegistrationError extends Error {}

/** What the register form may show. The provider id stays on the server. */
export interface PendingRegistrationPrefill {
  provider: string
  email: string
  name: string
}

/**
 * Mint a one-time code for the provider identity the callback fetched, returning the code to
 * put in the httpOnly cookie. Sized like the sign-in handoff code: it is a bearer credential for
 * as long as it lives.
 */
export async function createPendingRegistration(info: OAuthUserInfo): Promise<string> {
  const code = randomBytes(32).toString('base64url')
  await OAuthPendingRegistration.create({
    codeHash: hashHandoffCode(code),
    claims: {
      provider: info.provider,
      providerId: info.providerId,
      email: info.email,
      name: info.name || '',
      avatarUrl: info.avatarUrl || undefined,
      emailVerified: info.emailVerified === true,
    },
    expiresAt: new Date(Date.now() + PENDING_REGISTRATION_TTL_MS),
  })
  return code
}

/**
 * Redeem a desktop code with its verifier.
 *
 * ⚠ The desktop must still be ACTIVE. A revoked till that completed a sign-in a minute ago must
 * not be able to finish it — the row is the revocation list, and this is one of the places that
 * has to read it.
 *
 * Every refusal raises the same message, for the same reason the browser path does: a caller
 * must not be able to learn whether a guessed code ever existed, whether it had expired, or
 * whether the verifier was the wrong one.
 */
export async function redeemDesktopHandoff(
  code: unknown,
  verifier: unknown,
): Promise<{ user: UserTokenized; org: IOrg }> {
  if (typeof code !== 'string' || !code) throw new HandoffError(HANDOFF_REFUSED)
  if (typeof verifier !== 'string' || verifier.length < 43) throw new HandoffError(HANDOFF_REFUSED)

  // ⚠ Claim FIRST, check the verifier after. The conditional update is what makes the code
  // single use, and checking the verifier before claiming would let an attacker burn attempts
  // against a code without ever consuming it.
  const row = await OAuthHandoff.findOneAndUpdate(
    {
      codeHash: hashHandoffCode(code),
      usedAt: null,
      expiresAt: { $gt: new Date() },
      desktopId: { $ne: null },
    },
    { $set: { usedAt: new Date() } },
    { new: true },
  ).exec()
  if (!row || !row.codeChallenge) throw new HandoffError(HANDOFF_REFUSED)

  // Constant time, like the OAuth nonce: this is a secret for the length of one flow.
  const expected = row.codeChallenge
  const got = s256(verifier)
  if (got.length !== expected.length) throw new HandoffError(HANDOFF_REFUSED)
  let diff = 0
  for (let i = 0; i < got.length; i++) diff |= got.charCodeAt(i) ^ expected.charCodeAt(i)
  if (diff !== 0) throw new HandoffError(HANDOFF_REFUSED)

  const desktop = await Desktop.findById(row.desktopId).lean().exec()
  if (!desktop || (desktop as any).status !== 'active') throw new HandoffError(HANDOFF_REFUSED)

  const org = await Org.findById(row.orgId).exec()
  if (!org) throw new HandoffError(HANDOFF_REFUSED)

  // ⚠ S-20's deactivated-user refusal, carried onto this path in the merge. The claims were
  // assembled when the callback ran; if the account has been deactivated since, completing the
  // sign-in would hand out a session for a user the org has switched off. The browser redeem
  // above does this, and a desktop sign-in must not be the softer way in.
  const live = await User.findById(row.userId).exec()
  if (!live || live.isActive === false) throw new HandoffError(HANDOFF_REFUSED)

  return { user: row.payload as unknown as UserTokenized, org }
}

async function livePendingRegistration(code: unknown) {
  if (typeof code !== 'string' || !code) throw new PendingRegistrationError(PENDING_REGISTRATION_REFUSED)
  const row = await OAuthPendingRegistration.findOne({
    codeHash: hashHandoffCode(code),
    usedAt: null,
    expiresAt: { $gt: new Date() },
  }).exec()
  if (!row) throw new PendingRegistrationError(PENDING_REGISTRATION_REFUSED)
  return row
}

/**
 * The prefill for the register form. Reading does NOT use the code: the form may be reloaded,
 * and only a completed sign-up consumes it.
 */
export async function readPendingRegistration(code: unknown): Promise<PendingRegistrationPrefill> {
  const row = await livePendingRegistration(code)
  return { provider: row.claims.provider, email: row.claims.email, name: row.claims.name || '' }
}

/**
 * Complete an OAuth sign-up with the identity the callback stored for this browser.
 *
 * ⚠ The code is claimed with a **conditional** update (`usedAt: null` in the filter), as the
 * sign-in handoff is, so exactly one of two simultaneous submissions proceeds. The loser gets the
 * refusal; the winner's sign-up runs with the claims from the record, never from the request.
 *
 * A sign-up that throws (taken org slug, taken username) releases the claim, again conditionally
 * on it still being the claim this call made, and rethrows the original error for the form.
 */
export async function registerWithPendingRegistration(
  code: unknown,
  orgName: string,
  orgSlug: string,
  username: string,
): Promise<{ user: UserTokenized; isNew: boolean }> {
  if (typeof code !== 'string' || !code) throw new PendingRegistrationError(PENDING_REGISTRATION_REFUSED)

  const claimedAt = new Date()
  const row = await OAuthPendingRegistration.findOneAndUpdate(
    { codeHash: hashHandoffCode(code), usedAt: null, expiresAt: { $gt: claimedAt } },
    { $set: { usedAt: claimedAt } },
    { new: true },
  ).exec()
  if (!row) throw new PendingRegistrationError(PENDING_REGISTRATION_REFUSED)

  try {
    return await registerWithOAuth(
      {
        provider: row.claims.provider,
        providerId: row.claims.providerId,
        email: row.claims.email,
        name: row.claims.name,
        avatarUrl: row.claims.avatarUrl,
        emailVerified: row.claims.emailVerified === true,
      },
      orgName,
      orgSlug,
      username,
    )
  } catch (err) {
    await OAuthPendingRegistration.updateOne({ _id: row._id, usedAt: claimedAt }, { $set: { usedAt: null } }).exec()
    throw err
  }
}
