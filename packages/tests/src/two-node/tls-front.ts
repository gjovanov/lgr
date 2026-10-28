import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * A local TLS/WSS terminator with a throwaway test CA (FR-20 plan Part F.2, step T-1), so the uplink
 * in the two-node harness speaks HTTPS and WSS as a master speaks them to lgrai.app: certificate
 * checks on, through a front that forwards to the plain-HTTP API behind it.
 *
 * The CA is minted per run with the `openssl` CLI (CI and Git for Windows both carry one): no key is
 * ever committed, and none outlives the run by more than a day.
 */
export interface TestCa {
  /** PEM of the CA certificate: what a client trusts. */
  ca: string
  /** PEM of the server certificate, for localhost and 127.0.0.1, and its key. */
  cert: string
  key: string
}

function openssl(dir: string, ...args: string[]): void {
  const r = Bun.spawnSync(['openssl', ...args], { cwd: dir, stderr: 'pipe', stdout: 'pipe' })
  if (r.exitCode !== 0) throw new Error(`openssl ${args[0]}: ${r.stderr.toString()}`)
}

export function makeTestCa(dir: string): TestCa {
  mkdirSync(dir, { recursive: true })
  const ec = ['-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes']
  openssl(dir, 'req', '-x509', ...ec, '-keyout', 'ca.key', '-out', 'ca.crt', '-days', '1', '-subj', '/CN=LGR two-node test CA')
  openssl(dir, 'req', ...ec, '-keyout', 'server.key', '-out', 'server.csr', '-subj', '/CN=localhost')
  writeFileSync(join(dir, 'server.ext'), [
    'subjectAltName=DNS:localhost,IP:127.0.0.1',
    'basicConstraints=CA:FALSE',
    'keyUsage=digitalSignature,keyEncipherment',
    'extendedKeyUsage=serverAuth',
  ].join('\n') + '\n')
  openssl(dir, 'x509', '-req', '-in', 'server.csr', '-CA', 'ca.crt', '-CAkey', 'ca.key', '-CAcreateserial',
    '-out', 'server.crt', '-days', '1', '-extfile', 'server.ext')
  const read = (f: string) => readFileSync(join(dir, f), 'utf8')
  return { ca: read('ca.crt'), cert: read('server.crt'), key: read('server.key') }
}

export interface TlsFront {
  readonly port: number
  close(): void
}

interface Upgrade { target: string; protocols?: string }

/**
 * A close code `close()` accepts. 1005 (no status), 1006 (abnormal) and 1015 (TLS) are only ever
 * REPORTED, never sent, and passing one on throws; an abnormal end goes on as 1011.
 */
const sendable = (code: number) => (code === 1000 || (code >= 1001 && code <= 1014 && ![1004, 1005, 1006].includes(code)) || (code >= 3000 && code <= 4999) ? code : code === 1005 ? 1000 : 1011)

/**
 * Terminates TLS on its own port and forwards to `target` (plain HTTP): requests as requests, and a
 * WebSocket upgrade as a WebSocket to the same path on `target`, message for message.
 */
export function tlsFront(target: { hostname: string; port: number }, tls: TestCa): TlsFront {
  const base = `${target.hostname}:${target.port}`
  const server = Bun.serve<Upgrade, never>({
    hostname: '127.0.0.1',
    port: 0,
    tls: { cert: tls.cert, key: tls.key },
    async fetch(req, srv) {
      const url = new URL(req.url)
      if (req.headers.get('upgrade')?.toLowerCase() === 'websocket') {
        const ok = srv.upgrade(req, {
          data: { target: `ws://${base}${url.pathname}${url.search}`, protocols: req.headers.get('sec-websocket-protocol') ?? undefined },
        })
        return ok ? undefined : new Response('Upgrade failed', { status: 400 })
      }
      const headers = new Headers(req.headers)
      headers.set('x-forwarded-proto', 'https')
      return fetch(`http://${base}${url.pathname}${url.search}`, {
        method: req.method,
        headers,
        body: req.method === 'GET' || req.method === 'HEAD' ? undefined : await req.arrayBuffer(),
        redirect: 'manual',
      })
    },
    websocket: {
      open(ws) {
        const upstream = new WebSocket(ws.data.target, ws.data.protocols ? ws.data.protocols.split(',').map(s => s.trim()) : undefined)
        ;(ws as any).upstream = upstream
        ;(ws as any).pending = [] as Array<string | Buffer>
        upstream.binaryType = 'arraybuffer'
        upstream.onopen = () => {
          for (const m of (ws as any).pending) upstream.send(m)
          ;(ws as any).pending = null
        }
        upstream.onmessage = e => ws.send(typeof e.data === 'string' ? e.data : new Uint8Array(e.data as ArrayBuffer))
        upstream.onclose = e => ws.close(sendable(e.code), e.reason)
        upstream.onerror = () => ws.close(1011, 'upstream failed')
      },
      message(ws, message) {
        const upstream: WebSocket = (ws as any).upstream
        if ((ws as any).pending) (ws as any).pending.push(message)
        else upstream.send(message)
      },
      close(ws, code, reason) {
        const upstream: WebSocket | undefined = (ws as any).upstream
        if (upstream && upstream.readyState <= 1) upstream.close(sendable(code), reason)
      },
    },
  })
  return { port: server.port, close: () => server.stop(true) }
}
