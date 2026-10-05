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
  loginRetryAfterSeconds,
  recordLoginFailure,
  clearLoginFailures,
} from 'services/biz/login-throttle.service'
import { clientIp } from '../auth/client-ip.js'
import { IdentityError, completeActivation } from 'services/biz/identity/identity.service'
import {
  redeemLoginHandoff,
  redeemDesktopHandoff,
  HandoffError,
  HANDOFF_REFUSED,
} from 'services/biz/oauth.service'
import { HANDOFF_COOKIE } from '../auth/handoff-cookie.js'
import { sessionCookie, SESSION_TTL_SECONDS } from '../auth/session-cookie.js'
import { orgDao } from 'services/dao/org.dao'
import { Identity, Invite, Org, User, type IIdentity } from 'db/models'
import { codeDao } from 'services/dao/code.dao'
import { sendEmail } from 'services/biz/email.service'
import { createAuditEntry } from 'services/biz/audit-log.service'
import { config } from 'config'

/** What the org menu lists: the person's orgs, with their role in each and the current one marked. */
function orgList(memberships: Membership[], currentOrgId?: string) {
  return memberships.map(m => ({
    orgId: m.org.id,
    name: m.org.name,
    slug: m.org.slug,
    role: m.user.role,
    current: m.org.id === currentOrgId,
  }))
}

function personSummary(identity: Pick<IIdentity, '_id' | 'email' | 'firstName' | 'lastName'>) {
  return { id: String(identity._id), email: identity.email, firstName: identity.firstName, lastName: identity.lastName }
}

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

/** A non-empty `Authorization: Bearer …` header (rule 7: some actions refuse a cookie alone). */
const bearerPresent = (authorization?: string) => /^bearer\s+\S/i.test((authorization ?? '').trim())

/** Every way into an org is a sign-in to it (Н-18, Appendix 29), with how it happened. */
function auditSignIn(user: SessionUser, method: 'password' | 'switch' | 'oauth') {
  createAuditEntry({
    orgId: user.orgId,
    userId: user.id,
    operatorCode: user.operatorCode,
    action: 'login',
    module: 'auth',
    entityType: 'user',
    entityId: user.id,
    entityName: `${user.firstName} ${user.lastName}`,
    changes: [{ field: 'method', oldValue: null, newValue: method }],
  })
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
    async ({ jwt, body, cookie: { auth }, set, headers }) => {
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
        auth.set(sessionCookie(token))
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
      // A membership the migration has not linked yet: its org is all it has.
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
    async ({ jwt, body, user, person, headers, cookie: { auth }, status }) => {
      if (!bearerPresent(headers.authorization)) {
        return status(401, { message: 'Switching needs the token this tab holds.', code: 'bearer_required' })
      }
      const caller = (user ?? person) as { iid?: string; exp?: number } | null
      const iid = caller?.iid
      if (!iid) {
        return status(403, {
          message: 'This account is not linked to a person yet; sign in to each organization separately.',
          code: 'not_a_person',
        })
      }
      const member = await User.findOne({ identityId: iid, orgId: body.orgId, isActive: true }).exec()
      const org = member ? await Org.findById(member.orgId).exec() : null
      const identity = member ? await Identity.findById(iid, { tokenVersion: 1 }).exec() : null
      if (!member || !org || !identity) {
        return status(403, { message: 'You are not a member of that organization.', code: 'not_a_member' })
      }

      const claims = await sessionFor(member, identity)
      const exp = caller!.exp ?? Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS
      const token: string = await jwt.sign({ ...claims, exp })
      auth.set(sessionCookie(token, Math.max(0, exp - Math.floor(Date.now() / 1000))))

      member.lastLoginAt = new Date()
      await member.save()
      // The person's own choice of org: where they land next time.
      await Identity.updateOne({ _id: iid }, { $set: { lastOrgId: member.orgId } }).exec()
      // Entering an org is a sign-in to it (Н-18, Appendix 29), whatever it came from.
      auditSignIn(claims, 'switch')

      return {
        user: claims,
        token,
        org: { id: String(org._id), name: org.name, slug: org.slug },
        orgs: orgList(await membershipsOf(iid), claims.orgId),
        needsOrgChoice: false,
      }
    },
    { body: t.Object({ orgId: t.String({ minLength: 1 }) }) },
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

      const ttl = SESSION_TTL_SECONDS
      const token: string = await jwt.sign({ ...user, exp: Math.floor(Date.now() / 1000) + ttl })
      cookie.auth.set(sessionCookie(token))

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

        const ttl = SESSION_TTL_SECONDS
        const token: string = await jwt.sign({ ...user, exp: Math.floor(Date.now() / 1000) + ttl })
        cookie.auth.set(sessionCookie(token))

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
            settings: (org as any).settings || undefined,
          }
        : null,
    }
  }, { isSignIn: true })
