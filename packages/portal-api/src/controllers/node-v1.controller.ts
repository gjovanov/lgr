import { Elysia, t } from 'elysia'
import { config } from 'config'
import { NODE_LINK_LEVELS, ServerNode } from 'db/models'
import { NodeAuth } from '../auth/node-auth.service.js'
import { clientIp } from '../auth/client-ip.js'
import { acceptableTokenAudiences } from './desktop-v1.controller.js'
import { NodeError, enrollNode, issueNodeToken, nodeSelf } from 'services/biz/node/node.service'

/**
 * A master's side of its registration with global (FR-20.2, plan step P2-1). Behind `NodeAuth`:
 * deny by default, 404 on a master. `enroll` and `token` are the two public entries.
 */

function fail(status: any, e: unknown) {
  if (e instanceof NodeError) return status(e.statusCode, { code: e.code, message: e.message })
  throw e
}

const versions = t.Object({
  app: t.Optional(t.String({ maxLength: 40 })),
  protocol: t.Optional(t.Integer({ minimum: 0, maximum: 1_000_000 })),
  schema: t.Optional(t.String({ maxLength: 120 })),
  supto: t.Optional(t.String({ maxLength: 40 })),
})

export const nodeV1Controller = new Elysia({ prefix: '/node/v1' })
  .use(NodeAuth)

  /**
   * Register this master for the org whose admin minted the code (or a field lane's reusable key).
   *
   * ⚠ `proof` is an assertion by the key being registered, `aud` this route's URL: a node row then
   * always names a key somebody holds, and a second org can join a node only through that node.
   */
  .post(
    '/enroll',
    async ({ body, status, request, headers }) => {
      try {
        return await enrollNode({ ...body, ip: clientIp(headers as any) }, acceptableTokenAudiences(request, '/api/node/v1/enroll'))
      } catch (e) {
        return fail(status, e)
      }
    },
    {
      body: t.Object({
        code: t.Optional(t.String({ maxLength: 32 })),
        enrollmentKey: t.Optional(t.String({ maxLength: 128 })),
        nodeId: t.String({ minLength: 8, maxLength: 40 }),
        installationId: t.String({ minLength: 8, maxLength: 128 }),
        name: t.String({ minLength: 1, maxLength: 120 }),
        publicKey: t.String({ minLength: 40, maxLength: 200 }),
        proof: t.String({ minLength: 20, maxLength: 4096 }),
        linkLevel: t.Optional(t.Union(NODE_LINK_LEVELS.map(l => t.Literal(l)))),
        os: t.Optional(t.Object({
          platform: t.Optional(t.String({ maxLength: 40 })),
          version: t.Optional(t.String({ maxLength: 60 })),
          arch: t.Optional(t.String({ maxLength: 20 })),
        })),
        versions: t.Optional(versions),
      }),
    },
  )

  /** A 15-minute token for a signed assertion whose `aud` is this route's URL. */
  .post(
    '/token',
    async ({ body, status, request, headers }) => {
      try {
        const { token, expiresAt, serverTime } = await issueNodeToken(
          body.assertion,
          acceptableTokenAudiences(request, '/api/node/v1/token'),
          clientIp(headers as any),
        )
        return { accessToken: token, tokenType: 'Bearer', expiresIn: config.node.tokenTtlSec, expiresAt: expiresAt.toISOString(), serverTime }
      } catch (e) {
        return fail(status, e)
      }
    },
    { body: t.Object({ assertion: t.String({ minLength: 20, maxLength: 4096 }) }) },
  )

  /** The master's registration as global sees it: which orgs it serves, at which link level. */
  .get('/self', async ({ node }: any) => nodeSelf(node))

  /**
   * An ephemeral master unregistering itself at the end of a field cell. ⚠ Only an ephemeral one: a
   * shop's master must not be able to delete its own registration; that is an admin's decision.
   */
  .delete('/self', async ({ node, status }: any) => {
    if (!node.ephemeral) {
      return status(403, { code: 'not_ephemeral', message: 'Only an ephemeral server can unregister itself. Ask an administrator to remove it.' })
    }
    await ServerNode.deleteOne({ _id: node._id, ephemeral: true })
    return { ok: true }
  })
