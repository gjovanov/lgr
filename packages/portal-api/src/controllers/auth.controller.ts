import { Elysia, t } from 'elysia'
import { AuthService } from '../auth/auth.service.js'
import {
  register,
  login,
  sessionFor,
  tokenize,
  resendActivation,
  LoginRefusedError,
  INVALID_CREDENTIALS,
  type SessionUser,
} from 'services/biz/auth.service'
import { identityClaims, membershipsOf, type Membership } from 'services/biz/identity/session.service'
import {
  BEARER_REQUIRED,
  NOT_A_PERSON,
  auditSignIn,
  bearerPresent,
  callerOf,
  enterOrg,
  orgList,
  personSummary,
} from '../auth/session-answer.js'
import {
  changePassword,
  createOrgForPerson,
  requestPasswordReset,
  resetPassword,
} from 'services/biz/identity/account.service'
import {
  loginRetryAfterSeconds,
  recordLoginFailure,
  clearLoginFailures,
  passwordResetRetryAfterSeconds,
  recordPasswordResetRequest,
} from 'services/biz/login-throttle.service'
import { clientIp } from '../auth/client-ip.js'
import { IdentityError, completeActivation } from 'services/biz/identity/identity.service'
import {
  redeemLoginHandoff,
  redeemDesktopHandoff,
  HandoffError,
  HANDOFF_REFUSED,
} from 'services/biz/oauth.service'
import { OAUTH_HANDOFF, readFlowCookie, clearFlowCookie } from '../auth/oauth-cookies.js'
import { setSessionCookie, clearSessionCookie, SESSION_TTL_SECONDS } from '../auth/session-cookie.js'
import { orgDao } from 'services/dao/org.dao'
import { Identity, Invite, Org, User, settingsForClient, type IIdentity } from 'db/models'
import { codeDao } from 'services/dao/code.dao'
import { sendEmail } from 'services/biz/email.service'
import { createAuditEntry } from 'services/biz/audit-log.service'
import { config } from 'config'

/** Open invitations pinned to this address, with their org: what the person may join. */
async function invitationsFor(email: string) {
  const invites = await Invite.find({
    targetEmail: email,
    status: 'active',
    $or: [{ expiresAt: null }, { expiresAt: { $gt: new Date() } }],
  })
    .collation({ locale: 'en', strength: 2 })
    .lean()
    .exec()
  const orgs = await Org.find({ _id: { $in: invites.map(i => i.orgId) } }, { name: 1, slug: 1 }).lean().exec()
  const byId = new Map(orgs.map(o => [String(o._id), o]))
  return invites
    .filter(i => byId.has(String(i.orgId)))
    .map(i => ({
      code: i.code,
      orgId: String(i.orgId),
      name: byId.get(String(i.orgId))!.name,
      slug: byId.get(String(i.orgId))!.slug,
      role: i.assignRole,
      expiresAt: i.expiresAt,
    }))
}

export const authController = new Elysia({ prefix: '/auth' })
  .use(AuthService)
  .post(
    '/register',
    async ({ body, set }) => {
      try {
        // ⚠ S-06: the activation code is NOT in this response. It used to be, which let whoever
        // registered activate without the email — so the email proved nothing. It reaches the
        // person only by mail; an expired link is replaced through `/activate/resend`.
        const { org, user } = await register(body)

        return {
          message: 'Registration successful. Please check your email to activate your account.',
          org: { id: String(org._id), name: org.name, slug: org.slug },
          userId: String(user._id),
        }
      } catch (err: any) {
        if (err instanceof IdentityError) {
          // `account_exists`: this address already has an account. The UI sends them to sign in.
          set.status = err.status
          return { message: err.message, code: err.code }
        }
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
    async ({ jwt, body, cookie, set, headers }) => {
      // S-08 — refuse a locked-out guesser BEFORE any argon2 work, and count only failures.
      const attempt = { orgSlug: body.orgSlug, username: body.username, ip: clientIp(headers) }
      // A throttle that cannot be read fails OPEN: an outage of this table must not lock everyone out.
      const retryAfter = await loginRetryAfterSeconds(attempt).catch(e => {
        console.warn('Login throttle read failed:', e)
        return 0
      })
      if (retryAfter > 0) {
        set.status = 429
        set.headers['retry-after'] = String(retryAfter)
        return {
          message: `Too many sign-in attempts. Try again in ${Math.ceil(retryAfter / 60)} minute(s).`,
          code: 'too_many_attempts',
          retryAfterSeconds: retryAfter,
        }
      }

      try {
        const result = await login(body)
        await clearLoginFailures(attempt).catch(e => console.warn('Login throttle clear failed:', e))
        const exp = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS

        if (result.kind === 'choose') {
          // Signed in as a person, in no org yet (rule 5: nothing to land in that they chose). The
          // token names the person and reaches the identity routes only. No cookie: it is not a
          // session, and must never replace the cookie another tab's session uses.
          const token: string = await jwt.sign({ ...identityClaims(result.identity), exp })
          return {
            token,
            needsOrgChoice: true,
            orgs: orgList(result.memberships),
            identity: personSummary(result.identity),
          }
        }

        const { user, org } = result
        const token: string = await jwt.sign({ ...user, exp })
        setSessionCookie(cookie, token)
        auditSignIn(user, 'password')

        return {
          user,
          token,
          org: { id: String(org._id), name: org.name, slug: org.slug },
          orgs: orgList(result.memberships, user.orgId),
          needsOrgChoice: false,
        }
      } catch (err: any) {
        set.status = 401
        if (err instanceof LoginRefusedError) {
          // Several people use this username: ask for the email or the org. Nothing was checked
          // against anyone's password, so it is not a failure to count.
          if (err.code === 'ambiguous_login') set.status = 409
          // Only a wrong password counts. `not_activated` / `disabled` are said to someone who just
          // proved the password, and charging those to the throttle would lock out a real owner.
          if (err.code === 'invalid_credentials') {
            await recordLoginFailure(attempt).catch(e => console.warn('Login throttle write failed:', e))
          }
          return { message: err.message, code: err.code }
        }
        // Anything else is ours, not the caller's: say no more than a wrong password would.
        console.warn('Login failed unexpectedly:', err)
        return { message: INVALID_CREDENTIALS, code: 'invalid_credentials' }
      }
    },
    {
      body: t.Object({
        // A username or an email address.
        username: t.String(),
        password: t.String(),
        // The legacy org path (scripts, the pre-identity UI). Without it, the person is signed in
        // and lands in an org they chose before, or chooses (`needsOrgChoice`).
        orgSlug: t.Optional(t.String()),
        // The org this browser was last in; honoured only if it is one of the person's.
        preferredOrgId: t.Optional(t.String()),
      }),
    },
  )
  /**
   * The signed-in person's orgs, and the invitations waiting for their address. Reachable with an
   * org session or with the identity-only token a sign-in gives someone who has not chosen yet.
   */
  .get('/orgs', async ({ user, person, status }) => {
    const iid = user?.iid ?? person?.iid
    if (!iid) {
      if (!user) return status(401, { message: 'Unauthorized' })
      // A session that names no person: a membership the migration has not linked, or a token
      // issued before it was. Its org is all it has; it carries no `tv` to be revoked by, so it
      // must not mint sessions in other orgs. The next sign-in names the person.
      const org = await orgDao.findById(user.orgId)
      return {
        orgs: org ? [{ orgId: user.orgId, name: org.name, slug: org.slug, role: user.role, current: true }] : [],
        invitations: [],
      }
    }
    const identity = await Identity.findById(iid, { email: 1 }).lean().exec()
    return {
      orgs: orgList(await membershipsOf(iid), user?.orgId),
      invitations: identity ? await invitationsFor(identity.email) : [],
    }
  })
  /**
   * Enter one of the person's orgs. The answer is an ordinary org session for that membership:
   * the tenant guard and every permission check work on it exactly as on a sign-in's.
   *
   * ⚠ Bearer only (rule 7): the switch must be what this tab's token asked for, never what a stale
   * cookie named. ⚠ It never extends a session: the new token ends when the one it came from does.
   */
  .post(
    '/switch',
    async ({ jwt, body, user, person, headers, cookie, status }) => {
      if (!bearerPresent(headers.authorization)) return status(401, BEARER_REQUIRED)
      const caller = callerOf(user, person)
      if (!caller?.iid) return status(403, NOT_A_PERSON)

      const member = await User.findOne({ identityId: caller.iid, orgId: body.orgId, isActive: true }).exec()
      const identity = member ? await Identity.findById(caller.iid, { tokenVersion: 1 }).exec() : null
      if (!member || !identity) {
        return status(403, { message: 'You are not a member of that organization.', code: 'not_a_member' })
      }
      return enterOrg({ jwt, cookie }, member, identity, caller.exp, 'switch')
    },
    { body: t.Object({ orgId: t.String({ minLength: 1 }) }) },
  )
  /**
   * Change the password, proving the current one (Phase 4). It becomes the person's own
   * (`passwordSetBy: self`, which is what rule 3 asks before joining or founding another org) and
   * every other session they hold ends. This tab gets a fresh token for where it is, ending when
   * the old one would have. Wrong current passwords count against the sign-in throttle: a stolen
   * session must not be a way to guess the password at leisure.
   */
  .post(
    '/password',
    async ({ jwt, body, user, person, headers, cookie, status }) => {
      if (!bearerPresent(headers.authorization)) return status(401, BEARER_REQUIRED)
      const caller = callerOf(user, person)
      if (!caller?.iid) return status(403, NOT_A_PERSON)

      const attempt = { orgSlug: '#password', username: caller.iid, ip: clientIp(headers) }
      const retryAfter = await loginRetryAfterSeconds(attempt).catch(() => 0)
      if (retryAfter > 0) {
        return status(429, { message: 'Too many attempts. Try again later.', code: 'too_many_attempts', retryAfterSeconds: retryAfter })
      }
      try {
        const identity = await changePassword(caller.iid, body.currentPassword, body.newPassword)
        await clearLoginFailures(attempt).catch(() => undefined)
        const exp = caller.exp ?? Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS
        if (user) {
          const member = await User.findById(user.id).exec()
          if (!member) return status(401, { message: 'Unauthorized' })
          const claims = await sessionFor(member, identity)
          const token: string = await jwt.sign({ ...claims, exp })
          setSessionCookie(cookie, token, Math.max(0, exp - Math.floor(Date.now() / 1000)))
          return { token, user: claims }
        }
        return { token: await jwt.sign({ ...identityClaims(identity), exp }) }
      } catch (err) {
        if (err instanceof IdentityError) {
          if (err.code === 'wrong_password') await recordLoginFailure(attempt).catch(() => undefined)
          return status(err.status, { message: err.message, code: err.code })
        }
        throw err
      }
    },
    {
      body: t.Object({
        currentPassword: t.String({ maxLength: 256 }),
        // S-09: a new password has at least 12 characters.
        newPassword: t.String({ minLength: 12, maxLength: 256 }),
      }),
    },
  )
  /**
   * Forgot password (Phase 4): mail a reset link to the person with this address. The answer is
   * the same whatever the address is, so this cannot be used to learn who has an account; it is
   * limited per address and per IP, in counters of its own (never the sign-in throttle's).
   */
  .post(
    '/password/forgot',
    async ({ body, headers, set }) => {
      const ip = clientIp(headers)
      const retryAfter = await passwordResetRetryAfterSeconds(body.email, ip).catch(() => 0)
      if (retryAfter > 0) {
        set.status = 429
        set.headers['retry-after'] = String(retryAfter)
        return { message: 'Too many requests. Try again later.', code: 'too_many_attempts', retryAfterSeconds: retryAfter }
      }
      await recordPasswordResetRequest(body.email, ip).catch(e => console.warn('Reset throttle write failed:', e))
      await requestPasswordReset(body.email).catch(e => console.warn('Password reset request failed:', e))
      return { message: 'If an account uses this address, a link to choose a new password is on its way.' }
    },
    { body: t.Object({ email: t.String({ format: 'email', maxLength: 254 }) }) },
  )
  /** Use a reset link (the token from its fragment) to choose a new password. */
  .post(
    '/password/reset',
    async ({ body, set }) => {
      try {
        await resetPassword(body.token, body.newPassword)
        return { message: 'Your password is set. You can sign in now.' }
      } catch (err) {
        if (err instanceof IdentityError) {
          set.status = err.status
          return { message: err.message, code: err.code }
        }
        throw err
      }
    },
    {
      body: t.Object({
        token: t.String({ minLength: 20, maxLength: 200 }),
        newPassword: t.String({ minLength: 12, maxLength: 256 }),
      }),
    },
  )
  /**
   * Found an organization as the signed-in person (Phase 4), who becomes its admin, and enter it.
   * Rule 3: needs a credential the person owns. ⚠ Bearer only (rule 7).
   */
  .post(
    '/orgs',
    async ({ jwt, body, user, person, headers, cookie, status }) => {
      if (!bearerPresent(headers.authorization)) return status(401, BEARER_REQUIRED)
      const caller = callerOf(user, person)
      if (!caller?.iid) return status(403, NOT_A_PERSON)
      try {
        const { member } = await createOrgForPerson(caller.iid, body)
        const identity = await Identity.findById(caller.iid, { tokenVersion: 1 }).exec()
        return await enterOrg({ jwt, cookie }, member, identity!, caller.exp, 'new_org')
      } catch (err) {
        if (err instanceof IdentityError) return status(err.status, { message: err.message, code: err.code })
        throw err
      }
    },
    {
      body: t.Object({
        name: t.String({ minLength: 2, maxLength: 100 }),
        slug: t.String({ minLength: 2, maxLength: 50 }),
        baseCurrency: t.Optional(t.String({ maxLength: 3 })),
        locale: t.Optional(t.String({ maxLength: 5 })),
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
        // An admin deactivated this account after the mail went out. Its code must not undo that,
        // and the answer is the same as for a bad code, so the link says nothing about the account.
        if (user.deactivatedAt) {
          set.status = 400
          return { message: 'Invalid or expired activation token' }
        }

        user.isActive = true
        await user.save()
        // The link proved the address: the person behind this membership is live and verified.
        await completeActivation(user)
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
   * S-06 — mail a new activation link to an account still waiting for one.
   *
   * The register response no longer carries the code, so an expired or lost email has to be
   * recoverable from the email alone. The answer is the same whatever the address is (pending,
   * active, deactivated, unknown) and whatever happened to the send, so this cannot be used to
   * find out who has an account. A per-account cooldown is applied in `resendActivation`.
   */
  .post(
    '/activate/resend',
    async ({ body }) => {
      await resendActivation(body.email).catch(err => console.warn('Activation resend failed:', err))
      return {
        message: 'If an account with this email is waiting for activation, a new activation link is on its way.',
      }
    },
    {
      body: t.Object({
        email: t.String({ format: 'email', maxLength: 254 }),
      }),
    },
  )
  /**
   * Finish an OAuth sign-in. The other half of `GET /api/oauth/callback/:provider`.
   *
   * ## Why the browser has to ask for this
   *
   * The callback sets the session cookie, but the SPAs treat a tab as signed in only when it holds
   * a session token (`ui-shared/session`) and send it as a bearer header (`useHttpClient`). So
   * the token has to reach JavaScript. It used to do that by riding in the
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
  .post('/oauth-code/redeem', async ({ jwt, cookie, set, headers }) => {
    const code = readFlowCookie(cookie, OAUTH_HANDOFF, headers)
    // Clear it BEFORE anything can return, on every path. Leaving it set after a failure lets
    // the same code be retried, and clearing it only on success is how that happens by accident
    // — the same trap the `oauth_state` nonce is written down for.
    clearFlowCookie(cookie, OAUTH_HANDOFF)

    try {
      const redeemed = await redeemLoginHandoff(code)
      const exp = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS

      if (redeemed.person) {
        // Signed in as a person with no org chosen (multi-org Phase 2): answered like a password
        // sign-in in the same state, an identity-only token and no cookie.
        const identity = await Identity.findById(redeemed.person.iid).lean().exec()
        if (!identity) throw new HandoffError(HANDOFF_REFUSED)
        const token: string = await jwt.sign({ ...redeemed.person, exp })
        return {
          token,
          needsOrgChoice: true,
          orgs: orgList(await membershipsOf(identity._id)),
          identity: personSummary(identity),
        }
      }

      const { user, org } = redeemed
      const token: string = await jwt.sign({ ...user, exp })
      setSessionCookie(cookie, token)

      // Audit: login event (Appendix 29 requirement). An OAuth sign-in was never recorded — only
      // `POST /auth/login` was — so the audit log showed no login for anyone using Google.
      auditSignIn(user, 'oauth')

      return {
        user,
        token,
        org: { id: String(org._id), name: org.name, slug: org.slug },
        orgs: user.iid
          ? orgList(await membershipsOf(user.iid), user.orgId)
          : [{ orgId: user.orgId, name: org.name, slug: org.slug, role: user.role, current: true }],
        needsOrgChoice: false,
      }
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
   * ⚠ It answers exactly as `/auth/login` does — the session cookie AND `{ token, user, org }` in
   * the body — because the SPAs treat a tab as signed in only when it holds a session token
   * (`ui-shared/session`) and send it as a bearer header. A cookie alone would leave `lgr-web`
   * looking signed out to its own router.
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

        const ttl = SESSION_TTL_SECONDS
        const token: string = await jwt.sign({ ...user, exp: Math.floor(Date.now() / 1000) + ttl })
        setSessionCookie(cookie, token)

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
  .post('/logout', async ({ cookie, user }) => {
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
    clearSessionCookie(cookie)
    return { message: 'Logged out' }
  })
  .get('/me', async ({ user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })

    const org = await orgDao.findById(user.orgId)
    // The person behind this membership, for the account page: never the hash, only whether
    // there is one and who set it.
    const person = user.iid ? await Identity.findById(user.iid).select('+password').lean().exec() : null

    return {
      identity: person
        ? {
            ...personSummary(person),
            emailVerified: person.emailVerified,
            hasPassword: !!person.password,
            passwordSetBy: person.passwordSetBy ?? null,
            providers: (person.oauthProviders ?? []).map(l => ({ provider: l.provider, verified: l.verified })),
          }
        : null,
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
            settings: settingsForClient((org as any).settings) || undefined,
          }
        : null,
    }
  }, { isSignIn: true })
