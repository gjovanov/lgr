/**
 * FR-20.16 / FR-20.18 / FR-20.23 (plan step P1-3, AC 47 and 48) — the API behind the supervisor,
 * end to end: a real master process with a front secret and a control socket, sent what the
 * supervisor's ingresses would and would not send it.
 *
 * The supervisor's own half (stripping the client's `X-LGR-*`, stamping, TLS on the LAN) is Rust,
 * and is tested there. This file holds the API to its contract: it serves nothing that does not
 * come stamped through the front, and its control socket is its only way to stop on Windows.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createHmac } from 'node:crypto'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startNode, type Node } from '../two-node/harness'

const random = () => Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url')
const SECRET = random()
const DESKTOP_KEY = random()
const LAN_NAME = 'kasa-1.local'

let scratch: string
let socket: string
let node: Node

/** As the supervisor would send it: the secret, a source, and the client's own Host. */
function front(path: string, source: 'lan' | 'tunnel' | 'console', init: RequestInit & { headers?: Record<string, string> } = {}) {
  return fetch(`${node.url}${path}`, {
    ...init,
    headers: { 'x-lgr-front': SECRET, 'x-lgr-source': source, host: `${LAN_NAME}:4443`, ...init.headers },
  })
}

/** A desktop token signed with the node's own key, as `issueDesktopToken` makes them. */
function desktopToken(claims: { desktopId: string; orgId: string; keyEpoch: number }) {
  const iat = Math.floor(Date.now() / 1000)
  const b64u = (s: string) => Buffer.from(s).toString('base64url')
  const header = b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const payload = b64u(JSON.stringify({ ...claims, aud: 'lgr-desktop', iat, exp: iat + 600 }))
  const sig = createHmac('sha256', DESKTOP_KEY).update(`${header}.${payload}`).digest('base64url')
  return `${header}.${payload}.${sig}`
}

/** Insert a desktop row straight into the node's database (the native driver: no models here). */
async function desktopRow(status: 'active' | 'revoked', keyEpoch = 1) {
  const { ObjectId, MongoClient } = (await import('db/connection')).mongoose.mongo
  const c = await MongoClient.connect(node.mongoUri)
  try {
    const id = new ObjectId()
    const orgId = new ObjectId()
    await c.db().collection('desktops').insertOne({ _id: id, orgId, status, keyEpoch, name: 'Till 1', createdAt: new Date() })
    return { desktopId: String(id), orgId: String(orgId), keyEpoch }
  } finally {
    await c.close()
  }
}

/** Over the API's control socket, as the supervisor talks to it. */
function control(path: string, init: RequestInit & { secret?: string | null } = {}) {
  const { secret = SECRET, ...rest } = init
  return fetch(`http://lgr-api${path}`, {
    ...rest,
    unix: socket,
    headers: secret ? { 'x-lgr-front': secret } : {},
  } as any)
}

beforeAll(async () => {
  // Short: an AF_UNIX path is limited to 108 bytes, on Windows as everywhere.
  scratch = mkdtempSync(join(tmpdir(), 'lgr-front-'))
  socket = join(scratch, 'api.sock')
  node = await startNode('master', scratch, {
    env: {
      LGR_FRONT_SECRET: SECRET,
      LGR_FRONT_HOSTS: LAN_NAME,
      LGR_CONTROL_SOCKET: socket,
      DESKTOP_TOKEN_SECRET: DESKTOP_KEY,
      LGR_STOP_WAIT_MS: '3000',
    },
    probeHeaders: { 'x-lgr-front': SECRET, 'x-lgr-source': 'tunnel' },
  })
}, 180_000)

afterAll(async () => {
  await node?.stop()
  rmSync(scratch, { recursive: true, force: true })
})

describe('the front (AC 47)', () => {
  test('a request without the front secret is refused, whatever else it carries', async () => {
    const none = await fetch(`${node.url}/api/health`)
    expect(none.status).toBe(403)
    expect((await none.json()).code).toBe('front_required')
    const wrong = await fetch(`${node.url}/api/health`, { headers: { 'x-lgr-front': random(), 'x-lgr-source': 'tunnel' } })
    expect(wrong.status).toBe(403)
  })

  test('a Host off the list is refused; a listed name, localhost and an address are not', async () => {
    const rebound = await front('/api/health', 'tunnel', { headers: { host: 'attacker.example' } })
    expect(rebound.status).toBe(403)
    expect((await rebound.json()).code).toBe('host_not_allowed')
    for (const host of [`${LAN_NAME}:4443`, 'KASA-1.LOCAL', 'localhost:4443', '192.168.1.20:4443', '[::1]:4443']) {
      expect((await front('/api/health', 'tunnel', { headers: { host } })).status).toBe(200)
    }
  })

  test('the secret without a source stamp is refused', async () => {
    const r = await fetch(`${node.url}/api/health`, { headers: { 'x-lgr-front': SECRET } })
    expect(r.status).toBe(403)
    expect((await r.json()).code).toBe('source_required')
    expect((await front('/api/health', 'everywhere' as any)).status).toBe(403)
  })

  test('/internal/* and /api/setup/* answer 404 over HTTP, through every ingress and in any spelling', async () => {
    for (const source of ['lan', 'tunnel', 'console'] as const) {
      for (const path of ['/internal/repl/page', '/internal', '/api/setup/complete', '/API/Setup/x', '//internal/x', '/api/%73etup/x']) {
        const r = await front(path, source)
        expect([path, source, r.status]).toEqual([path, source, 404])
      }
    }
  })

  test('a master creates orgs only during setup: through the console, never the LAN or the tunnel', async () => {
    for (const path of ['/api/auth/register', '/api/auth/orgs', '/api/oauth/pending/register', '/api/auth/register/']) {
      for (const source of ['lan', 'tunnel'] as const) {
        const r = await front(path, source, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
        expect([path, source, r.status]).toEqual([path, source, 404])
      }
    }
    // Through the console it reaches the handler, which refuses the empty body for what it is.
    const r = await front('/api/auth/register', 'console', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
    expect(r.status).toBe(422)
  })
})

describe('the LAN needs a paired desktop (FR-20.32)', () => {
  test('without a desktop credential the LAN gets 401, except the three routes that produce one', async () => {
    const r = await front('/api/oauth/providers', 'lan')
    expect(r.status).toBe(401)
    expect((await r.json()).code).toBe('desktop_required')
    expect((await front('/api/health', 'lan')).status).toBe(200)
    // Reached, not gated: the handler refuses the empty body (422), not the gate (401).
    const enroll = await front('/api/desktop/v1/enroll', 'lan', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
    expect(enroll.status).toBe(422)
    // An exemption is exact: a variant is gated.
    expect((await front('/api/health/', 'lan')).status).toBe(401)
    // The tunnel and the console are not LAN requests.
    expect((await front('/api/oauth/providers', 'tunnel')).status).toBe(200)
  })

  test('an active desktop passes; a revoked one and a rotated key do not', async () => {
    const active = await desktopRow('active')
    const ok = await front('/api/oauth/providers', 'lan', { headers: { 'x-lgr-desktop-token': desktopToken(active) } })
    expect(ok.status).toBe(200)

    const revoked = await desktopRow('revoked')
    const r = await front('/api/oauth/providers', 'lan', { headers: { 'x-lgr-desktop-token': desktopToken(revoked) } })
    expect(r.status).toBe(401)
    expect((await r.json()).code).toBe('desktop_revoked')

    const rotated = await front('/api/oauth/providers', 'lan', { headers: { 'x-lgr-desktop-token': desktopToken({ ...active, keyEpoch: 2 }) } })
    expect(rotated.status).toBe(401)
    expect((await rotated.json()).code).toBe('key_rotated')

    // A token another key signed is no token at all.
    const forged = desktopToken(active).replace(/\.[^.]+$/, '.' + random())
    expect((await front('/api/oauth/providers', 'lan', { headers: { 'x-lgr-desktop-token': forged } })).status).toBe(401)
  })
})

describe('WebSockets go through the front too (AC 48)', () => {
  const open = (headers: Record<string, string>) =>
    new Promise<string>(resolve => {
      const ws = new WebSocket(`${node.url.replace('http', 'ws')}/ws/tasks`, { headers } as any)
      const t = setTimeout(() => { resolve('timeout'); ws.close() }, 5000)
      ws.onopen = () => { clearTimeout(t); resolve('open'); ws.close() }
      ws.onerror = () => { clearTimeout(t); resolve('refused') }
    })

  test('an upgrade without the secret is refused before it upgrades; a stamped one opens', async () => {
    expect(await open({})).toBe('refused')
    expect(await open({ 'x-lgr-front': SECRET, 'x-lgr-source': 'tunnel', host: LAN_NAME })).toBe('open')
  })

  test('a LAN upgrade needs the desktop credential like any LAN request', async () => {
    const base = { 'x-lgr-front': SECRET, 'x-lgr-source': 'lan', host: LAN_NAME }
    expect(await open(base)).toBe('refused')
    const active = await desktopRow('active')
    expect(await open({ ...base, 'x-lgr-desktop-token': desktopToken(active) })).toBe('open')
  })
})

describe('the control socket (FR-20.16, FR-20.23)', () => {
  test('answers status with the front secret only', async () => {
    expect((await control('/status', { secret: null })).status).toBe(403)
    expect((await control('/status', { secret: random() })).status).toBe(403)
    const r = await control('/status')
    expect(r.status).toBe(200)
    const s = await r.json()
    expect(s).toMatchObject({ ok: true, stopping: false, role: 'master', fiscalInFlight: 0, posOpen: 0 })
    expect(Array.isArray(s.schedulers)).toBe(true)
  })

  test('is not on the front port: no ingress can reach status or stop', async () => {
    const desktop = desktopToken(await desktopRow('active'))
    for (const source of ['lan', 'tunnel', 'console'] as const) {
      const headers = { 'x-lgr-desktop-token': desktop }
      // `/status` there is an SPA path at most (the shell, where the UIs are built), never the
      // control socket's answer.
      const status = await front('/status', source, { headers })
      expect(await status.text()).not.toContain('fiscalInFlight')
      await front('/stop', source, { method: 'POST', headers })
    }
    // ...and the POSTs to `/stop` stopped nothing.
    expect((await control('/status')).status).toBe(200)
  })

  test('backup (FR-20.20): the front secret only, and answered once done', async () => {
    expect((await control('/backup', { method: 'POST', secret: null })).status).toBe(403)
    expect((await control('/backup', { method: 'POST', secret: random() })).status).toBe(403)
    // Nothing is homed on this node, so nothing is backed up, and that is not a failure.
    const r = await control('/backup', { method: 'POST' })
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual({ ok: true, runs: [] })
    // Not on the front either.
    const desktop = desktopToken(await desktopRow('active'))
    const viaLan = await front('/backup', 'lan', { method: 'POST', headers: { 'x-lgr-desktop-token': desktop } })
    expect(await viaLan.text()).not.toContain('"runs"')
  }, 60_000)

  test('stop: answered at once, then the API stops cleanly, exits 0 and removes its socket', async () => {
    const r = await control('/stop', { method: 'POST' })
    expect(r.status).toBe(202)
    const code = await Promise.race([node.exited, Bun.sleep(15_000).then(() => 'still running')])
    expect(code).toBe(0)
    expect(node.log()).toContain('Stopped')
    expect(existsSync(socket)).toBe(false)
  }, 30_000)
})
