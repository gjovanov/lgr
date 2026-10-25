import { Elysia, t } from 'elysia'
import { nodeRole } from 'config'
import { AuthService } from '../auth/auth.service.js'
import { callerOf, enterOrg } from '../auth/session-answer.js'
import { IdpError, authorize, idpClient } from 'services/biz/idp/idp.service'
import { IdpSignInError, idpConfig, signInWithLgr } from 'services/biz/idp/idp-signin.service'

/**
 * "Sign in with LGR" (FR-20.39, plan step P2-4).
 *
 * - **On lgrai.app** (`/idp/*`): what its authorize page shows (`client`), and the person's consent
 *   (`authorize`), with the person's lgrai.app session: an org session or an identity-only one. 404
 *   on a master.
 * - **On a master** (`/auth/idp/*`, public: they are what make the session): whether it offers the
 *   button (`config`), and the redemption of the code the browser came back with (`redeem`). 404 on
 *   global. The redemption at global is `POST /api/node/v1/idp/redeem` (node-v1.controller).
 */

const NOT_FOUND = { message: 'Not found' }

function failed(status: any, e: unknown) {
  if (e instanceof IdpError || e instanceof IdpSignInError) return status(e.statusCode, { code: e.code, message: e.message })
  throw e
}

export const idpController = new Elysia({ prefix: '/idp' })
  .use(AuthService)
  .onBeforeHandle(({ status }) => {
    if (nodeRole() !== 'global') return status(404, NOT_FOUND)
  })
  .get(
    '/client',
    async ({ user, person, query, status }: any) => {
      const caller = callerOf(user, person)
      if (!caller?.iid) return status(401, { code: 'not_a_person', message: 'Sign in again: this session names no person.' })
      try {
        return await idpClient({ clientId: String(query.client_id ?? ''), redirectUri: String(query.redirect_uri ?? ''), identityId: caller.iid })
      } catch (e) {
        return failed(status, e)
      }
    },
  )
  .post(
    '/authorize',
    async ({ user, person, body, status }: any) => {
      const caller = callerOf(user, person) as any
      if (!caller?.iid) return status(401, { code: 'not_a_person', message: 'Sign in again: this session names no person.' })
      try {
        const { code } = await authorize({
          identityId: caller.iid,
          amr: Array.isArray(caller.amr) ? caller.amr : [],
          clientId: body.clientId,
          orgId: body.orgId,
          redirectUri: body.redirectUri,
          codeChallenge: body.codeChallenge,
          codeChallengeMethod: body.codeChallengeMethod,
        })
        const back = new URL(body.redirectUri)
        back.searchParams.set('code', code)
        back.searchParams.set('state', body.state)
        return { redirect: back.toString() }
      } catch (e) {
        return failed(status, e)
      }
    },
    {
      body: t.Object({
        clientId: t.String({ maxLength: 40 }),
        orgId: t.String({ pattern: '^[0-9a-f]{24}$' }),
        redirectUri: t.String({ maxLength: 400 }),
        state: t.String({ minLength: 16, maxLength: 128 }),
        codeChallenge: t.String({ maxLength: 64 }),
        codeChallengeMethod: t.String({ maxLength: 8 }),
      }),
    },
  )

export const idpSignInController = new Elysia({ prefix: '/auth/idp' })
  .use(AuthService)
  .onBeforeHandle(({ status }) => {
    if (nodeRole() !== 'master') return status(404, NOT_FOUND)
  })
  /** Whether this master offers "Sign in with LGR": linked, with a fresh node token. */
  .get('/config', () => idpConfig())
  .post(
    '/redeem',
    async ({ body, jwt, cookie, status }: any) => {
      try {
        const { member, identity } = await signInWithLgr(body)
        return await enterOrg({ jwt, cookie }, member, identity, undefined, 'lgr')
      } catch (e) {
        return failed(status, e)
      }
    },
    {
      body: t.Object({
        code: t.String({ minLength: 20, maxLength: 128 }),
        codeVerifier: t.String({ minLength: 43, maxLength: 128 }),
        redirectUri: t.String({ maxLength: 400 }),
      }),
    },
  )
