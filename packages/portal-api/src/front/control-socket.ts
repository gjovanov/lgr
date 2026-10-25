/**
 * FR-20.16 / FR-20.23 (plan step P1-3) — the API's control socket: `status` and `stop`, for the
 * supervisor and nothing else; a backup before an update (P1-8d); and the mirror's pages (P3-2b),
 * which the supervisor sends on the bulk socket without reading them.
 *
 * Not HTTP on a TCP port. It is an AF_UNIX socket (Windows 10 1803 and later have them too), in a
 * directory only the service account and administrators can open: no ingress (the LAN, the tunnel
 * or the console) can reach it, and no other local user can bind its name first. Every request
 * still carries the front secret.
 *
 * ⚠ Measured on Bun 1.4.4 for Windows:
 * - `Bun.serve({ unix })` serves HTTP on an AF_UNIX path, but not on a named pipe (ENOENT);
 * - a path longer than `sun_path` (108 bytes) fails with ENAMETOOLONG, so the supervisor's path
 *   is short (`<data>\run\api.sock`).
 */
import { chmodSync, mkdirSync, rmSync } from 'node:fs'
import { dirname } from 'node:path'
import { FRONT_HEADER, secretMatches } from './front-guard.js'

export interface ControlHandlers {
  status: () => Promise<Record<string, unknown>> | Record<string, unknown>
  /** Begin the graceful stop. Called after the answer has gone out. */
  stop: (reason: string) => void
  /**
   * FR-20.20 (plan step P1-8d): back up every org homed here, now, and answer once it is done. The
   * update helper asks for it, through the supervisor, before it switches to a new version.
   */
  backup?: () => Promise<{ ok: boolean } & Record<string, unknown>>
  /** FR-20.64 (plan step P3-2b): the mirror's pages, and global's resends. */
  replication?: ReplicationHandlers
}

export interface ReplicationHandlers {
  /** Where each captured org's journal stands. */
  status: () => Promise<Record<string, unknown>>
  /** The next page above global's watermark: its bytes, nothing to send, or why not. */
  page: (body: unknown) => Promise<
    | { status: 200; bytes: Uint8Array; fromSeq: number; toSeq: number; chainHash: string; rows: number }
    | { status: 204 }
    | { status: 409; refused: string; detail: string }
  >
  /** Global's resend after a collision, as it sent it (EJSON: the ids keep their types). */
  resend: (text: string) => Promise<{ journaled: number }>
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

export function startControlSocket(path: string, secret: string, handlers: ControlHandlers): { close: () => void } {
  mkdirSync(dirname(path), { recursive: true })
  // A socket left by a crash would make the bind fail, and its directory belongs to us alone.
  rmSync(path, { force: true })
  const answer = async (request: Request, srv: { timeout: (req: Request, seconds: number) => void }): Promise<Response> => {
    if (!secretMatches(request.headers.get(FRONT_HEADER), secret)) return json(403, { code: 'front_required' })
    const { pathname } = new URL(request.url)
    if (request.method === 'GET' && pathname === '/status') return json(200, await handlers.status())
    if (request.method === 'POST' && pathname === '/backup' && handlers.backup) {
      // Awaited: the helper switches only on an answer that says the backup is done. ⚠ Bun closes a
      // connection idle for 10 s, and a backup may take minutes: this one request has no idle limit.
      srv.timeout(request, 0)
      const result = await handlers.backup()
      return json(result.ok ? 200 : 500, result)
    }
    if (handlers.replication && (pathname === '/replication' || pathname.startsWith('/replication/'))) {
      try {
        return await replicationRoute(request, pathname, handlers.replication, srv)
      } catch (e: any) {
        // A malformed ask is the supervisor's bug, said back to it; anything else is the API's.
        if (e?.status === 400) return json(400, { code: 'bad_request', message: String(e.message ?? e) })
        throw e
      }
    }
    if (request.method === 'POST' && pathname === '/stop') {
      // Answered first: the stop closes this socket, and the supervisor waits for the exit.
      setTimeout(() => handlers.stop('control socket'), 0)
      return json(202, { ok: true, stopping: true })
    }
    return json(404, { code: 'not_found' })
  }
  // A handler, not an outbound call: named, so the FR-20.53 deadline scan does not read it as one.
  const server = Bun.serve({ unix: path, fetch: answer, maxRequestBodySize: 1024 * 1024 })
  // Its directory already keeps everyone else out; on Unix the socket says so too.
  if (process.platform !== 'win32') chmodSync(path, 0o600)
  return {
    close: () => {
      server.stop(true)
      rmSync(path, { force: true })
    },
  }
}

/**
 * `GET /replication`, `POST /replication/page` (JSON ask; the page's bytes, 204 when there is nothing
 * to send, 409 with the reason), `POST /replication/resend` (EJSON).
 */
async function replicationRoute(request: Request, pathname: string, r: ReplicationHandlers, srv: { timeout: (req: Request, seconds: number) => void }): Promise<Response> {
  if (request.method === 'GET' && pathname === '/replication') return json(200, await r.status())
  if (request.method === 'POST' && pathname === '/replication/page') {
    // A page of 1,000 documents is read in one snapshot: more than Bun's 10 s idle on a slow till PC.
    srv.timeout(request, 60)
    const answer = await r.page(await request.json().catch(() => null))
    if (answer.status === 204) return new Response(null, { status: 204 })
    if (answer.status === 409) return json(409, { refused: answer.refused, detail: answer.detail })
    return new Response(answer.bytes as Uint8Array<ArrayBuffer>, {
      status: 200,
      headers: {
        'content-type': 'application/x-lgr-page',
        'x-lgr-page-from': String(answer.fromSeq),
        'x-lgr-page-to': String(answer.toSeq),
        'x-lgr-page-hash': answer.chainHash,
        'x-lgr-page-rows': String(answer.rows),
      },
    })
  }
  if (request.method === 'POST' && pathname === '/replication/resend') return json(200, await r.resend(await request.text()))
  return json(404, { code: 'not_found' })
}
