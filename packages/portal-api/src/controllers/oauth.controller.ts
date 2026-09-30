import { Elysia, t } from 'elysia'
import { randomUUID } from 'crypto'
import { AuthService } from '../auth/auth.service.js'
import {
  buildAuthUrl,
  exchangeCodeForToken,
  fetchUserInfo,
  getOrCreateUser,
  parseState,
  createLoginHandoff,
  createPendingRegistration,
  readPendingRegistration,
  registerWithPendingRegistration,
  PENDING_REGISTRATION_REFUSED,
} from 'services/biz/oauth.service'
import {
  HANDOFF_COOKIE,
  handoffCookieOptions,
  PENDING_COOKIE,
  pendingCookieOptions,
} from '../auth/handoff-cookie.js'
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

      try {
        // The nonce is minted HERE so the same value can go into both the state (which travels
        // through the provider) and a cookie (which does not). The callback completing proves
        // only that someone finished a flow; the two matching proves it was this browser that
        // started it — which is the claim `state` is supposed to carry and never did.
        const nonce = randomUUID()
        const authUrl = buildAuthUrl(provider, orgSlug, mode, nonce, inviteCode)
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
        const { orgSlug, mode, nonce, inviteCode } = parseState(state)

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
          // ⚠ No credential in this redirect either. It used to be
          // `/auth/register?oauth_token=<JWT>`, and the register form posted back whatever token
          // its URL held — so a planted register link had the visitor create an org and an admin
          // account on the ATTACKER's provider identity (security review S-19). The identity goes
          // into a one-time record and its code into an httpOnly cookie, as the sign-in handoff
          // below does. `?oauth=1` is only a hint that tells the form to ask for its prefill.
          const pendingCode = await createPendingRegistration(userInfo)
          cookie[PENDING_COOKIE]?.set({ value: pendingCode, ...pendingCookieOptions })
          return Response.redirect(`${config.oauth.frontendUrl}/auth/register?oauth=1`, 302)
        }

        const { user } = await getOrCreateUser(userInfo, orgSlug!, inviteCode)

        const token: string = await jwt.sign({ ...(user as any), exp: Math.floor(Date.now() / 1000) + 24 * 60 * 60 })
        auth.set({
          value: token,
          httpOnly: true,
          secure: process.env.NODE_ENV === 'production',
          sameSite: 'lax',
          maxAge: 7 * 86400,
          path: '/',
        })

        // ⚠ The JWT does NOT go in the redirect URL. It used to, and the view stored whatever
        // `?token=` it was handed — so `…/auth/oauth-callback?token=<attacker's JWT>` signed the
        // visitor into the attacker's account. FR-14.24 could not close it here, because this is
        // the one route whose `token` parameter means something else and had to be exempted.
        //
        // The claims go into a one-time record instead, and its code into an httpOnly cookie
        // that an attacker cannot set on our origin. So there is nothing left to plant: a
        // hand-crafted `/auth/oauth-callback` URL now carries no credential at all.
        const handoffCode = await createLoginHandoff(user)
        cookie[HANDOFF_COOKIE]?.set({ value: handoffCode, ...handoffCookieOptions })

        return Response.redirect(`${config.oauth.frontendUrl}/auth/oauth-callback`, 302)
      } catch (err: any) {
        return Response.redirect(`${config.oauth.frontendUrl}/auth/login?error=${encodeURIComponent(err.message)}`, 302)
      }
    },
  )
  /**
   * The register form's prefill: who is signing up, read through the `oauth_pending` cookie the
   * callback set in register mode.
   *
   * Reading does not use the code (the form may be reloaded), and the provider id is not
   * returned: nothing the form shows is a credential.
   *
   * ⚠ It answers **400**, never 401, when no sign-up is in progress, for the reason
   * `POST /api/auth/oauth-code/redeem` gives: a 401 from a public route reads as the auth guard
   * having bitten.
   */
  .get('/pending', async ({ cookie, set }) => {
    try {
      return await readPendingRegistration(cookie[PENDING_COOKIE]?.value)
    } catch {
      set.status = 400
      return { message: PENDING_REGISTRATION_REFUSED }
    }
  })
  /**
   * Finish an OAuth sign-up. It replaced `POST /api/oauth/register-oauth`, which took the
   * provider identity from an `oauth_pending` JWT in the request body — a token the register form
   * had read out of its own URL, so whoever wrote the URL chose whose account got created.
   *
   * ## What authorises it
   *
   * The `oauth_pending` cookie, and nothing in the body. The body says WHAT to create (org name,
   * slug, username); the record the cookie names says WHO for. An attacker cannot set that cookie
   * on our origin, so a planted register link has nothing to offer here.
   *
   * ⚠ The cookie is cleared when the sign-up COMPLETES, not on every path as the sign-in
   * handoff's is. A sign-up refused for a taken slug or username has to be resubmittable from the
   * same form; single use is enforced on the record, by a conditional claim that a failed sign-up
   * releases (`registerWithPendingRegistration`).
   *
   * The session cookie is set exactly as the sign-in handoff sets it. The endpoint this replaced
   * set it without `secure` or `sameSite`, and for 7 days around a 24-hour token.
   */
  .post(
    '/pending/register',
    async ({ jwt, body, cookie, set }) => {
      try {
        const { user } = await registerWithPendingRegistration(
          cookie[PENDING_COOKIE]?.value,
          body.orgName,
          body.orgSlug,
          body.username,
        )
        // Cleared WITH the path it was set on. Elysia's `remove()` sends no Path, so the browser
        // applies the request's default path, and a cookie of the same name on another path is
        // another cookie: the removal would only work while this route stays one level below it.
        cookie[PENDING_COOKIE]?.set({ ...pendingCookieOptions, value: '', maxAge: 0, expires: new Date(0) })

        const ttl = 24 * 60 * 60
        const token: string = await jwt.sign({ ...(user as any), exp: Math.floor(Date.now() / 1000) + ttl })
        cookie.auth.set({
          value: token,
          httpOnly: true,
          secure: process.env.NODE_ENV === 'production',
          sameSite: 'lax',
          maxAge: ttl,
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
        orgName: t.String({ minLength: 2 }),
        orgSlug: t.String({ minLength: 2 }),
        username: t.String({ minLength: 3 }),
      }),
    },
  )
