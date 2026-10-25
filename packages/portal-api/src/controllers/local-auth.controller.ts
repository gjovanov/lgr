import { Elysia, t } from 'elysia'
import { nodeRole } from 'config'
import { Org } from 'db/models'
import { DesktopError, loadActiveDesktop, verifyDesktopToken } from 'services/biz/desktop/desktop.service'
import { sessionFor } from 'services/biz/auth.service'
import {
  LocalCredentialError, hasPin, pinSignIn, removePin, setPin, PIN_MAX, PIN_MIN,
} from 'services/biz/identity/local-credentials.service'
import { AuthService } from '../auth/auth.service.js'
import { auditSignIn } from '../auth/session-answer.js'
import { setSessionCookie } from '../auth/session-cookie.js'
import { DESKTOP_TOKEN_HEADER, frontSource } from '../front/front-guard.js'

/**
 * Signing in at a till with a PIN (FR-20.40, plan step P1-5), on a master only: every route here
 * answers 404 on global, where there is no `local_credentials` and nothing a PIN could unlock.
 *
 * - The till is a desktop paired with this master, on the LAN ingress. Its token names its org,
 *   so a PIN signs in to that org and no other. ⚠ Never through the tunnel (P3): `frontSource` is
 *   the supervisor's stamp, and only `lan` and `console` are accepted.
 * - A PIN session lasts a shift (`PIN_SESSION_TTL_SECONDS`) and reaches the till only
 *   (`amr: ['pin']`, `pinScopeRefusal`).
 * - The PIN itself is set by its person, signed in with the password (`PUT /pin`).
 */
export const PIN_SESSION_TTL_SECONDS = 12 * 60 * 60

const NOT_FOUND = { code: 'not_found', message: 'Not found.' }

type Till = { source: 'lan'; desktopId: string; orgId: string } | { source: 'console' }

/** The till behind this request, or null when PIN sign-in is not offered to it. */
async function tillOf(headers: Record<string, string | undefined>): Promise<Till | null> {
  if (nodeRole() !== 'master') return null
  const source = frontSource(headers)
  if (source === 'console') return { source: 'console' }
  if (source !== 'lan') return null
  const claims = verifyDesktopToken(headers[DESKTOP_TOKEN_HEADER])
  if (!claims) return null
  try {
    const desktop = await loadActiveDesktop(claims)
    return { source: 'lan', desktopId: String(desktop._id), orgId: String(claims.orgId) }
  } catch (e) {
    if (e instanceof DesktopError) return null
    throw e
  }
}

export const localAuthController = new Elysia({ prefix: '/auth/local' })
  .use(AuthService)
  /** Whether this client may offer the PIN pad. 404 off a master, like everything here. */
  .get('/methods', async ({ headers, status }) => {
    if (nodeRole() !== 'master') return status(404, NOT_FOUND)
    return { pin: !!(await tillOf(headers)), pinLength: { min: PIN_MIN, max: PIN_MAX } }
  })
  .post('/pin', async ({ body, headers, cookie, jwt, set, status }) => {
    const till = await tillOf(headers)
    if (!till) return status(404, NOT_FOUND)

    let orgId: string | undefined = till.source === 'lan' ? till.orgId : undefined
    if (till.source === 'console') {
      const org = body.orgSlug ? await Org.findOne({ slug: body.orgSlug }, { _id: 1 }).lean().exec() : null
      orgId = org ? String((org as any)._id) : undefined
    }
    if (!orgId) return status(422, { code: 'org_required', message: 'Name the organization (orgSlug) on the console.' })

    try {
      const { user, identity } = await pinSignIn({
        orgId, operatorCode: body.operatorCode, pin: body.pin, desktopId: till.source === 'lan' ? till.desktopId : undefined,
      })
      const org = await Org.findById(orgId).exec()
      if (!org) return status(404, NOT_FOUND)
      const session = { ...(await sessionFor(user, identity)), amr: ['pin'] }
      const exp = Math.floor(Date.now() / 1000) + PIN_SESSION_TTL_SECONDS
      const token: string = await (jwt as any).sign({ ...session, exp })
      setSessionCookie(cookie as any, token, PIN_SESSION_TTL_SECONDS)
      auditSignIn(session, 'pin')
      return {
        user: session,
        token,
        org: { id: String(org._id), name: org.name, slug: org.slug },
        orgs: [{ orgId: String(org._id), name: org.name, slug: org.slug, role: session.role, current: true }],
        needsOrgChoice: false,
      }
    } catch (e) {
      if (!(e instanceof LocalCredentialError)) throw e
      if (e.retryAfterSeconds) set.headers['retry-after'] = String(e.retryAfterSeconds)
      return status(e.statusCode as any, { code: e.code, message: e.message, ...(e.retryAfterSeconds ? { retryAfterSeconds: e.retryAfterSeconds } : {}) })
    }
  }, {
    body: t.Object({
      operatorCode: t.String({ maxLength: 8 }),
      pin: t.String({ maxLength: PIN_MAX }),
      orgSlug: t.Optional(t.String()),
    }),
  })
  /** Whether the signed-in person has a PIN that works here. */
  .get('/pin', async ({ user, status }) => {
    if (nodeRole() !== 'master') return status(404, NOT_FOUND)
    if (!user) return status(401, { message: 'Unauthorized' })
    if (!user.iid) return { set: false }
    return { set: await hasPin(user.iid) }
  }, { isSignIn: true })
  /** Set or change the signed-in person's PIN. The password proves it, and a PIN session may not. */
  .put('/pin', async ({ user, body, status }) => {
    if (nodeRole() !== 'master') return status(404, NOT_FOUND)
    if (!user) return status(401, { message: 'Unauthorized' })
    if (user.amr?.includes('pin')) return status(403, { code: 'password_required', message: 'Sign in with your password to set a PIN.' })
    if (!user.iid) return status(409, { code: 'not_a_person', message: 'Sign in again before setting a PIN.' })
    try {
      await setPin(user.iid, body.password, body.pin)
      return { set: true }
    } catch (e) {
      if (!(e instanceof LocalCredentialError)) throw e
      return status(e.statusCode as any, { code: e.code, message: e.message })
    }
  }, {
    isSignIn: true,
    body: t.Object({ password: t.String(), pin: t.String({ maxLength: PIN_MAX }) }),
  })
  .delete('/pin', async ({ user, status }) => {
    if (nodeRole() !== 'master') return status(404, NOT_FOUND)
    if (!user) return status(401, { message: 'Unauthorized' })
    if (!user.iid) return status(409, { code: 'not_a_person', message: 'Sign in again before removing a PIN.' })
    await removePin(user.iid)
    return { set: false }
  }, { isSignIn: true })
