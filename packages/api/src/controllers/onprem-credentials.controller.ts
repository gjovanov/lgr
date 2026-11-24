import { Elysia, t } from 'elysia'
import { nodeRole } from 'config'
import { AuthService } from '../auth/auth.service.js'
import { BEARER_REQUIRED, bearerPresent, callerOf } from '../auth/session-answer.js'
import { clientIp } from '../auth/client-ip.js'
import {
  OnpremCredentialError,
  isOnpremCredentialKind,
  onpremServersOf,
  removeOnpremCredential,
  setOnpremCredential,
} from 'services/biz/identity/onprem-credentials.service'
import { clearLoginFailures, loginRetryAfterSeconds, recordLoginFailure } from 'services/biz/login-throttle.service'

/**
 * The person's local credentials for their orgs' on-prem servers, on lgrai.app (FR-20.40, plan step
 * P2-4c): a local password for an outage, and a till PIN. 404 on a master, where the person signs in
 * with them instead (`/auth/local/*`, `/auth/login`).
 *
 * ⚠ The org is `:org`, never `:orgId`: the tenant guard refuses an `:orgId` other than the session's,
 * and a person sets these for every org they work in from wherever they are signed in. Membership is
 * checked by the service instead.
 */

const NOT_FOUND = { message: 'Not found' }
const NOT_A_PERSON = { code: 'not_a_person', message: 'Sign in again: this session names no person.' }

function failed(status: any, e: unknown) {
  if (e instanceof OnpremCredentialError) return status(e.statusCode, { code: e.code, message: e.message })
  throw e
}

export const onpremCredentialsController = new Elysia({ prefix: '/auth/onprem' })
  .use(AuthService)
  .onBeforeHandle(({ status }) => {
    if (nodeRole() !== 'global') return status(404, NOT_FOUND)
  })
  .get('', async ({ user, person, status }: any) => {
    const caller = callerOf(user, person)
    if (!caller?.iid) return status(401, NOT_A_PERSON)
    return { orgs: await onpremServersOf(caller.iid) }
  })
  /**
   * Set or change one. The person's password proves it (and wrong ones count against the sign-in
   * throttle, as a password change's do: a stolen session must not be a way to guess it).
   */
  .put(
    '/:org/:kind',
    async ({ user, person, params, body, headers, status }: any) => {
      if (!bearerPresent(headers.authorization)) return status(401, BEARER_REQUIRED)
      const caller = callerOf(user, person)
      if (!caller?.iid) return status(401, NOT_A_PERSON)
      if (!isOnpremCredentialKind(params.kind)) return status(404, NOT_FOUND)
      const attempt = { orgSlug: '#password', username: caller.iid, ip: clientIp(headers) }
      const retryAfter = await loginRetryAfterSeconds(attempt).catch(() => 0)
      if (retryAfter > 0) {
        return status(429, { message: 'Too many attempts. Try again later.', code: 'too_many_attempts', retryAfterSeconds: retryAfter })
      }
      try {
        const { setAt } = await setOnpremCredential({
          identityId: caller.iid,
          orgId: params.org,
          kind: params.kind,
          secret: body.secret,
          currentPassword: body.currentPassword,
        })
        await clearLoginFailures(attempt).catch(() => undefined)
        return { set: true, setAt }
      } catch (e) {
        if (e instanceof OnpremCredentialError && e.code === 'wrong_password') await recordLoginFailure(attempt).catch(() => undefined)
        return failed(status, e)
      }
    },
    {
      body: t.Object({
        secret: t.String({ minLength: 1, maxLength: 256 }),
        currentPassword: t.Optional(t.String({ maxLength: 256 })),
      }),
    },
  )
  .delete('/:org/:kind', async ({ user, person, params, headers, status }: any) => {
    if (!bearerPresent(headers.authorization)) return status(401, BEARER_REQUIRED)
    const caller = callerOf(user, person)
    if (!caller?.iid) return status(401, NOT_A_PERSON)
    if (!isOnpremCredentialKind(params.kind)) return status(404, NOT_FOUND)
    try {
      return { removed: await removeOnpremCredential(caller.iid, params.org, params.kind) }
    } catch (e) {
      return failed(status, e)
    }
  })
