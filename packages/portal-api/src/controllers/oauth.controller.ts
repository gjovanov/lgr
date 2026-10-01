import { Elysia, t } from 'elysia'
import { randomUUID } from 'crypto'
import { AuthService } from '../auth/auth.service.js'
import {
  buildAuthUrl,
  exchangeCodeForToken,
  fetchUserInfo,
  getOrCreateUser,
  registerWithOAuth,
  parseState,
  createLoginHandoff,
  createDesktopHandoff,
} from 'services/biz/oauth.service'
import { HANDOFF_COOKIE, handoffCookieOptions } from '../auth/handoff-cookie.js'
import { config } from 'config'

const VALID_PROVIDERS = ['google', 'facebook', 'github', 'linkedin', 'microsoft']

/**
 * The cookie that makes `state` mean something.
 *
 * ⚠ `sameSite: 'lax'`, and it CANNOT be `'strict'`. The callback arrives as a top-level
 * navigation from the provider's domain — a cross-site request — and a strict cookie is
 * withheld on exactly those. The flow would then fail for every legitimate user while a
 * `'lax'` cookie rides along on the GET navigation as intended. This is the one place where
 * the stricter setting is the broken one, so it is written down rather than discovered again.
 *
 * ⚠ Scoped to `/api/oauth` so it is not attached to every request on the site, and given a
 * ten-minute life: it is consumed by the callback, and a flow nobody finishes should not leave
 * a credential in the browser for a day.
 */
const STATE_COOKIE = 'oauth_state'
const STATE_TTL_SECONDS = 600
const stateCookieOptions = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'lax' as const,
  path: '/api/oauth',
  maxAge: STATE_TTL_SECONDS,
}

/**
 * Compare in constant time. The nonce is a secret for the length of one flow, and `===` on
 * strings leaks its prefix through timing — cheap to avoid, awkward to retrofit.
 */
function nonceMatches(a: unknown, b: unknown): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false
  if (a.length !== b.length || a.length === 0) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

export const oauthController = new Elysia({ prefix: '/oauth' })
  .use(AuthService)
  .get(
    '/:provider',
    async ({ params: { provider }, query, cookie, set }) => {
      if (!VALID_PROVIDERS.includes(provider)) {
        set.status = 400
        return { message: `Unknown provider: ${provider}` }
      }

      const orgSlug = (query as any).org_slug
      const mode = (query as any).mode || 'login'
      const inviteCode = (query as any).invite_code || undefined

      if (mode === 'login' && !orgSlug) {
        set.status = 400
        return { message: 'org_slug query parameter is required for login' }
      }

      /**
       * FR-14.14 — a desktop shell started this flow in the system browser.
       *
       * ⚠ The shell intercepts THIS route, not the provider page. The S-04 fix binds `state` to
       * an `oauth_state` cookie in the browser that began the flow, so the whole handshake has
       * to run in one browser; intercepting later would leave the cookie in the webview and the
       * handshake outside it.
       *
       * Both parameters must be present or neither counts — a `desktop=` with no challenge
       * would produce a code redeemable without a verifier, which is the hijack this exists to
       * prevent.
       */
      const desktopId = (query as any).desktop
      const codeChallenge = (query as any).code_challenge
      const desktop =
        typeof desktopId === 'string' && desktopId &&
        typeof codeChallenge === 'string' && codeChallenge.length >= 43
          ? { desktopId, codeChallenge }
          : undefined

      try {
        // The nonce is minted HERE so the same value can go into both the state (which travels
        // through the provider) and a cookie (which does not). The callback completing proves
        // only that someone finished a flow; the two matching proves it was this browser that
        // started it — which is the claim `state` is supposed to carry and never did.
        const nonce = randomUUID()
        const authUrl = buildAuthUrl(provider, orgSlug, mode, nonce, inviteCode, desktop)
        cookie[STATE_COOKIE]?.set({ value: nonce, ...stateCookieOptions })
        return Response.redirect(authUrl, 302)
      } catch (err: any) {
        set.status = 400
        return { message: err.message }
      }
    },
  )
  .get(
    '/callback/:provider',
    async ({ params: { provider }, query, jwt, cookie, set }) => {
      const auth = cookie.auth
      if (!VALID_PROVIDERS.includes(provider)) {
        set.status = 400
        return { message: `Unknown provider: ${provider}` }
      }

      const { code, state } = query as { code?: string; state?: string }
      if (!code || !state) {
        set.status = 400
        return { message: 'Missing code or state parameter' }
      }

      // ⚠ Read the cookie, then clear it, BEFORE anything else can return. The nonce is
      // single-use: leaving it set after a failed attempt lets the same state be replayed,
      // and clearing it only on the success path is how that happens by accident.
      const expectedNonce = cookie[STATE_COOKIE]?.value
      cookie[STATE_COOKIE]?.remove()

      try {
        const { orgSlug, mode, nonce, inviteCode, desktopId, codeChallenge } = parseState(state)

        // The CSRF check. An attacker can craft `state` freely — it round-trips through the
        // victim's browser — but cannot set this cookie on our origin, so a callback they
        // induced carries a state whose nonce matches nothing the victim's browser holds.
        // Without this the callback completed for anybody and logged the victim into whatever
        // account the attacker had obtained a `code` for.
        if (!nonceMatches(nonce, expectedNonce)) {
          return Response.redirect(
            `${config.oauth.frontendUrl}/auth/login?error=${encodeURIComponent('This sign-in link has expired or was not started here. Please try again.')}`,
            302,
          )
        }

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

        const { user } = await getOrCreateUser(userInfo, orgSlug!, inviteCode)

        /**
         * FR-14.14 — the DESKTOP branch, taken before anything browser-shaped happens.
         *
         * The browser that ran this handshake is the system browser, not the app's window
         * (Google refuses sign-in inside embedded webviews it detects, and which ones it
         * detects changes without notice), so the result goes back over the `lgr://` scheme.
         *
         * ⚠ A CODE, never a JWT. The code is useless without the verifier the shell has held
         * throughout, so a program that hijacks the scheme learns nothing it can redeem
         * (RFC 8252).
         *
         * ⚠ And NO `auth` cookie — which is why this returns before the block below sets one.
         * The cookie would belong to whichever browser finished the flow, and that browser is
         * not where the user will be working: it would leave the shop's account signed in on a
         * machine nobody is watching. The desktop's own session is established by the redeem,
         * inside `lgr-web`.
         */
        if (desktopId && codeChallenge) {
          const desktopCode = await createDesktopHandoff(user, desktopId, codeChallenge)
          return Response.redirect(`lgr://login?code=${encodeURIComponent(desktopCode)}`, 302)
        }

        // ⚠ The JWT does NOT go in the redirect URL. It used to, and the view stored whatever
        // `?token=` it was handed — so `…/auth/oauth-callback?token=<attacker's JWT>` signed the
        // visitor into the attacker's account. FR-14.24 could not close it here, because this is
        // the one route whose `token` parameter means something else and had to be exempted.
        //
        // The claims go into a one-time record instead, and its code into an httpOnly cookie
        // that an attacker cannot set on our origin. So there is nothing left to plant: a
        // hand-crafted `/auth/oauth-callback` URL now carries no credential at all.
        const token: string = await jwt.sign({ ...(user as any), exp: Math.floor(Date.now() / 1000) + 24 * 60 * 60 })
        auth.set({
          value: token,
          httpOnly: true,
          secure: process.env.NODE_ENV === 'production',
          sameSite: 'lax',
          maxAge: 7 * 86400,
          path: '/',
        })

        const handoffCode = await createLoginHandoff(user)
        cookie[HANDOFF_COOKIE]?.set({ value: handoffCode, ...handoffCookieOptions })

        return Response.redirect(`${config.oauth.frontendUrl}/auth/oauth-callback`, 302)
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

        const token: string = await jwt.sign({ ...(user as any), exp: Math.floor(Date.now() / 1000) + 24 * 60 * 60 })
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
