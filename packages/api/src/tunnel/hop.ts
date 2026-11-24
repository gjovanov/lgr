/**
 * A request one of lgrai.app's pods forwards to another (FR-20.73, plan step P3-4d), and how the
 * other knows it is one: `X-LGR-Hop: <unix seconds>.<HMAC>` over the time, the method, the `Host`,
 * the path and the browser's address (`X-LGR-Hop-Client`). The key is derived from the app's own
 * secret, which every pod holds and nothing outside them does.
 *
 * - A hop is never forwarded again, and is not counted against the edge's limits a second time.
 * - It keeps the browser's address, not the forwarding pod's.
 * - A hop that does not verify (forged, altered, older than 30 s) is no hop: the request is handled
 *   as the client's own. The headers never reach the server either way, since the tunnel drops
 *   every `X-LGR-*`.
 */
import { createHmac, timingSafeEqual } from 'node:crypto'
import { config } from 'config'

const MAX_SKEW_S = 30
/** The tunnel's hop (FR-20.73). */
export const TUNNEL_HOP = 'lgr-tunnel-hop/1'
/** FR-24.51: a till request forwarded to the pod holding its printer. Its own key: neither passes for the other. */
export const FISCAL_HOP = 'lgr-fiscal-hop/1'
const keys = new Map<string, Buffer>()

function mac(ts: number, method: string, host: string, path: string, client: string, label = TUNNEL_HOP): string {
  let key = keys.get(label)
  if (!key) {
    key = createHmac('sha256', config.jwt.secret).update(label).digest()
    keys.set(label, key)
  }
  return createHmac('sha256', key).update(`${ts}\n${method.toUpperCase()}\n${host.toLowerCase()}\n${path}\n${client}`).digest('base64url')
}

/** The headers that make a forwarded request a hop. `path` includes the query. */
export function hopHeaders(method: string, host: string, path: string, client: string | null, now = Date.now(), label = TUNNEL_HOP): Record<string, string> {
  const ts = Math.floor(now / 1000)
  return { 'x-lgr-hop': `${ts}.${mac(ts, method, host, path, client ?? '', label)}`, 'x-lgr-hop-client': client ?? '' }
}

/** The browser's address when this request is a hop from another pod; null when it is not one. */
export function verifyHop(request: Request, now = Date.now(), label = TUNNEL_HOP): { clientIp: string | null } | null {
  const m = /^(\d{1,12})\.([A-Za-z0-9_-]{43})$/.exec(request.headers.get('x-lgr-hop') ?? '')
  if (!m) return null
  const ts = Number(m[1])
  if (Math.abs(now / 1000 - ts) > MAX_SKEW_S) return null
  const url = new URL(request.url)
  const client = request.headers.get('x-lgr-hop-client') ?? ''
  const want = Buffer.from(mac(ts, request.method, request.headers.get('host') ?? url.host, url.pathname + url.search, client, label))
  const got = Buffer.from(m[2])
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null
  return { clientIp: client || null }
}

/** Tests only: a new secret makes a new key. */
export function forgetHopKey(): void {
  keys.clear()
}
