/**
 * The tunnel's streams on lgrai.app (FR-20.73, plan step P3-4b): a browser's request to an org's
 * address, carried over its server's interactive uplink socket, and the server's answer back.
 *
 * - **HTTP**: `tun-open`, then the request body in data frames within the credit the server grants;
 *   the server's `tun-head` becomes the `Response`, whose body streams from its data frames, granted
 *   back as the browser reads them. A slow browser holds back its own stream, never the socket.
 * - **WebSocket**: the browser's socket is accepted here; its messages wait until the server says its
 *   API accepted the upgrade (`tun-ws-open`), then travel both ways as whole messages.
 * - **Idle**: an HTTP stream that moves no byte for 120 s is closed (FR-20.73). A WebSocket is not
 *   timed: it may wait for news for hours, and ends with either side or the link.
 * - **The link drops**: every stream on it fails. A GET or HEAD that had no answer yet is tried once
 *   more on the server's next socket (FR-20.73: idempotent GETs are retried once); nothing else is.
 */
import {
  TUN_CHUNK, TUN_IDLE_MS, TUN_KIND, TUN_MAX_STREAMS, TUN_WINDOW,
  decodeTunFrame, encodeTunFrame, requestHeadersForTunnel, responseHeadersFromTunnel,
} from 'services/biz/tunnel/tunnel-frame'
import { tunnelSocketOf } from './sockets.js'

/** The largest WebSocket message carried: the app's are small (progress, notices). */
const WS_MESSAGE_MAX = 1024 * 1024
/** Browser messages held while the server's API has not yet accepted the upgrade. */
const WS_PENDING_MAX = 256 * 1024

export class TunnelError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
  }
}

interface Base {
  sid: number
  nodeId: string
  ws: any
  idle: ReturnType<typeof setTimeout> | null
  closed: boolean
}
interface Http extends Base {
  kind: 'http'
  /** Bytes of the request body the server still lets us send. */
  sendCredit: number
  waiters: Array<() => void>
  head: { resolve(r: Response): void; reject(e: Error): void; noBody: boolean } | null
  body: ReadableStreamDefaultController<Uint8Array> | null
  /** Response bytes handed to the browser and not yet granted back. */
  ungranted: number
}
interface Ws extends Base {
  kind: 'ws'
  browser: any
  open: boolean
  pending: Array<{ text: boolean; data: Uint8Array }>
  pendingBytes: number
}
type Stream = Http | Ws

const key = (ws: any) => ws?.raw ?? ws
const byWs = new WeakMap<any, Map<number, Stream>>()
let nextSid = 0
let idleMs = TUN_IDLE_MS

/** Tests only: a shorter idle limit. */
export function setTunnelIdleMs(ms: number): void {
  idleMs = ms
}

function streamsOf(ws: any): Map<number, Stream> {
  let m = byWs.get(key(ws))
  if (!m) {
    m = new Map()
    byWs.set(key(ws), m)
  }
  return m
}

function sendJson(ws: any, msg: unknown): void {
  try {
    ws.send(JSON.stringify(msg))
  } catch {
    /* gone: its close fails the streams */
  }
}

/** Binary, never JSON: Elysia's wrapper turns anything but a Buffer into text. */
function sendBin(ws: any, bytes: Uint8Array): void {
  try {
    const raw = key(ws)
    if (typeof raw?.sendBinary === 'function') raw.sendBinary(bytes)
    else ws.send(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength))
  } catch {
    /* gone */
  }
}

function newSid(): number {
  nextSid = nextSid >= 0xffffffff ? 1 : nextSid + 1
  return nextSid
}

function touch(s: Stream): void {
  if (s.kind !== 'http') return
  if (s.idle) clearTimeout(s.idle)
  s.idle = setTimeout(() => fail(s, 'idle', 'The server moved nothing for 120 s.'), idleMs)
}

function finish(s: Stream): void {
  s.closed = true
  if (s.idle) clearTimeout(s.idle)
  streamsOf(s.ws).delete(s.sid)
}

/** End a stream from this side, telling the server; the browser learns of it as it can. */
function fail(s: Stream, code: string, message: string, tellServer = true): void {
  if (s.closed) return
  if (tellServer) sendJson(s.ws, { t: 'tun-cancel', sid: s.sid })
  if (s.kind === 'http') {
    if (s.head) {
      s.head.reject(new TunnelError(code, message))
      s.head = null
    } else if (s.body) {
      try { s.body.error(new TunnelError(code, message)) } catch { /* closed */ }
    }
    for (const w of s.waiters.splice(0)) w()
  } else {
    try { s.browser?.close(code === 'link_lost' ? 1012 : 1011, message.slice(0, 120)) } catch { /* closed */ }
  }
  finish(s)
}

/** Give the server back what the browser has read. */
function grant(s: Http): void {
  if (s.closed || s.ungranted <= 0) return
  sendJson(s.ws, { t: 'tun-credit', sid: s.sid, bytes: s.ungranted })
  s.ungranted = 0
}

async function pumpBody(s: Http, body: ReadableStream<Uint8Array>): Promise<void> {
  const reader = body.getReader()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (s.closed) {
        reader.cancel().catch(() => {})
        return
      }
      if (done) break
      // As much as the credit allows, a chunk at a time: the window is used whole, never exceeded.
      for (let at = 0; at < value.length; ) {
        while (s.sendCredit <= 0 && !s.closed) await new Promise<void>(r => s.waiters.push(r))
        if (s.closed) return
        const n = Math.min(TUN_CHUNK, value.length - at, s.sendCredit)
        sendBin(s.ws, encodeTunFrame({ kind: TUN_KIND.body, sid: s.sid, payload: value.subarray(at, at + n) }))
        s.sendCredit -= n
        at += n
        touch(s)
      }
    }
    sendBin(s.ws, encodeTunFrame({ kind: TUN_KIND.body, sid: s.sid, end: true }))
  } catch {
    fail(s, 'body', 'The request body could not be read.')
  }
}

export interface TunnelRequest {
  nodeId: string
  request: Request
  clientIp: string | null
}

function open(ws: any, s: Stream, extra: Record<string, unknown>): void {
  sendJson(ws, { t: 'tun-open', sid: s.sid, ...extra })
}

async function tryHttp({ nodeId, request, clientIp }: TunnelRequest, body: ReadableStream<Uint8Array> | null): Promise<Response> {
  const ws = tunnelSocketOf(nodeId)
  if (!ws) throw new TunnelError('offline', 'The server is not connected.')
  const streams = streamsOf(ws)
  if (streams.size >= TUN_MAX_STREAMS) throw new TunnelError('busy', 'The server has too many requests open.')
  const url = new URL(request.url)
  const s: Http = { kind: 'http', sid: newSid(), nodeId, ws, idle: null, closed: false, sendCredit: TUN_WINDOW, waiters: [], head: null, body: null, ungranted: 0 }
  const answer = new Promise<Response>((resolve, reject) => {
    s.head = { resolve, reject, noBody: request.method === 'HEAD' }
  })
  streams.set(s.sid, s)
  touch(s)
  open(ws, s, {
    kind: 'http', method: request.method, path: url.pathname + url.search, host: request.headers.get('host') ?? url.host,
    headers: requestHeadersForTunnel(request.headers), client: { ip: clientIp }, body: !!body,
  })
  request.signal?.addEventListener?.('abort', () => fail(s, 'cancelled', 'The browser went away.'))
  if (body) void pumpBody(s, body)
  return answer
}

/**
 * The browser's request, through the server's socket. Throws a `TunnelError` when it never reached
 * an answer (`offline`, `busy`, `link_lost`, the server's own `tun-error`); the router answers those.
 */
export async function tunnelHttp(req: TunnelRequest): Promise<Response> {
  const method = req.request.method
  const body = method === 'GET' || method === 'HEAD' ? null : req.request.body
  try {
    return await tryHttp(req, body)
  } catch (e) {
    // FR-20.73: an idempotent GET is tried once more when the link dropped before any answer.
    if (e instanceof TunnelError && e.code === 'link_lost' && (method === 'GET' || method === 'HEAD')) {
      for (let i = 0; i < 25 && !tunnelSocketOf(req.nodeId); i++) await Bun.sleep(200)
      return tryHttp(req, null)
    }
    throw e
  }
}

/**
 * A browser's WebSocket to the address: accepted here, opened on the server once its socket is. False
 * when the server has no socket here (the router answers instead) or the upgrade failed.
 */
export function tunnelWebSocket({ nodeId, request, clientIp }: TunnelRequest, server: any): boolean {
  const ws = tunnelSocketOf(nodeId)
  if (!ws) return false
  const streams = streamsOf(ws)
  if (streams.size >= TUN_MAX_STREAMS) return false
  const url = new URL(request.url)
  const s: Ws = { kind: 'ws', sid: newSid(), nodeId, ws, idle: null, closed: false, browser: null, open: false, pending: [], pendingBytes: 0 }
  const headers = requestHeadersForTunnel(request.headers)
  const host = request.headers.get('host') ?? url.host
  const protocol = request.headers.get('sec-websocket-protocol')
  return server.upgrade(request, {
    data: {
      open(browser: any) {
        s.browser = browser
        streams.set(s.sid, s)
        open(ws, s, { kind: 'ws', method: 'GET', path: url.pathname + url.search, host, headers: protocol ? [...headers, ['sec-websocket-protocol', protocol]] : headers, client: { ip: clientIp }, body: false })
      },
      message(browser: any, m: string | Buffer) {
        if (s.closed) return
        const text = typeof m === 'string'
        const data = text ? new TextEncoder().encode(m as string) : new Uint8Array(m as Buffer)
        if (data.length > WS_MESSAGE_MAX) {
          fail(s, 'too_big', 'A message is too large for the tunnel.')
          return
        }
        if (!s.open) {
          s.pending.push({ text, data })
          s.pendingBytes += data.length
          if (s.pendingBytes > WS_PENDING_MAX) fail(s, 'too_big', 'Too much was sent before the server answered.')
          return
        }
        sendBin(ws, encodeTunFrame({ kind: text ? TUN_KIND.wsText : TUN_KIND.wsBinary, sid: s.sid, payload: data }))
      },
      close(_browser: any, code: number, reason: string) {
        if (s.closed) return
        sendJson(ws, { t: 'tun-ws-close', sid: s.sid, code: Number.isInteger(code) ? code : 1000, reason: String(reason ?? '').slice(0, 120) })
        finish(s)
      },
    },
  })
}

/** A control frame of the tunnel from the server (`t` starting with `tun-`). */
export function onTunnelControl(ws: any, msg: any): void {
  const s = streamsOf(ws).get(Number(msg.sid))
  if (!s || s.closed) return
  switch (msg.t) {
    case 'tun-head': {
      const status = Number.isInteger(msg.status) && msg.status >= 100 && msg.status <= 599 ? msg.status : 502
      if (s.kind === 'ws') {
        // The server's API refused the upgrade.
        try { s.browser?.close(status === 401 || status === 403 ? 1008 : 1011, `refused (${status})`) } catch { /* closed */ }
        finish(s)
        return
      }
      if (!s.head) return
      touch(s)
      const headers = responseHeadersFromTunnel(msg.headers)
      const noBody = s.head.noBody || status === 204 || status === 304
      const stream = noBody
        ? null
        : new ReadableStream<Uint8Array>(
            {
              start(c) { s.body = c },
              pull() { grant(s) },
              cancel() { fail(s, 'cancelled', 'The browser went away.') },
            },
            { highWaterMark: TUN_WINDOW, size: chunk => chunk.byteLength },
          )
      s.head.resolve(new Response(stream, { status, headers }))
      s.head = null
      return
    }
    case 'tun-credit': {
      if (s.kind !== 'http') return
      const bytes = Number(msg.bytes)
      if (!Number.isSafeInteger(bytes) || bytes <= 0 || bytes > 64 * TUN_WINDOW) return
      s.sendCredit += bytes
      for (const w of s.waiters.splice(0)) w()
      return
    }
    case 'tun-error':
      fail(s, typeof msg.code === 'string' ? msg.code.slice(0, 40) : 'server_error', typeof msg.message === 'string' ? msg.message.slice(0, 300) : 'The server could not answer.', false)
      return
    case 'tun-ws-open':
      if (s.kind !== 'ws') return
      s.open = true
      for (const p of s.pending.splice(0)) sendBin(ws, encodeTunFrame({ kind: p.text ? TUN_KIND.wsText : TUN_KIND.wsBinary, sid: s.sid, payload: p.data }))
      s.pendingBytes = 0
      return
    case 'tun-ws-close':
      if (s.kind !== 'ws') return
      try {
        const code = Number.isInteger(msg.code) && (msg.code === 1000 || (msg.code >= 3000 && msg.code <= 4999)) ? msg.code : 1000
        s.browser?.close(code, typeof msg.reason === 'string' ? msg.reason.slice(0, 120) : '')
      } catch { /* closed */ }
      finish(s)
      return
  }
}

/** A data frame of the tunnel from the server: a response body chunk, or a WebSocket message. */
export function onTunnelData(ws: any, bytes: Uint8Array): void {
  const f = decodeTunFrame(bytes)
  if (!f) return
  const s = streamsOf(ws).get(f.sid)
  if (!s || s.closed) return
  if (s.kind === 'http') {
    if (f.kind !== TUN_KIND.body) return
    touch(s)
    if (s.body && f.payload.length) {
      // A copy: the frame's buffer belongs to the socket.
      s.body.enqueue(f.payload.slice())
      s.ungranted += f.payload.length
      if ((s.body.desiredSize ?? 0) > 0 && s.ungranted >= TUN_CHUNK) grant(s)
    }
    if (f.end) {
      try { s.body?.close() } catch { /* cancelled */ }
      finish(s)
    }
    return
  }
  if (f.kind === TUN_KIND.wsText) {
    try { s.browser?.send(new TextDecoder().decode(f.payload)) } catch { /* closed */ }
  } else if (f.kind === TUN_KIND.wsBinary) {
    try { s.browser?.send(f.payload.slice()) } catch { /* closed */ }
  }
}

/** The server's socket closed: every stream on it fails. */
export function onTunnelSocketClosed(ws: any): void {
  const streams = byWs.get(key(ws))
  if (!streams) return
  for (const s of [...streams.values()]) fail(s, 'link_lost', 'The server\'s link dropped.', false)
  byWs.delete(key(ws))
}

/** How many streams a socket carries now: the status of a node, and the tests. */
export function openStreams(ws: any): number {
  return byWs.get(key(ws))?.size ?? 0
}
