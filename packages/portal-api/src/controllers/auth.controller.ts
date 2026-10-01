import { Elysia, t } from 'elysia'
import { AuthService } from '../auth/auth.service.js'
import { register, login, tokenize } from 'services/biz/auth.service'
import {
  redeemLoginHandoff,
  redeemDesktopHandoff,
  HandoffError,
  HANDOFF_REFUSED,
} from 'services/biz/oauth.service'
import { HANDOFF_COOKIE } from '../auth/handoff-cookie.js'
import { orgDao } from 'services/dao/org.dao'
import { User } from 'db/models'
import { codeDao } from 'services/dao/code.dao'
import { sendEmail } from 'services/biz/email.service'
import { createAuditEntry } from 'services/biz/audit-log.service'
import { config } from 'config'

export const authController = new Elysia({ prefix: '/auth' })
  .use(AuthService)
  .post(
    '/register',
    async ({ body, set }) => {
      try {
        const { org, user, activationToken } = await register(body)

        return {
          message: 'Registration successful. Please check your email to activate your account.',
          org: { id: String(org._id), name: org.name, slug: org.slug },
          userId: String(user._id),
          activationToken,
        }
      } catch (err: any) {
        set.status = 400
        return { message: err.message }
      }
    },
    {
      body: t.Object({
        orgName: t.Optional(t.String({ minLength: 2 })),
        orgSlug: t.Optional(t.String({ minLength: 2 })),
        email: t.String({ format: 'email' }),
        username: t.String({ minLength: 3 }),
        password: t.String({ minLength: 6 }),
        firstName: t.String({ minLength: 1 }),
        middleName: t.Optional(t.String()),
        lastName: t.String({ minLength: 1 }),
        baseCurrency: t.Optional(t.String()),
        locale: t.Optional(t.String()),
        inviteCode: t.Optional(t.String()),
      }),
    },
  )
  .post(
    '/login',
    async ({ jwt, body, cookie: { auth }, set }) => {
      try {
        const { user, org } = await login(body)

        const ttl = 24 * 60 * 60
        const token: string = await jwt.sign({ ...user, exp: Math.floor(Date.now() / 1000) + ttl })
        auth.set({
          value: token,
          httpOnly: true,
          secure: process.env.NODE_ENV === 'production',
          sameSite: 'lax',
          maxAge: ttl,
          path: '/',
        })

        // Audit: login event (Appendix 29 requirement)
        createAuditEntry({
          orgId: user.orgId,
          userId: user.id,
          operatorCode: user.operatorCode,
          action: 'login',
          module: 'auth',
          entityType: 'user',
          entityId: user.id,
          entityName: `${user.firstName} ${user.lastName}`,
        })

        return {
          user,
          token,
          org: { id: String(org._id), name: org.name, slug: org.slug },
        }
      } catch (err: any) {
        set.status = 401
        return { message: err.message }
      }
    },
    {
      body: t.Object({
        username: t.String(),
        password: t.String(),
        orgSlug: t.String(),
      }),
    },
  )
  .post(
    '/activate',
    async ({ body: { userId, token }, set }) => {
      try {
        const code = await codeDao.findActivationCode(userId, token)
        if (!code) {
          set.status = 400
          return { message: 'Invalid or expired activation token' }
        }

        const user = await User.findById(userId)
        if (!user) {
          set.status = 404
          return { message: 'User not found' }
        }

        user.isActive = true
        await user.save()
        await codeDao.deleteForUser(userId)

        // Send success email (non-fatal)
        await sendEmail({
          to: user.email,
          subject: 'Your LGR account is active',
          html: `<div style="font-family: sans-serif; max-width: 600px; margin: 0 auto;">
<h2>Account activated, ${user.firstName}!</h2>
<p>Your LGR account is now active. <a href="${config.email.appUrl}/auth/login">Sign in here</a>.</p>
</div>`,
        }).catch(err => console.warn('Failed to send activation success email:', err))

        return { message: 'Account activated successfully. You can now sign in.' }
      } catch (err: any) {
        set.status = 400
        return { message: err.message }
      }
    },
    {
      body: t.Object({
        userId: t.String(),
        token: t.String({ minLength: 7, maxLength: 7 }),
      }),
    },
  )
  /**
   * Finish an OAuth sign-in. The other half of `GET /api/oauth/callback/:provider`.
   *
   * ## Why the browser has to ask for this
   *
   * The callback sets the `auth` cookie, but the SPAs treat a browser as signed in only when
   * `localStorage.lgr_token` is set (portal-ui `router/index.ts`) and send it as a bearer header
   * (`useHttpClient`). So the token has to reach JavaScript. It used to do that by riding in the
   * redirect URL, which made `…/auth/oauth-callback?token=<attacker's JWT>` a working login for
   * somebody else's account. FR-14.24 closed that pattern everywhere except here, because this
   * is the route whose `token` parameter meant something else.
   *
   * ## Why nothing can be planted now
   *
   * **The request body is empty.** The credential is the `oauth_handoff` cookie, which an
   * attacker cannot set on our origin — so a hand-crafted URL carries nothing to redeem. The
   * cookie is consumed here whatever the outcome, and the server-side record is single use.
   *
   * ⚠ It answers **400**, never 401, when there is nothing to redeem. A 401 from a public route
   * is indistinguishable from the auth guard having bitten, which is exactly what
   * `anonymous-access.flow.test.ts` probes for — and semantically this is "no sign-in in
   * progress", not "your credentials were rejected".
   */
  .post('/oauth-code/redeem', async ({ jwt, cookie, set }) => {
    const code = cookie[HANDOFF_COOKIE]?.value
    // Clear it BEFORE anything can return, on every path. Leaving it set after a failure lets
    // the same code be retried, and clearing it only on success is how that happens by accident
    // — the same trap the `oauth_state` nonce is written down for.
    cookie[HANDOFF_COOKIE]?.remove()

    try {
      const { user, org } = await redeemLoginHandoff(code)

      const ttl = 24 * 60 * 60
      const token: string = await jwt.sign({ ...user, exp: Math.floor(Date.now() / 1000) + ttl })
      cookie.auth.set({
        value: token,
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        maxAge: ttl,
        path: '/',
      })

      // Audit: login event (Appendix 29 requirement). An OAuth sign-in was never recorded — only
      // `POST /auth/login` was — so the audit log showed no login for anyone using Google.
      createAuditEntry({
        orgId: user.orgId,
        userId: user.id,
        operatorCode: user.operatorCode,
        action: 'login',
        module: 'auth',
        entityType: 'user',
        entityId: user.id,
        entityName: `${user.firstName} ${user.lastName}`,
      })

      return { user, token, org: { id: String(org._id), name: org.name, slug: org.slug } }
    } catch (err: any) {
      set.status = 400
      return { message: err instanceof HandoffError ? err.message : HANDOFF_REFUSED }
    }
  })
  /**
   * FR-14.14 — the desktop's half of the OAuth sign-in.
   *
   * ⚠ The body carries the code AND the verifier, and both are required. The code arrived over
   * `lgr://login`, a scheme any program on the machine can register; the verifier never left the
   * shell until it put it in a URL FRAGMENT, which no server and no log ever sees. So a program
   * that hijacks the deep link holds a code it cannot redeem (RFC 8252's PKCE principle).
   *
   * ⚠ It answers exactly as `/auth/login` does — the `auth` cookie AND `{ token, user, org }` in
   * the body — because the SPAs treat a browser as signed in only when `localStorage.lgr_token`
   * is set and send it as a bearer header. A cookie alone would leave `lgr-web` looking signed
   * out to its own router.
   *
   * ⚠ 400, never 401, for the same reason the browser redeem gives: a 401 from a public route is
   * indistinguishable from the auth guard having bitten, which `anonymous-access.flow.test.ts`
   * probes for — and this is "that sign-in is not redeemable", not "your credentials failed".
   */
  .post(
    '/desktop-code/redeem',
    async ({ jwt, cookie, body, set }) => {
      try {
        const { user, org } = await redeemDesktopHandoff(body.code, body.verifier)

        const ttl = 24 * 60 * 60
        const token: string = await jwt.sign({ ...user, exp: Math.floor(Date.now() / 1000) + ttl })
        cookie.auth.set({
          value: token,
          httpOnly: true,
          secure: process.env.NODE_ENV === 'production',
          sameSite: 'lax',
          maxAge: ttl,
          path: '/',
        })

        // Appendix 29 requires a login event, and a desktop OAuth sign-in is a login.
        createAuditEntry({
          orgId: user.orgId,
          userId: user.id,
          operatorCode: user.operatorCode,
          action: 'login',
          module: 'auth',
          entityType: 'user',
          entityId: user.id,
          entityName: `${user.firstName} ${user.lastName}`,
        })

        return { user, token, org: { id: String(org._id), name: org.name, slug: org.slug } }
      } catch (err: any) {
        set.status = 400
        return { message: err instanceof HandoffError ? err.message : HANDOFF_REFUSED }
      }
    },
    {
      body: t.Object({
        code: t.String({ minLength: 20, maxLength: 200 }),
        // RFC 7636 puts the floor at 43 characters; the shell sends 43 (32 random bytes,
        // base64url). Anything shorter is not a verifier anyone generated correctly.
        verifier: t.String({ minLength: 43, maxLength: 200 }),
      }),
    },
  )
  .post('/logout', async ({ cookie: { auth }, user }) => {
    // Audit: logout event (Appendix 29 requirement)
    if (user) {
      createAuditEntry({
        orgId: user.orgId,
        userId: user.id,
        operatorCode: user.operatorCode,
        action: 'logout',
        module: 'auth',
        entityType: 'user',
        entityId: user.id,
        entityName: `${user.firstName} ${user.lastName}`,
      })
    }
    auth.remove()
    return { message: 'Logged out' }
  })
  .get('/me', async ({ user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })

    const org = await orgDao.findById(user.orgId)

    return {
      user,
      org: org
        ? {
            id: String(org._id),
            name: org.name,
            slug: org.slug,
            taxNumber: (org as any).taxNumber || undefined,
            vatNumber: (org as any).vatNumber || undefined,
            email: (org as any).email || undefined,
            phone: (org as any).phone || undefined,
            website: (org as any).website || undefined,
            addresses: (org as any).addresses || [],
            bankDetails: (org as any).bankDetails || [],
            settings: (org as any).settings || undefined,
          }
        : null,
    }
  }, { isSignIn: true })
