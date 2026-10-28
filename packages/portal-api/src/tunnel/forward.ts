/**
 * Forwarding to the pod that holds a server's uplink (FR-20.73, plan step P3-4d). A request to an
 * org's address lands on whichever of lgrai.app's pods the edge picks; when the server's interactive
 * socket is on another, this pod hands the request there, as a hop (`hop.ts`), and passes the answer
 * back as it comes.
 *
 * - **Which pod**: the uplink's presence row (`node_presence`), while it is fresh (75 s, the uplink's
 *   own liveness rule) and names another pod's address. A row under a clone alarm is never followed.
 * - **HTTP** is streamed both ways: the request body as the browser sends it, the answer as the other
 *   pod sends it, compressed or not, byte for byte.
 * - **A WebSocket** is accepted here and opened on the other pod; messages travel both ways as they
 *   are, the browser's first ones held until the other side is open.
 * - The other pod unreachable: the router answers that the server is not connected.
 */
import { NodePresence } from 'db/models'
import { hopHeaders } from './hop.js'
import { podAddr } from './pod.js'

/** The uplink's own liveness rule (`uplink.ts`): a row silent this long holds nothing. */
const DEAD_AFTER_MS = 75_000
/** Browser messages held while the other pod's socket opens. */
const WS_PENDING_MAX = 256 * 1024

/** One connection's own headers, never a forwarded request's. */
const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-connection', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'proxy-authorization', 'proxy-authenticate'])

/** The address of the pod that holds `nodeId`'s interactive socket now, when that is another pod. */
export async function holderOf(nodeId: string, now = Date.now()): Promise<string | null> {
  const row: any = await NodePresence.findOne(
    { nodeId, channel: 'interactive', heartbeatAt: { $gt: new Date(now - DEAD_AFTER_MS) } },
    { podAddr: 1, clone: 1 },
  ).lean()
  if (!row?.podAddr || row.clone) return null
  return row.podAddr !== podAddr() ? String(row.podAddr) : null
}

function forwardedHeaders(request: Request, client: string | null, extraDrop: (name: string) => boolean): Record<string, string> {
  const url = new URL(request.url)
  const host = request.headers.get('host') ?? url.host
  const out: Record<string, string> = {}
  request.headers.forEach((value, name) => {
    const n = name.toLowerCase()
    if (HOP_BY_HOP.has(n) || n === 'host' || n.startsWith('x-lgr-hop') || extraDrop(n)) return
    out[n] = value
  })
  out.host = host
  return Object.assign(out, hopHeaders(request.method, host, url.pathname + url.search, client))
}

/** The request, through the other pod. Null when that pod cannot be reached. */
export async function forwardHttp(to: string, request: Request, client: string | null): Promise<Response | null> {
  const url = new URL(request.url)
  // The body is streamed, so its length is the transfer's to state.
  const headers = forwardedHeaders(request, client, n => n === 'content-length')
  const body = request.method === 'GET' || request.method === 'HEAD' ? undefined : request.body ?? undefined
  let res: Response
  try {
    res = await fetch(`${to}${url.pathname}${url.search}`, {
      method: request.method,
      headers,
      body,
      redirect: 'manual',
      signal: request.signal,
      // Byte for byte: the browser decodes what the server encoded.
      decompress: false,
      ...(body ? { duplex: 'half' } : {}),
    } as RequestInit)
  } catch {
    return null
  }
  const out = new Headers()
  res.headers.forEach((value, name) => {
    if (!HOP_BY_HOP.has(name) && name !== 'set-cookie') out.append(name, value)
  })
  for (const c of res.headers.getSetCookie()) out.append('set-cookie', c)
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: out })
}

const browserCode = (c: number) => (c === 1000 || (c >= 1007 && c <= 1014) || (c >= 3000 && c <= 4999) ? c : 1011)
const serverCode = (c: number) => (c === 1000 || (c >= 3000 && c <= 4999) ? c : 1000)

/** A browser's WebSocket, accepted here and opened on the other pod. False when the upgrade failed. */
export function forwardWebSocket(to: string, request: Request, client: string | null, server: any): boolean {
  const url = new URL(request.url)
  const headers = forwardedHeaders(request, client, n => n.startsWith('sec-websocket-') || n === 'content-length')
  const protocols = (request.headers.get('sec-websocket-protocol') ?? '').split(',').map(s => s.trim()).filter(Boolean)
  let upstream: WebSocket | null = null
  let pending: Array<string | Uint8Array> = []
  let pendingBytes = 0
  let browserGone = false
  return server.upgrade(request, {
    data: {
      open(browser: any) {
        try {
          upstream = new WebSocket(`${to.replace(/^http/, 'ws')}${url.pathname}${url.search}`, { headers, ...(protocols.length ? { protocols } : {}) } as any)
        } catch {
          try { browser.close(1011, 'The server could not be reached.') } catch { /* closed */ }
          return
        }
        upstream.binaryType = 'arraybuffer'
        upstream.onopen = () => {
          for (const m of pending) upstream!.send(m)
          pending = []
          pendingBytes = 0
        }
        upstream.onmessage = e => {
          try { browser.send(typeof e.data === 'string' ? e.data : new Uint8Array(e.data as ArrayBuffer)) } catch { /* closed */ }
        }
        upstream.onclose = e => {
          if (browserGone) return
          try { browser.close(browserCode(e.code), String(e.reason ?? '').slice(0, 120)) } catch { /* closed */ }
        }
      },
      message(browser: any, m: string | Buffer) {
        const data = typeof m === 'string' ? m : new Uint8Array(m)
        if (upstream && upstream.readyState === WebSocket.OPEN) {
          upstream.send(data)
          return
        }
        pending.push(data)
        pendingBytes += typeof data === 'string' ? data.length : data.byteLength
        if (pendingBytes > WS_PENDING_MAX) {
          try { browser.close(1009, 'Too much was sent before the server answered.') } catch { /* closed */ }
        }
      },
      close(_browser: any, code: number, reason: string) {
        browserGone = true
        try { upstream?.close(serverCode(code), String(reason ?? '').slice(0, 120)) } catch { /* closed */ }
      },
    },
  })
}
