import { Elysia, t } from 'elysia'
import { randomUUID } from 'crypto'
import { AuthService } from '../auth/auth.service.js'
import {
  buildAuthUrl,
  configuredProviders,
  exchangeCodeForToken,
  fetchUserInfo,
  getOrCreateUser,
  inviteOrgSlug,
  signInWithOAuth,
  OAuthSignInError,
  parseState,
  createLoginHandoff,
  createDesktopHandoff,
  desktopOrgSlug,
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
import { sessionCookie, SESSION_TTL_SECONDS } from '../auth/session-cookie.js'
import { IdentityError, emailInUse } from 'services/biz/identity/identity.service'
import { identityClaims, type IdentityClaims } from 'services/biz/identity/session.service'
import type { UserTokenized } from 'services/biz/auth.service'
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
  /**
   * Which sign-in buttons the login page shows: the providers this deployment has credentials
   * for. Public (it is asked before anyone signs in), and registered BEFORE `/:provider` so the
   * word is never taken for a provider name.
   */
  .get('/providers', () => ({ providers: configuredProviders() }))
  .get(
    '/:provider',
    async ({ params: { provider }, query, cookie, set }) => {
      if (!VALID_PROVIDERS.includes(provider)) {
        set.status = 400
        return { message: `Unknown provider: ${provider}` }
      }

      let orgSlug = (query as any).org_slug
      const mode = (query as any).mode || 'login'
      const inviteCode = (query as any).invite_code || undefined
      // Multi-org (Phase 2): a sign-in no longer needs an org. Without one, the provider account
      // names a person, who lands where they chose before (`prefer`: this browser's last org) or
      // picks. A string, or nothing: it only ever chooses among the person's own memberships.
      const prefer = typeof (query as any).prefer === 'string' ? (query as any).prefer.slice(0, 64) : undefined

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

      // A desktop is enrolled in ONE org and signs in to it: it cannot show an org picker.
      // ⚠ Since multi-org sign-in the login page sends `org_slug` only when its org field was
      // opened, so the org comes from the desktop's own registration when the page names none.
      // Without this every desktop provider sign-in answered the 400 below (prod, 2026-10-14).
      if (desktop && mode === 'login' && !orgSlug) {
        orgSlug = await desktopOrgSlug(desktop.desktopId)
        if (!orgSlug) {
          set.status = 400
          return { message: 'org_slug query parameter is required for a desktop sign-in' }
        }
      }

      try {
        // The nonce is minted HERE so the same value can go into both the state (which travels
        // through the provider) and a cookie (which does not). The callback completing proves
        // only that someone finished a flow; the two matching proves it was this browser that
        // started it — which is the claim `state` is supposed to carry and never did.
        const nonce = randomUUID()
        const authUrl = buildAuthUrl(provider, orgSlug, mode, nonce, inviteCode, desktop, prefer)
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
        const { orgSlug, mode, nonce, inviteCode, desktopId, codeChallenge, prefer } = parseState(state)

        // The CSRF check. An attacker can craft `state` freely — it round-trips through the
        // victim's browser — but cannot set this cookie on our origin, so a callback they
        // induced carries a state whose nonce matches nothing the victim's browser holds.
        // Without this the callback completed for anybody and logged the victim into whatever
        // account the attacker had obtained a `code` for.
        if (!nonceMatches(nonce, expectedNonce)) {
          return Response.redirect(`${config.oauth.frontendUrl}/auth/login?error=state_mismatch`, 302)
        }

        const accessToken = await exchangeCodeForToken(provider, code)
        const userInfo = await fetchUserInfo(provider, accessToken)

        if (!userInfo.email) {
          set.status = 400
          return { message: 'Could not retrieve email from OAuth provider' }
        }

        if (mode === 'register') {
          // Multi-org: a sign-up founds a person on this address. Refused here, before any form,
          // when the provider did not verify it (Microsoft, Facebook: an address nobody proved) or
          // when it already has an account (that person signs in, then founds the org as themselves).
          if (!userInfo.emailVerified) throw new IdentityError('unverified_email')
          if (await emailInUse(userInfo.email)) throw new IdentityError('account_exists')

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

        // Who this is, and where they land:
        //   - `org_slug` (the old UI, a desktop): that org's member, exactly as before;
        //   - an invitation without an org: the invite names the org, and the person joins it;
        //   - neither (multi-org Phase 2): the provider account names a PERSON, who lands where
        //     they chose before or picks (an identity-only result, which is not a session).
        let user: UserTokenized | undefined
        let person: IdentityClaims | undefined
        if (orgSlug) {
          ;({ user } = await getOrCreateUser(userInfo, orgSlug, inviteCode))
        } else if (inviteCode) {
          ;({ user } = await getOrCreateUser(userInfo, await inviteOrgSlug(inviteCode), inviteCode))
        } else {
          const result = await signInWithOAuth(userInfo, { prefer })
          if (result.kind === 'session') user = result.user
          else person = identityClaims(result.identity)
        }

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
          // The start endpoint requires `org_slug` for a desktop, so there is always a session here.
          if (!user) throw new Error('A desktop sign-in needs an organization')
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
        if (user) {
          const token: string = await jwt.sign({ ...(user as any), exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS })
          auth.set(sessionCookie(token))
        }
        // An identity-only result sets no cookie: it is not a session, and must not replace the
        // cookie another tab's session uses. The SPA receives it through the handoff alone.
        const handoffCode = await createLoginHandoff(user ?? person!)
        cookie[HANDOFF_COOKIE]?.set({ value: handoffCode, ...handoffCookieOptions })

        return Response.redirect(`${config.oauth.frontendUrl}/auth/oauth-callback`, 302)
      } catch (err: any) {
        // A CODE, never the message: the login page translates known codes and shows a generic
        // line for anything else, so a crafted link cannot put arbitrary text on our sign-in page.
        // The message itself is for the log.
        const known = err instanceof OAuthSignInError || err instanceof IdentityError
        if (!known) console.warn('OAuth sign-in failed:', err?.message)
        return Response.redirect(`${config.oauth.frontendUrl}/auth/login?error=${known ? err.code : 'oauth_failed'}`, 302)
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

        const ttl = SESSION_TTL_SECONDS
        const token: string = await jwt.sign({ ...(user as any), exp: Math.floor(Date.now() / 1000) + ttl })
        cookie.auth.set(sessionCookie(token))

        return { user, token, org: { id: user.orgId, name: body.orgName, slug: body.orgSlug } }
      } catch (err: any) {
        if (err instanceof IdentityError) {
          set.status = err.status
          return { message: err.message, code: err.code }
        }
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
