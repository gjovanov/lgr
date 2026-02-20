import { Elysia, t } from 'elysia'
import { AuthService } from '../auth/auth.service.js'
import {
  buildAuthUrl,
  exchangeCodeForToken,
  fetchUserInfo,
  getOrCreateUser,
  registerWithOAuth,
  parseState,
} from 'services/biz/oauth.service'
import { config } from 'config'

const VALID_PROVIDERS = ['google', 'facebook', 'github', 'linkedin', 'microsoft']

export const oauthController = new Elysia({ prefix: '/oauth' })
  .use(AuthService)
  .get(
    '/:provider',
    async ({ params: { provider }, query, set }) => {
      if (!VALID_PROVIDERS.includes(provider)) {
        set.status = 400
        return { message: `Unknown provider: ${provider}` }
      }

      const orgSlug = (query as any).org_slug
      const mode = (query as any).mode || 'login'

      if (mode === 'login' && !orgSlug) {
        set.status = 400
        return { message: 'org_slug query parameter is required for login' }
      }

      try {
        const authUrl = buildAuthUrl(provider, orgSlug, mode)
        return Response.redirect(authUrl, 302)
      } catch (err: any) {
        set.status = 400
        return { message: err.message }
      }
    },
  )
  .get(
    '/callback/:provider',
    async ({ params: { provider }, query, jwt, cookie: { auth }, set }) => {
      if (!VALID_PROVIDERS.includes(provider)) {
        set.status = 400
        return { message: `Unknown provider: ${provider}` }
      }

      const { code, state } = query as { code?: string; state?: string }
      if (!code || !state) {
        set.status = 400
        return { message: 'Missing code or state parameter' }
      }

      try {
        const { orgSlug, mode } = parseState(state)
        const accessToken = await exchangeCodeForToken(provider, code)
        const userInfo = await fetchUserInfo(provider, accessToken)

        if (!userInfo.email) {
          set.status = 400
          return { message: 'Could not retrieve email from OAuth provider' }
        }

        if (mode === 'register') {
          const pendingToken: string = await jwt.sign({
            type: 'oauth_pending',
            email: userInfo.email,
            name: userInfo.name,
            provider: userInfo.provider,
            providerId: userInfo.providerId,
            avatarUrl: userInfo.avatarUrl || '',
          } as any)
          return Response.redirect(
            `${config.oauth.frontendUrl}/auth/register?oauth_token=${pendingToken}`,
            302,
          )
        }

        const { user } = await getOrCreateUser(userInfo, orgSlug)

        const token: string = await jwt.sign(user as any)
        auth.set({
          value: token,
          httpOnly: true,
          maxAge: 7 * 86400,
          path: '/',
        })

        return Response.redirect(`${config.oauth.frontendUrl}/auth/oauth-callback?token=${token}`, 302)
      } catch (err: any) {
        return Response.redirect(`${config.oauth.frontendUrl}/auth/login?error=${encodeURIComponent(err.message)}`, 302)
      }
    },
  )
  .post(
    '/register-oauth',
    async ({ jwt, body, cookie: { auth }, set }) => {
      try {
        const pending = await jwt.verify(body.oauthToken)
        if (!pending || (pending as any).type !== 'oauth_pending') {
          set.status = 400
          return { message: 'Invalid or expired OAuth token' }
        }

        const p = pending as any
        const { user } = await registerWithOAuth(
          { provider: p.provider, providerId: p.providerId, email: p.email, name: p.name, avatarUrl: p.avatarUrl },
          body.orgName,
          body.orgSlug,
          body.username,
        )

        const token: string = await jwt.sign(user as any)
        auth.set({
          value: token,
          httpOnly: true,
          maxAge: 7 * 86400,
          path: '/',
        })

        return { user, token, org: { id: user.orgId, name: body.orgName, slug: body.orgSlug } }
      } catch (err: any) {
        set.status = 400
        return { message: err.message }
      }
    },
    {
      body: t.Object({
        oauthToken: t.String(),
        orgName: t.String({ minLength: 2 }),
        orgSlug: t.String({ minLength: 2 }),
        username: t.String({ minLength: 3 }),
      }),
    },
  )
