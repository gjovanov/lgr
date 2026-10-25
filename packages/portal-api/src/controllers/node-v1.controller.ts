import { Elysia, t } from 'elysia'
import { config } from 'config'
import { NODE_LINK_LEVELS, ServerNode } from 'db/models'
import { NodeAuth } from '../auth/node-auth.service.js'
import { clientIp } from '../auth/client-ip.js'
import { acceptableTokenAudiences, configuredRelease } from './desktop-v1.controller.js'
import { NodeError, enrollNode, issueNodeToken, nodeSelf } from 'services/biz/node/node.service'
import { relayMail } from 'services/biz/relay/mail-relay.service'
import { documentJob, startDocumentJob } from 'services/biz/relay/documents-relay.service'
import { IdpError, redeem as redeemIdpCode } from 'services/biz/idp/idp.service'
import { identityChangesFor } from 'services/biz/identity/identity-feed.service'
import { OnpremCredentialError, credentialChangesFor } from 'services/biz/identity/onprem-credentials.service'
import {
  DesktopDownloadError,
  UPDATER_INSTALLERS,
  classifyDesktopAsset,
  desktopDownloadsConfigured,
  findDesktopRelease,
  updaterManifest,
} from 'services/biz/desktop/release-download'

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

  /**
   * FR-20.56 (plan step P2-7): the desktop release a master keeps for its tills. Global's configured
   * stable version, its servable files, and per updater platform the file and its signature.
   *
   * ⚠ The master fetches the bytes from the public download endpoint, so the GitHub token never
   * leaves global. Nothing here is a trust boundary: each till verifies the updater signature
   * against a key pinned in its own binary, whoever served the file. 204: nothing to keep.
   */
  .get('/desktop-release', async ({ set, status }: any) => {
    const release = configuredRelease('stable')
    if (!release || !desktopDownloadsConfigured()) {
      set.status = 204
      return ''
    }
    try {
      const assets = (await findDesktopRelease(release.version)) ?? []
      const files = assets.filter(a => classifyDesktopAsset(a.name)).map(a => ({ name: a.name, size: a.size }))
      const updater: Record<string, { file: string; signature: string }> = {}
      for (const platform of Object.keys(UPDATER_INSTALLERS)) {
        const m = await updaterManifest(release.version, platform)
        if (m) updater[platform] = { file: decodeURIComponent(m.url.slice(m.url.lastIndexOf('/') + 1)), signature: m.signature }
      }
      return { version: release.version, notes: release.notes ?? null, minVersion: config.desktop.minVersion || null, files, updater }
    } catch (e) {
      if (e instanceof DesktopDownloadError) return status(e.statusCode === 404 ? 502 : e.statusCode, { code: e.code })
      throw e
    }
  })

  /**
   * FR-20.59 (plan step P2-6): a mail from this master's outbox, sent by global on its behalf with
   * global's own sender. The answer says what happened; the same outbox id within 7 days sends
   * nothing again (`mail-relay.service.ts` holds the caps).
   */
  .post(
    '/relay/mail',
    async ({ node, body, status }: any) => {
      const r = await relayMail(node, body)
      return r.status === 200 ? r.body : status(r.status, r.body)
    },
    {
      body: t.Object({
        outboxId: t.String({ minLength: 1, maxLength: 200, pattern: '^[A-Za-z0-9:._-]+$' }),
        orgId: t.String({ pattern: '^[0-9a-f]{24}$' }),
        to: t.String({ maxLength: 320 }),
        subject: t.String({ maxLength: 1000 }),
        html: t.String(),
        attachments: t.Optional(t.Array(t.Object({ filename: t.String({ maxLength: 300 }), type: t.Optional(t.String({ maxLength: 200 })), content: t.String() }), { maxItems: 20 })),
      }),
    },
  )

  /**
   * FR-20.59 (plan step P2-6b): read a document for this server, on lgrai.app's sidecar: text out of
   * a PDF, an AI draft, or AI line matching. A job: 202 now, then `GET …/:requestId` until it is
   * done. The same request id is the same job (`documents-relay.service.ts` holds the caps).
   */
  .post(
    '/relay/documents',
    async ({ node, body, status }: any) => {
      const r = await startDocumentJob(node, body)
      return status(r.status as any, r.body)
    },
    {
      body: t.Object({
        requestId: t.String({ pattern: '^[A-Za-z0-9-]{8,80}$' }),
        orgId: t.String({ pattern: '^[0-9a-f]{24}$' }),
        op: t.Union([t.Literal('extract'), t.Literal('draft'), t.Literal('match-lines')]),
        input: t.Any(),
      }),
    },
  )
  .get('/relay/documents/:requestId', async ({ node, params, status }: any) => {
    if (!/^[A-Za-z0-9-]{8,80}$/.test(params.requestId)) return status(404, { code: 'unknown_job', message: 'No such job.' })
    const r = await documentJob(node, params.requestId)
    return status(r.status as any, r.body)
  })

  /**
   * FR-20.39 (plan step P2-4): "Sign in with LGR". This server redeems the code a person's browser
   * brought back, with the browser's PKCE verifier, for a 5-minute assertion signed by global's
   * identity key. A code is single use and spent by any mismatch.
   */
  .post(
    '/idp/redeem',
    async ({ node, body, status }: any) => {
      try {
        return await redeemIdpCode(node, body)
      } catch (e) {
        if (e instanceof IdpError) return status(e.statusCode, { code: e.code, message: e.message })
        throw e
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

  /**
   * FR-20.43 (plan step P2-5): the people of this server's orgs who changed on lgrai.app after
   * `after`, oldest first. Who they are and nothing secret (FR-20.44).
   */
  .get('/identity-changes', async ({ node, query }: any) => identityChangesFor(node, query.after, Number(query.limit) || undefined))

  /**
   * FR-20.40 (plan step P2-4c): the local credentials of this server's people that changed on
   * lgrai.app after `after`, each sealed to this server's seal key. 409 `no_seal_key` until the
   * supervisor has signed one in.
   */
  .get('/credential-changes', async ({ node, query, status }: any) => {
    try {
      return await credentialChangesFor(node, query.after, Number(query.limit) || undefined)
    } catch (e) {
      if (e instanceof OnpremCredentialError) return status(e.statusCode, { code: e.code, message: e.message })
      throw e
    }
  })

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
