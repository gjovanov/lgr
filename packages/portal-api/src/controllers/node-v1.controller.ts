import { Elysia, t } from 'elysia'
import { config } from 'config'
import { NODE_LINK_LEVELS, ServerNode } from 'db/models'
import { NodeAuth } from '../auth/node-auth.service.js'
import { clientIp } from '../auth/client-ip.js'
import { acceptableTokenAudiences, configuredRelease } from './desktop-v1.controller.js'
import { NodeError, enrollNode, issueNodeToken, nodeSelf } from 'services/biz/node/node.service'
import { relayMail } from 'services/biz/relay/mail-relay.service'
import { documentJob, startDocumentJob } from 'services/biz/relay/documents-relay.service'
import { ServerReleaseError, openServerBundle, serverReleaseOffer } from 'services/biz/node/server-release.service'
import { IdpError, redeem as redeemIdpCode } from 'services/biz/idp/idp.service'
import { identityChangesFor } from 'services/biz/identity/identity-feed.service'
import { OnpremCredentialError, credentialChangesFor } from 'services/biz/identity/onprem-credentials.service'
import { MoveError, copied, copyFailed, copyFor, movesForNode } from 'services/biz/move/move.service'
import { drained } from 'services/biz/move/move-back.service'
import { legalSeriesOf } from 'services/biz/move/promote.service'
import { FENCED_CHUNK, fencedExportStatus, receiveFencedChunk } from 'services/biz/move/fenced-export.service'
import { rewelcomeNode } from '../websocket/uplink.js'
import { repointOrgDesktops } from '../websocket/desktop.js'
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

function failMove(status: any, e: unknown) {
  if (e instanceof MoveError) return status(e.statusCode, { code: e.code, message: e.message })
  throw e
}

const OBJECT_ID = /^[0-9a-f]{24}$/

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
   * FR-20.20 (plan step P1-8): the server release this master may update to (`SERVER_RELEASE_VERSION`,
   * which a human promotes): per target its update bundle, with the minisign and GPG signatures and
   * the digest beside it. 204: nothing offered. ⚠ Not a trust boundary: the master checks every byte
   * against keys built into its own package, and never takes a version older than its own.
   */
  .get('/server-release', async ({ set, status }: any) => {
    const version = config.serverRelease.version
    try {
      const offer = version ? await serverReleaseOffer(version) : null
      if (offer) return offer
      set.status = 204
      return ''
    } catch (e) {
      if (e instanceof ServerReleaseError) return status(e.statusCode === 404 ? 502 : e.statusCode, { code: e.code })
      throw e
    }
  })

  /**
   * The bundle itself, streamed from GitHub through lgrai.app (one origin to allow-list, FR-20.20).
   * Only a bundle of the version on offer: nothing else of any release.
   */
  .get('/server-release/:version/:file', async ({ params, status }: any) => {
    if (!config.serverRelease.version || params.version !== config.serverRelease.version) return status(404, { code: 'not_found' })
    try {
      const { body, length } = await openServerBundle(params.version, params.file)
      const headers: Record<string, string> = {
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': `attachment; filename="${params.file}"`,
        'X-Content-Type-Options': 'nosniff',
      }
      if (length) headers['Content-Length'] = length
      return new Response(body, { status: 200, headers })
    } catch (e) {
      if (e instanceof ServerReleaseError) return status(e.statusCode, { code: e.code })
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

  /**
   * FR-20.79 (plan step P3-6a): the moves of an org to this server, live or ended in the last
   * month. The master acts on each one in the state global gives it, and on nothing else.
   */
  .get('/moves', async ({ node }: any) => ({ moves: await movesForNode(node._id) }))

  /**
   * FR-20.84 (plan step P3-6e): a fenced master's export of what it did after a promotion's cutoff.
   * Where lgrai.app stands with it, and its chunks, each at that offset. Received, it waits for a
   * person: nothing of it is written into the org here.
   */
  .get('/moves/:id/fenced-export', async ({ node, params, status }: any) => {
    if (!OBJECT_ID.test(params.id)) return status(404, { code: 'not_found' })
    try {
      return await fencedExportStatus(node._id, params.id)
    } catch (e) {
      return failMove(status, e)
    }
  })
  .put(
    '/moves/:id/fenced-export',
    async ({ node, params, query, request, status }: any) => {
      if (!OBJECT_ID.test(params.id)) return status(404, { code: 'not_found' })
      if (Number(request.headers.get('content-length') ?? 0) > FENCED_CHUNK) return status(413, { code: 'chunk_too_large', message: `A chunk is at most ${FENCED_CHUNK} bytes.` })
      try {
        const bytes = new Uint8Array(await request.arrayBuffer())
        const r = await receiveFencedChunk(node._id, params.id, { offset: Number(query.offset), size: Number(query.size), sha256: String(query.sha256 ?? '') }, bytes)
        if (r.offsetMismatch) return status(409, { code: 'offset', message: 'Send from where lgrai.app stands.', received: r.received })
        return r
      } catch (e) {
        return failMove(status, e)
      }
    },
    { parse: 'none' },
  )

  /** The copy of a move to this server, and its files: only while the move waits for them. */
  .get('/moves/:id/:part', async ({ node, params, status }: any) => {
    if (!OBJECT_ID.test(params.id) || (params.part !== 'bundle' && params.part !== 'files')) return status(404, { code: 'not_found' })
    try {
      const paths = await copyFor(node._id, params.id)
      const file = Bun.file(params.part === 'bundle' ? paths.bundle : paths.files)
      if (!(await file.exists())) return status(404, { code: 'not_found' })
      return new Response(file, {
        status: 200,
        headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(file.size), 'X-Content-Type-Options': 'nosniff' },
      })
    } catch (e) {
      return failMove(status, e)
    }
  })

  /**
   * The master imported the copy: its digests, and how many of the copy's people and credentials it
   * holds (FR-20.79 step 4). Equal, the org's home becomes this server (step 5) and its bulk socket
   * is welcomed again, so its pump starts paging the org.
   */
  .post(
    '/moves/:id/copied',
    async ({ node, params, body, status }: any) => {
      if (!OBJECT_ID.test(params.id)) return status(404, { code: 'not_found' })
      try {
        const r: any = await copied(node._id, params.id, body)
        if (r.ok) {
          rewelcomeNode(node._id)
          // FR-20.82 (P3-6b): the org's desktops connected here learn where it lives now.
          await repointOrgDesktops(r.orgId).catch(() => 0)
        }
        return r
      } catch (e) {
        return failMove(status, e)
      }
    },
    {
      body: t.Object({
        digests: t.Record(t.String(), t.Object({ count: t.Integer({ minimum: 0 }), sha256: t.String({ pattern: '^[0-9a-f]{64}$' }) }), { maxProperties: 500 }),
        people: t.Integer({ minimum: 0 }),
        credentials: t.Integer({ minimum: 0 }),
      }),
    },
  )

  /**
   * FR-20.80 (plan step P3-6c): a move back. The master froze the org and captured its last writes;
   * global answers what it still waits for (pages, files, the master's digests), or the outcome.
   */
  .post(
    '/moves/:id/drained',
    async ({ node, params, body, status }: any) => {
      if (!OBJECT_ID.test(params.id)) return status(404, { code: 'not_found' })
      try {
        return await drained(node._id, params.id, body)
      } catch (e) {
        return failMove(status, e)
      }
    },
    {
      body: t.Object({
        head: t.Integer({ minimum: 0 }),
        journalEpoch: t.Optional(t.Integer({ minimum: 0 })),
        digests: t.Optional(t.Record(t.String(), t.Object({ count: t.Integer({ minimum: 0 }), sha256: t.String({ pattern: '^[0-9a-f]{64}$' }) }), { maxProperties: 500 })),
      }),
    },
  )

  /** The master could not take the copy: the move ends, and lgrai.app unfreezes the org. */
  .post(
    '/moves/:id/failed',
    async ({ node, params, body, status }: any) => {
      if (!OBJECT_ID.test(params.id)) return status(404, { code: 'not_found' })
      try {
        await copyFailed(node._id, params.id, body.reason)
        return { ok: true }
      } catch (e) {
        return failMove(status, e)
      }
    },
    { body: t.Object({ reason: t.String({ maxLength: 500 }) }) },
  )

  /**
   * FR-20.51 (P3-7): the legal series of one of this master's orgs as lgrai.app's mirror holds them:
   * the floor its numbering resumes above, once a person records the site's last numbers.
   * ⚠ The org is a query parameter, never `:orgId` in the path: a path with `:orgId` is a USER's org
   * route (the tenant guard and its reachability test say so), and this one takes a node token.
   */
  .get('/legal-series', async ({ node, query, status }: any) => {
    const orgId = String(query.orgId ?? '')
    if (!OBJECT_ID.test(orgId) || !(node.orgIds ?? []).some((id: unknown) => String(id) === orgId)) return status(404, { code: 'not_found' })
    return { series: await legalSeriesOf(orgId) }
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
