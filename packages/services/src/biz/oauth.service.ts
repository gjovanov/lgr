import { config } from 'config'
import { User, Org, type IUser } from 'db/models'
import { DEFAULT_ROLE_PERMISSIONS } from 'config/constants'
import { type UserTokenized } from './auth.service.js'
import { logger } from '../logger/logger.js'

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

export function buildAuthUrl(provider: string, orgSlug?: string, mode: string = 'login'): string {
  const providerDef = PROVIDERS[provider]
  if (!providerDef) throw new Error(`Unknown OAuth provider: ${provider}`)
  const { clientId } = getProviderConfig(provider)
  const state = JSON.stringify({ orgSlug, mode, nonce: crypto.randomUUID() })
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

export async function getOrCreateUser(
  info: OAuthUserInfo,
  orgSlug: string,
): Promise<{ user: UserTokenized; isNew: boolean }> {
  const org = await Org.findOne({ slug: orgSlug.toLowerCase() })
  if (!org) throw new Error(`Organization "${orgSlug}" not found`)

  // Try to find existing user by email in this org
  let user = await User.findOne({ email: info.email, orgId: org._id })
  let isNew = false

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

    user = await User.create({
      email: info.email,
      username,
      firstName,
      lastName,
      role: 'member',
      orgId: org._id,
      isActive: true,
      avatar: info.avatarUrl,
      permissions: DEFAULT_ROLE_PERMISSIONS.member,
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
        defaultVatRate: 18,
        vatRates: [
          { name: 'Standard', rate: 18 },
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
  }

  return { user: tokenized, isNew: true }
}

export function parseState(stateStr: string): { orgSlug?: string; mode?: string } {
  try {
    const decoded = Buffer.from(stateStr, 'base64url').toString('utf8')
    return JSON.parse(decoded)
  } catch {
    throw new Error('Invalid OAuth state parameter')
  }
}
