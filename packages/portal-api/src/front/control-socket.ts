/**
 * FR-20.16 / FR-20.23 (plan step P1-3) — the API's control socket: `status` and `stop`, for the
 * supervisor and nothing else. Replication pages join it in P3.
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
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

export function startControlSocket(path: string, secret: string, handlers: ControlHandlers): { close: () => void } {
  mkdirSync(dirname(path), { recursive: true })
  // A socket left by a crash would make the bind fail, and its directory belongs to us alone.
  rmSync(path, { force: true })
  const answer = async (request: Request): Promise<Response> => {
    if (!secretMatches(request.headers.get(FRONT_HEADER), secret)) return json(403, { code: 'front_required' })
    const { pathname } = new URL(request.url)
    if (request.method === 'GET' && pathname === '/status') return json(200, await handlers.status())
    if (request.method === 'POST' && pathname === '/stop') {
      // Answered first: the stop closes this socket, and the supervisor waits for the exit.
      setTimeout(() => handlers.stop('control socket'), 0)
      return json(202, { ok: true, stopping: true })
    }
    return json(404, { code: 'not_found' })
  }
  // A handler, not an outbound call: named, so the FR-20.53 deadline scan does not read it as one.
  const server = Bun.serve({ unix: path, fetch: answer })
  // Its directory already keeps everyone else out; on Unix the socket says so too.
  if (process.platform !== 'win32') chmodSync(path, 0o600)
  return {
    close: () => {
      server.stop(true)
      rmSync(path, { force: true })
    },
  }
}
