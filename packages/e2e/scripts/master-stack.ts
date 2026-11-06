/**
 * FR-20 Part F.3, the e2e `master` project: a master as a till on its LAN sees it, and Playwright's
 * `master` project run against it.
 *
 *   bun run build                                     # the web app the master serves
 *   bun packages/e2e/scripts/master-stack.ts [playwright args]
 *
 * - **The master** is the API in its master role, on its own in-memory replica set
 *   (`tests/src/two-node/harness.ts#startNode`), with a per-run front secret, a LAN address and a CA
 *   fingerprint, as `lgr-server` starts it. There is no supervisor: no mongod of its own, no LAN TLS,
 *   no console page. The field lanes (lgr-deploy `vmtest/`) are where those are proven.
 * - **The shop** is founded first through the setup console's source, as `master.sh shop-setup`
 *   does it (FR-20.17: the founder active at once), and a stub desktop pairs with one of its codes
 *   (`tests/src/helpers/desktop-stub.ts`).
 * - **The front**, on 127.0.0.1:<E2E_MASTER_PORT>, stands in for the supervisor's LAN ingress plus a
 *   till's loopback proxy (FR-20.32): it drops whatever `X-LGR-*` the client sent and stamps the
 *   secret, the source `lan` and the paired desktop's token, re-minted before it expires. So the
 *   browser is a till, and every request is a LAN request the front guard judges. On the next port
 *   a second front stamps `tunnel` and no desktop: the org's address on lgrai.app, as the uplink
 *   brings it (FR-20.72), for what the internet may not do that the shop's network may.
 *
 * Playwright gets `E2E_MASTER_URL` and what the specs compare against (`E2E_MASTER_*`); never the
 * front secret. The exit code is Playwright's, and everything stops whatever it says.
 * ⚠ Loopback only: the master, the front and the replica set all listen on 127.0.0.1.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { startNode, type Node } from '../../tests/src/two-node/harness'
import { enrollBody, makeDesktopStub } from '../../tests/src/helpers/desktop-stub'
import { fingerprintWords } from '../../services/src/biz/desktop/fingerprint-words'

const ROOT = join(import.meta.dir, '..', '..', '..')
const PORT = Number(process.env.E2E_MASTER_PORT || 4989)
const FRONT_URL = `http://127.0.0.1:${PORT}`
const TUNNEL_URL = `http://127.0.0.1:${PORT + 1}`
const SECRET = randomBytes(36).toString('base64url')
// TEST-NET-1: an address no machine has, which the pairing code names as the master's LAN.
const LAN_URL = 'https://192.0.2.10:4443'
const CA_FINGERPRINT = `sha256:${randomBytes(32).toString('base64url')}`
const SLUG = `e2e-master-${Date.now().toString(36)}`
const EMAIL = `${SLUG}@lgr.invalid`
const PASSWORD = `pp-${randomBytes(12).toString('hex')}`
const NODE_ID = 'master-e2emasterspecs23'

const scratch = mkdtempSync(join(tmpdir(), 'lgr-e2e-master-'))
/**
 * What the supervisor writes of itself every few seconds (`status_file.rs`), beside the node-token
 * file, where the master's own status page reads it (`server-status.ts`). Air-gapped, so there is no
 * token in it and no registration. The SUPTO version is this source's (`config/src/supto.json`).
 */
const STATE = join(scratch, 'state')
const STATUS_FILE = join(STATE, 'status.json')
const SUPTO = String(JSON.parse(readFileSync(join(ROOT, 'packages', 'config', 'src', 'supto.json'), 'utf8')).version)
const started = Date.now()
function writeStatus() {
  writeFileSync(STATUS_FILE, JSON.stringify({
    service: 'lgr-server', version: '0.0.0-e2e', uptimeSecs: Math.round((Date.now() - started) / 1000),
    children: [{ name: 'mongod', state: 'running' }, { name: 'api', state: 'running' }],
    update: { state: 'idle', running: '0.0.0-e2e', supto: SUPTO },
    disk: { freeBytes: 50e9, totalBytes: 100e9 },
    writtenAt: new Date().toISOString(),
  }))
}
let statusTimer: ReturnType<typeof setInterval> | undefined
let node: Node | undefined
let front: ReturnType<typeof Bun.serve> | undefined
let tunnel: ReturnType<typeof Bun.serve> | undefined
let playwright: ReturnType<typeof Bun.spawn> | undefined

async function stopAll() {
  clearInterval(statusTimer)
  playwright?.kill()
  front?.stop(true)
  tunnel?.stop(true)
  await node?.stop().catch(() => {})
  rmSync(scratch, { recursive: true, force: true })
}
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => { void stopAll().then(() => process.exit(1)) })

/** As the supervisor sends it: the secret and a source, to the master's own address. */
async function stamped(source: 'console' | 'lan', path: string, body?: unknown, token?: string) {
  const res = await fetch(`${node!.url}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      'x-lgr-front': SECRET, 'x-lgr-source': source, 'x-lgr-client-ip': '127.0.0.1',
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const json: any = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`${source} ${path} answered ${res.status}: ${JSON.stringify(json).slice(0, 300)}`)
  return json
}

try {
  mkdirSync(STATE, { recursive: true })
  writeStatus()
  // Fresh while the specs run (`STALE_MS` is 2 min), unless a spec stops the supervisor's writes
  // (`status.frozen` beside it, master-status.spec.ts) to see the page say so.
  statusTimer = setInterval(() => { if (!existsSync(`${STATUS_FILE}.frozen`)) writeStatus() }, 20_000)
  node = await startNode('master', scratch, {
    env: {
      LGR_FRONT_SECRET: SECRET,
      LGR_NODE_ID: NODE_ID,
      LGR_LAN_URL: LAN_URL,
      LGR_LAN_CA_FINGERPRINT: CA_FINGERPRINT,
      // The supervisor's token file (never written: air-gapped), whose folder holds its status.
      LGR_NODE_TOKEN_FILE: join(STATE, 'node-token.json'),
    },
    probeHeaders: { 'x-lgr-front': SECRET, 'x-lgr-source': 'lan' },
  })

  // The shop, founded through the console, and its first till paired.
  const founded = await stamped('console', '/api/auth/register', {
    orgName: `E2E Master ${SLUG}`, orgSlug: SLUG, email: EMAIL, username: 'owner', password: PASSWORD,
    firstName: 'E2E', lastName: 'Owner',
  })
  const orgId = String(founded.org?.id || '')
  if (!orgId || founded.active !== true) throw new Error(`the founder is not active at once: ${JSON.stringify(founded).slice(0, 300)}`)
  const signedIn = await stamped('console', '/api/auth/login', { username: EMAIL, password: PASSWORD })
  const code = await stamped('console', `/api/org/${orgId}/desktops/enrollment-codes`, {}, signedIn.token)
  const stub = makeDesktopStub()
  const enrolled = await stamped('lan', '/api/desktop/v1/enroll', enrollBody(stub, { code: code.code, name: 'E2E till' }))
  const desktopId = String(enrolled.desktopId || '')
  if (!desktopId) throw new Error(`the stub desktop did not enroll: ${JSON.stringify(enrolled).slice(0, 300)}`)

  // The paired till's credential, minted from its assertion as the shell mints it.
  let token = ''
  let expiresAt = 0
  const audience = `${node.url}/api/desktop/v1/token`
  async function desktopToken(): Promise<string> {
    if (token && Date.now() < expiresAt - 120_000) return token
    const t = await stamped('lan', '/api/desktop/v1/token', { assertion: stub.assertion({ sub: desktopId, audience }) })
    token = String(t.accessToken)
    expiresAt = Date.parse(t.expiresAt)
    return token
  }
  await desktopToken()

  const upstream = (req: Request, url: URL, extra: Record<string, string>) => {
    const headers = new Headers()
    for (const [k, v] of req.headers) if (!k.toLowerCase().startsWith('x-lgr-')) headers.set(k, v)
    for (const [k, v] of Object.entries(extra)) headers.set(k, v)
    // A body Bun fetched for us arrives decoded: ask for it plain, so its headers still describe it.
    headers.set('accept-encoding', 'identity')
    return { target: `${node!.url}${url.pathname}${url.search}`, headers }
  }
  type Pipe = { target: string; headers: Record<string, string>; up?: WebSocket; queue: (string | Buffer)[] }
  /**
   * A front on `port` for `source`: `lan` is a paired till (its desktop token stamped), `tunnel` is
   * the org's address on lgrai.app as the uplink brings it (no desktop, FR-20.72), to prove what
   * the shop's network may do and the internet may not.
   */
  const frontOn = (port: number, source: 'lan' | 'tunnel') => Bun.serve<Pipe>({
    hostname: '127.0.0.1',
    port,
    async fetch(req, server) {
      const url = new URL(req.url)
      const { target, headers } = upstream(req, url, {
        'x-lgr-front': SECRET, 'x-lgr-source': source, 'x-lgr-client-ip': '127.0.0.1',
        ...(source === 'lan' ? { 'x-lgr-desktop-token': await desktopToken() } : {}),
      })
      if (req.headers.get('upgrade')?.toLowerCase() === 'websocket') {
        const h: Record<string, string> = {}
        for (const [k, v] of headers) if (!['upgrade', 'connection', 'sec-websocket-key', 'sec-websocket-version', 'sec-websocket-extensions'].includes(k)) h[k] = v
        return server.upgrade(req, { data: { target: target.replace(/^http/, 'ws'), headers: h, queue: [] } })
          ? undefined
          : new Response('upgrade refused', { status: 400 })
      }
      const res = await fetch(target, {
        method: req.method, headers, redirect: 'manual',
        body: req.method === 'GET' || req.method === 'HEAD' ? undefined : await req.arrayBuffer(),
      })
      const out = new Headers(res.headers)
      out.delete('content-encoding')
      out.delete('content-length')
      return new Response(res.body, { status: res.status, statusText: res.statusText, headers: out })
    },
    websocket: {
      open(ws) {
        const up = new WebSocket(ws.data.target, { headers: ws.data.headers } as any)
        ws.data.up = up
        up.binaryType = 'nodebuffer' as any
        up.onopen = () => { for (const m of ws.data.queue.splice(0)) up.send(m) }
        up.onmessage = (e) => { ws.send(e.data as any) }
        up.onclose = (e) => { ws.close(e.code === 1005 ? 1000 : e.code, e.reason) }
        up.onerror = () => { ws.close(1011, 'upstream error') }
      },
      message(ws, m) {
        const up = ws.data.up
        if (up?.readyState === WebSocket.OPEN) up.send(m as any)
        else ws.data.queue.push(m as any)
      },
      close(ws) { ws.data.up?.close() },
    },
  })
  front = frontOn(PORT, 'lan')
  tunnel = frontOn(PORT + 1, 'tunnel')

  const words = fingerprintWords(CA_FINGERPRINT) || []
  console.log(`master-stack: master ${node.url} (${NODE_ID}), LAN ${FRONT_URL}, tunnel ${TUNNEL_URL}, org ${SLUG}, till ${desktopId}`)
  const args = process.argv.slice(2)
  playwright = Bun.spawn(['bunx', 'playwright', 'test', '--project=master', ...args], {
    cwd: join(ROOT, 'packages', 'e2e'),
    stdio: ['ignore', 'inherit', 'inherit'],
    env: {
      ...process.env,
      PLAYWRIGHT_HTML_OPEN: 'never',
      // `BASE_URL` keeps the config's webServer from starting a second server.
      BASE_URL: FRONT_URL,
      E2E_MASTER_URL: FRONT_URL,
      E2E_MASTER_TUNNEL_URL: TUNNEL_URL,
      E2E_MASTER_ORG: orgId,
      E2E_MASTER_SLUG: SLUG,
      E2E_MASTER_EMAIL: EMAIL,
      E2E_MASTER_PASSWORD: PASSWORD,
      E2E_MASTER_DESKTOP: desktopId,
      E2E_MASTER_LAN_URL: LAN_URL,
      E2E_MASTER_FINGERPRINT: CA_FINGERPRINT,
      E2E_MASTER_WORDS: words.join(' '),
      E2E_MASTER_STATUS_FILE: STATUS_FILE,
      E2E_MASTER_SUPTO: SUPTO,
    },
  })
  const code_ = await playwright.exited
  await stopAll()
  process.exit(code_)
} catch (e) {
  console.error(`master-stack: ${(e as Error).message}`)
  if (node) console.error(node.log().slice(-3000))
  await stopAll()
  process.exit(1)
}
