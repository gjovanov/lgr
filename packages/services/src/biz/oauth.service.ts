import { config } from 'config'
import { User, Org, type IUser } from 'db/models'
import { DEFAULT_ROLE_PERMISSIONS, type Role } from 'config/constants'
import { type UserTokenized } from './auth.service.js'
import { logger } from '../logger/logger.js'
import { inviteDao } from '../dao/invite.dao.js'

export interface OAuthUserInfo {
  provider: string
  providerId: string
  email: string
  name: string
  avatarUrl?: string
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
      const resp = await fetch('https://www.googleapis.com/userinfo/v2/me', {
        headers: { Authorization: `Bearer ${accessToken}` },
      })
      const data = await resp.json() as any
      return {
        provider: 'google',
        providerId: data.id,
        email: data.email || '',
        name: data.name || `${data.given_name || ''} ${data.family_name || ''}`.trim(),
        avatarUrl: data.picture,
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
      const resp = await fetch(
        `https://graph.facebook.com/v18.0/me?fields=email,name,picture.type(large)&access_token=${accessToken}`,
      )
      const data = await resp.json() as any
      return {
        provider: 'facebook',
        providerId: data.id,
        email: data.email || '',
        name: data.name || '',
        avatarUrl: data.picture?.data?.url,
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
      const resp = await fetch('https://api.github.com/user', {
        headers: { Authorization: `Bearer ${accessToken}`, 'User-Agent': 'lgr-app' },
      })
      const data = await resp.json() as any
      let email = data.email
      if (!email) {
        const emailResp = await fetch('https://api.github.com/user/emails', {
          headers: { Authorization: `Bearer ${accessToken}`, 'User-Agent': 'lgr-app' },
        })
        const emails = await emailResp.json() as any[]
        const primary = emails.find((e: any) => e.primary && e.verified)
        email = primary?.email || ''
      }
      return {
        provider: 'github',
        providerId: String(data.id),
        email,
        name: data.login,
        avatarUrl: data.avatar_url,
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
      const resp = await fetch('https://api.linkedin.com/v2/userinfo', {
        headers: { Authorization: `Bearer ${accessToken}` },
      })
      const data = await resp.json() as any
      return {
        provider: 'linkedin',
        providerId: data.sub || '',
        email: data.email || '',
        name: data.name || `${data.given_name || ''} ${data.family_name || ''}`.trim(),
        avatarUrl: data.picture,
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
      const resp = await fetch('https://graph.microsoft.com/v1.0/me', {
        headers: { Authorization: `Bearer ${accessToken}` },
      })
      const data = await resp.json() as any
      return {
        provider: 'microsoft',
        providerId: data.id,
        email: data.mail || data.userPrincipalName || '',
        name: data.displayName || data.givenName || '',
        avatarUrl: undefined,
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
export function buildAuthUrl(
  provider: string,
  orgSlug: string | undefined,
  mode: string,
  nonce: string,
  inviteCode?: string,
): string {
  const providerDef = PROVIDERS[provider]
  if (!providerDef) throw new Error(`Unknown OAuth provider: ${provider}`)
  if (!nonce) throw new Error('buildAuthUrl requires a nonce')
  const { clientId } = getProviderConfig(provider)
  const state = JSON.stringify({ orgSlug, mode, nonce, inviteCode })
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
    resp = await fetch(`${providerDef.tokenUrl}?${qs}`, {
      headers: { Accept: 'application/json' },
    })
  } else {
    resp = await fetch(providerDef.tokenUrl, {
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
  return providerDef.userInfoFetcher(accessToken)
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

  // Try to find existing user by email in this org
  let user = await User.findOne({ email: info.email, orgId: org._id })
  let isNew = false

  // Not a member yet: an invite is the only way in, and it must name THIS org and THIS email.
  let invite: Awaited<ReturnType<typeof inviteDao.findByCode>> = null
  if (!user) {
    if (!inviteCode) {
      throw new Error(
        `No account for ${info.email} in "${orgSlug}". Ask an administrator for an invitation.`,
      )
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

    user = await User.create({
      email: info.email,
      username,
      firstName,
      lastName,
      role,
      orgId: org._id,
      isActive: true,
      avatar: info.avatarUrl,
      permissions,
      oauthProviders: [
        { provider: info.provider, providerId: info.providerId },
      ],
    })
    isNew = true
    logger.info({ orgId: org._id, userId: user._id, provider: info.provider }, 'OAuth user created')
  }

  user.lastLoginAt = new Date()
  await user.save()

  const tokenized: UserTokenized = {
    id: String(user._id),
    email: user.email,
    username: user.username,
    firstName: user.firstName,
    lastName: user.lastName,
    role: user.role,
    orgId: String(org._id),
    permissions: [...user.permissions],
    ownRecordsModules: [],
  }

  return { user: tokenized, isNew }
}

export async function registerWithOAuth(
  info: OAuthUserInfo,
  orgName: string,
  orgSlug: string,
  username: string,
): Promise<{ user: UserTokenized; isNew: boolean }> {
  const existingOrg = await Org.findOne({ slug: orgSlug.toLowerCase() })
  if (existingOrg) throw new Error(`Organization slug "${orgSlug}" is already taken`)

  const nameParts = info.name.split(' ')
  const firstName = nameParts[0] || info.name
  const lastName = nameParts.slice(1).join(' ') || info.name

  const org = await Org.create({
    name: orgName,
    slug: orgSlug.toLowerCase(),
    settings: {
      baseCurrency: 'EUR',
      fiscalYearStart: 1,
      dateFormat: 'DD.MM.YYYY',
      timezone: 'Europe/Berlin',
      locale: 'en',
      taxConfig: {
        vatEnabled: true,
        defaultVatRate: 20,
        vatRates: [
          { name: 'Standard', rate: 20 },
          { name: 'Reduced', rate: 5 },
          { name: 'Zero', rate: 0 },
        ],
        taxIdLabel: 'VAT ID',
      },
      payroll: {
        payFrequency: 'monthly',
        socialSecurityRate: 0,
        healthInsuranceRate: 0,
        pensionRate: 0,
      },
      modules: [],
    },
    subscription: { plan: 'free', maxUsers: 5 },
  })

  const user = await User.create({
    email: info.email,
    username,
    firstName,
    lastName,
    role: 'admin',
    orgId: org._id,
    isActive: true,
    avatar: info.avatarUrl,
    permissions: DEFAULT_ROLE_PERMISSIONS.admin,
    oauthProviders: [
      { provider: info.provider, providerId: info.providerId },
    ],
  })

  org.ownerId = user._id
  await org.save()

  logger.info({ orgId: org._id, userId: user._id, provider: info.provider }, 'OAuth registration completed')

  const tokenized: UserTokenized = {
    id: String(user._id),
    email: user.email,
    username,
    firstName,
    lastName,
    role: 'admin',
    orgId: String(org._id),
    permissions: [...DEFAULT_ROLE_PERMISSIONS.admin],
    ownRecordsModules: [],
  }

  return { user: tokenized, isNew: true }
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
    }
  } catch {
    throw new Error('Invalid OAuth state parameter')
  }
}
