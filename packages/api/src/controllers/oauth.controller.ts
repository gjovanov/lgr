import { Elysia, t } from 'elysia'
import { AuthService } from '../auth/auth.service.js'
import {
  buildAuthUrl,
  exchangeCodeForToken,
  fetchUserInfo,
  getOrCreateUser,
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
      if (!orgSlug) {
        set.status = 400
        return { message: 'org_slug query parameter is required' }
      }

      try {
        const authUrl = buildAuthUrl(provider, orgSlug)
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
        const { orgSlug } = parseState(state)
        const accessToken = await exchangeCodeForToken(provider, code)
        const userInfo = await fetchUserInfo(provider, accessToken)

        if (!userInfo.email) {
          set.status = 400
          return { message: 'Could not retrieve email from OAuth provider' }
        }

        const { user } = await getOrCreateUser(userInfo, orgSlug)

        const token: string = await jwt.sign(user as any)
        auth.set({
          value: token,
          httpOnly: true,
          maxAge: 7 * 86400,
          path: '/',
        })

        // Redirect to frontend
        return Response.redirect(`${config.oauth.frontendUrl}/auth/oauth-callback?token=${token}`, 302)
      } catch (err: any) {
        return Response.redirect(`${config.oauth.frontendUrl}/auth/login?error=${encodeURIComponent(err.message)}`, 302)
      }
    },
  )
