import { Elysia, t } from 'elysia'
import { DesktopAuth } from '../auth/desktop-auth.service.js'
import {
  DesktopError,
  enrollDesktop,
  issueDesktopToken,
  reportSelf,
} from 'services/biz/desktop/desktop.service'
import { createAuditEntry } from 'services/biz/audit-log.service'
import { Desktop } from 'db/models'
import { config } from 'config'

/**
 * The routes whose caller is a **desktop** (FR-14.20, FR-14.23).
 *
 * ⚠ Three of these are in `public-routes.ts`, and each is public for the same reason `/auth/login`
 * is: it is what PRODUCES the credential. They are not unauthenticated — `enroll` is authenticated
 * by a single-use code, `token` by a signature over a nonce.
 */

/** Requests reaching here have a desktop; the guard refused everything else. */
type Ctx = { desktop: any }

function fail(status: any, e: unknown) {
  if (e instanceof DesktopError) return status(e.statusCode, { code: e.code, message: e.message })
  throw e
}

/**
 * Fetch the release manifest for a channel.
 *
 * ⚠ Returns `null` rather than throwing when nothing is configured or the feed is unreachable.
 * A failed update CHECK must never fail the desktop's other calls, and a till that cannot reach
 * a release feed is still a working till — it just has nothing new to install.
 */
async function fetchLatestRelease(channel: string, _desktop: any): Promise<unknown | null> {
  const base = config.desktop.releaseFeedUrl
  if (!base) return null
  try {
    const url = `${base.replace(/\/$/, '')}/${encodeURIComponent(channel)}.json`
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) })
    if (!res.ok) return null
    return await res.json()
  } catch {
    return null
  }
}

function clientIp(request: Request, headers: Record<string, string | undefined>): string | undefined {
  // Behind the cluster ingress, so the socket address is the proxy's. Take the first hop.
  const fwd = headers['x-forwarded-for']
  if (fwd) return fwd.split(',')[0]!.trim()
  return undefined
}

export const desktopV1Controller = new Elysia({ prefix: '/desktop/v1' })
  .use(DesktopAuth)

  /**
   * Exchange a single-use code (or a reusable key) for a desktop identity.
   *
   * ⚠ The desktop sends only its PUBLIC key. The private half never leaves the machine's OS
   * keystore, which is what makes a copied config worthless (FR-14.20).
   */
  .post(
    '/enroll',
    async ({ body, status, request, headers }) => {
      try {
        return await enrollDesktop({ ...body, ip: clientIp(request, headers as any) })
      } catch (e) {
        return fail(status, e)
      }
    },
    {
      body: t.Object({
        code: t.Optional(t.String({ maxLength: 32 })),
        enrollmentKey: t.Optional(t.String({ maxLength: 128 })),
        installationId: t.String({ minLength: 8, maxLength: 128 }),
        machineId: t.String({ minLength: 8, maxLength: 128 }),
        name: t.String({ minLength: 1, maxLength: 120 }),
        os: t.Optional(
          t.Object({
            platform: t.Optional(t.String({ maxLength: 40 })),
            version: t.Optional(t.String({ maxLength: 60 })),
            arch: t.Optional(t.String({ maxLength: 20 })),
          }),
        ),
        hostname: t.Optional(t.String({ maxLength: 120 })),
        appVersion: t.Optional(t.String({ maxLength: 40 })),
        publicKey: t.String({ minLength: 40, maxLength: 200 }),
      }),
    },
  )

  /**
   * Mint a 15-minute access token from a signed client assertion.
   *
   * ⚠ The `aud` the assertion must carry is this URL. That is what stops an assertion minted for
   * one endpoint being replayed at another, so it is computed from the request rather than
   * hardcoded — a mismatch between the two would fail every legitimate desktop.
   */
  .post(
    '/token',
    async ({ body, status, request }) => {
      try {
        const audience = new URL(request.url).origin + '/api/desktop/v1/token'
        const { token, expiresAt, serverTime } = await issueDesktopToken(body.assertion, audience)
        return {
          accessToken: token,
          tokenType: 'Bearer',
          expiresIn: config.desktop.tokenTtlSec,
          expiresAt: expiresAt.toISOString(),
          // So a desktop with a wrong clock can correct `iat` on its next assertion.
          serverTime,
        }
      } catch (e) {
        return fail(status, e)
      }
    },
    { body: t.Object({ assertion: t.String({ minLength: 20, maxLength: 4096 }) }) },
  )

  /**
   * FR-14.28 — the update manifest, proxied by the hub.
   *
   * ⚠ **Proxied, not linked.** A shop whose firewall allows only the hub still updates, and an
   * operator can refuse a version to the whole fleet without unpublishing the release. A till
   * reaching a release CDN directly would make both impossible.
   *
   * ⚠ It carries NO signature of its own and is not a trust boundary. The desktop verifies the
   * Tauri updater signature against a key **pinned in its binary**, and then the platform
   * signature against roomler's pinned identity, before anything is executed (C13 §2). A
   * compromised hub can therefore withhold an update or offer an old one — which is why
   * `minVersion` travels with it — but it cannot make a desktop install an artifact.
   */
  .get(
    '/latest-release',
    async ({ desktop, query }: any) => {
      const channel = query?.channel === 'beta' ? 'beta' : 'stable'
      return {
        // The floor travels with every manifest so the Overview can raise its banner without a
        // second round trip, and so a desktop learns it even while its token still works.
        minVersion: config.desktop.minVersion || null,
        channel,
        // ⚠ `null`, not an empty manifest. "No update source is configured" and "you are up to
        // date" are different answers, and a client that cannot tell them apart will either
        // nag forever or never check again.
        release: await fetchLatestRelease(channel, desktop),
        serverTime: new Date().toISOString(),
      }
    },
  )

  /** Report version, OS, capabilities and visible serial ports (FR-14.21). */
  .put(
    '/self',
    async ({ body, desktop, request, headers }: any) => {
      await reportSelf(desktop, { ...body, ip: clientIp(request, headers) })
      return { ok: true, serverTime: new Date().toISOString() }
    },
    {
      body: t.Object({
        appVersion: t.Optional(t.String({ maxLength: 40 })),
        hostname: t.Optional(t.String({ maxLength: 120 })),
        os: t.Optional(
          t.Object({
            platform: t.Optional(t.String({ maxLength: 40 })),
            version: t.Optional(t.String({ maxLength: 60 })),
            arch: t.Optional(t.String({ maxLength: 20 })),
          }),
        ),
        capabilities: t.Optional(
          t.Object({
            fiscalBridge: t.Optional(t.Boolean()),
            serialPorts: t.Optional(t.Array(t.String({ maxLength: 60 }), { maxItems: 32 })),
          }),
        ),
        clientTime: t.Optional(t.String({ maxLength: 40 })),
      }),
    },
  )

  /**
   * An ephemeral desktop unregistering itself on a clean shutdown (FR-14.19).
   *
   * ⚠ Only ephemeral desktops may do this. A permanent till must not be able to delete its own
   * registration — revoking is an admin's decision, and the row is the audit trail.
   */
  .delete('/self', async ({ desktop, status }: any) => {
    if (!desktop.ephemeral) {
      return status(403, {
        code: 'not_ephemeral',
        message: 'Only an ephemeral desktop can unregister itself. Ask an administrator to revoke it.',
      })
    }
    await Desktop.deleteOne({ _id: desktop._id })
    createAuditEntry({
      orgId: String(desktop.orgId),
      userId: String(desktop._id), // no user in this flow; the desktop is the actor
      action: 'delete',
      module: 'admin',
      entityType: 'desktop',
      entityId: String(desktop._id),
      entityName: desktop.name,
      changes: [{ field: 'status', oldValue: 'active', newValue: 'self-unregistered' }],
    })
    return { ok: true }
  })
