/**
 * The tunnel's wire (FR-20.73, plan step P3-4b): streams multiplexed over a master's interactive
 * uplink socket, so that `<label>.lgrai.app` reaches the org's server. The supervisor's
 * `packages/server/src/tunnel.rs` speaks the same.
 *
 * **Control frames** are JSON (`t`), like every other on that socket:
 * - global → master: `tun-open {sid, kind: 'http' | 'ws', method, path, headers, client: {ip}, body}`;
 *   `tun-credit {sid, bytes}`; `tun-cancel {sid}`; `tun-ws-close {sid, code, reason}`.
 * - master → global: `tun-head {sid, status, headers}` (an HTTP response, or a WebSocket the API
 *   refused); `tun-ws-open {sid, protocol?}`; `tun-credit {sid, bytes}`; `tun-error {sid, code,
 *   message}`; `tun-ws-close {sid, code, reason}`.
 *
 * **Data frames** are binary, behind their own magic (`LGRT`, as pages are zstd and file chunks
 * `LGRB`): `LGRT | version | kind | flags | sid (u32 BE) | payload`. `kind` is a body chunk, or a
 * WebSocket text or binary message; `flags & 1` ends a body.
 *
 * **Flow control:** each side may send `TUN_WINDOW` bytes of a stream's body before the other
 * grants more (`tun-credit`), as it consumes them: a slow browser or API never fills the socket that
 * every other request, and the server's pings, share.
 *
 * Import-pure.
 */

export const TUN_MAGIC = [0x4c, 0x47, 0x52, 0x54] // 'LGRT'
export const TUN_VERSION = 1
export const TUN_HEADER = 11
export const TUN_KIND = { body: 0, wsText: 1, wsBinary: 2 } as const
export type TunKind = (typeof TUN_KIND)[keyof typeof TUN_KIND]
export const TUN_FLAG_END = 1
/** The most one data frame carries: an upload or a download never holds the socket for long. */
export const TUN_CHUNK = 64 * 1024
/** What each side may have in flight per stream before the other grants more. */
export const TUN_WINDOW = 256 * 1024
/** FR-20.73: a stream that moves no byte for this long is closed. */
export const TUN_IDLE_MS = 120_000
/** Streams one server may have open through lgrai.app at once. */
export const TUN_MAX_STREAMS = 256

export interface TunFrame {
  kind: TunKind
  sid: number
  end: boolean
  payload: Uint8Array
}

export function isTunFrame(b: Uint8Array): boolean {
  return b.length >= TUN_HEADER && TUN_MAGIC.every((x, i) => b[i] === x)
}

export function encodeTunFrame(f: { kind: TunKind; sid: number; end?: boolean; payload?: Uint8Array }): Uint8Array {
  const payload = f.payload ?? new Uint8Array(0)
  const out = new Uint8Array(TUN_HEADER + payload.length)
  out.set(TUN_MAGIC, 0)
  out[4] = TUN_VERSION
  out[5] = f.kind
  out[6] = f.end ? TUN_FLAG_END : 0
  new DataView(out.buffer).setUint32(7, f.sid >>> 0, false)
  out.set(payload, TUN_HEADER)
  return out
}

/** A data frame, or null when these bytes are not one this version reads. */
export function decodeTunFrame(b: Uint8Array): TunFrame | null {
  if (!isTunFrame(b) || b[4] !== TUN_VERSION) return null
  const kind = b[5]
  if (kind !== TUN_KIND.body && kind !== TUN_KIND.wsText && kind !== TUN_KIND.wsBinary) return null
  const sid = new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(7, false)
  return { kind: kind as TunKind, sid, end: (b[6] & TUN_FLAG_END) !== 0, payload: b.subarray(TUN_HEADER) }
}

/** Hop-by-hop headers: they describe one connection, never the stream through the tunnel. */
const HOP = new Set(['connection', 'keep-alive', 'proxy-connection', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'proxy-authorization', 'proxy-authenticate', 'host', 'content-length'])

/**
 * The request's headers as they cross (FR-20.73): no hop-by-hop ones, none named by `Connection`, no
 * client-supplied `X-LGR-*` (the supervisor stamps the source and the client), and no forwarding
 * headers a client could forge. `Host` travels apart: the master answers to the org's address.
 */
export function requestHeadersForTunnel(headers: Headers): Array<[string, string]> {
  const named = new Set((headers.get('connection') ?? '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean))
  const out: Array<[string, string]> = []
  headers.forEach((value, name) => {
    const n = name.toLowerCase()
    if (HOP.has(n) || named.has(n) || n.startsWith('x-lgr-') || n === 'forwarded' || n.startsWith('x-forwarded-') || n === 'x-real-ip') return
    // The WebSocket handshake's own headers are the master's API's to make again.
    if (n.startsWith('sec-websocket-')) return
    out.push([n, value])
  })
  return out
}

/** A `Set-Cookie` with any `Domain` attribute taken out: a master's cookies stay on its own address (FR-20.72). */
export function stripCookieDomain(setCookie: string): string {
  return setCookie
    .split(';')
    .filter((part, i) => i === 0 || !/^\s*domain\s*=/i.test(part))
    .join(';')
}

/** The response's headers as the browser gets them: no hop-by-hop ones, every cookie host-only. */
export function responseHeadersFromTunnel(pairs: unknown): Headers {
  const out = new Headers()
  if (!Array.isArray(pairs)) return out
  for (const p of pairs.slice(0, 200)) {
    if (!Array.isArray(p) || typeof p[0] !== 'string' || typeof p[1] !== 'string') continue
    const n = p[0].toLowerCase()
    if (HOP.has(n) || n.length > 100 || p[1].length > 16_384) continue
    out.append(n, n === 'set-cookie' ? stripCookieDomain(p[1]) : p[1])
  }
  return out
}
