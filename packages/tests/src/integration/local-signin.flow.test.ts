import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { Elysia } from 'elysia'
import jwt from '@elysiajs/jwt'
import { setupTestDB, teardownTestDB } from '../setup'
import { createTestOrg, createTestUser } from '../helpers/factories'
import { createApiApp } from '../../../portal-api/src/api.js'
import { spaErrorHandler } from '../../../portal-api/src/spa-fallback.js'
import { config } from 'config'
import { DEFAULT_ROLE_PERMISSIONS } from 'config/constants'
import { Desktop, Identity, LocalCredential, User } from 'db/models'
import { forgetAllHomes, homeNewOrg } from 'db/home/home'
import { signDesktopToken } from 'services/biz/desktop/desktop.service'
import { forgetDesktopStreaks, pinSignIn } from 'services/biz/identity/local-credentials.service'
import { tenantCollections } from 'services/biz/backup/backup-bundle.service'

/**
 * Till PINs on a master (FR-20.40, plan step P1-5).
 *
 * The till is a desktop paired with the master, on the LAN ingress: requests carry the
 * supervisor's `x-lgr-source: lan` and the desktop's token, as the shell's proxy sends them.
 * The PIN signs in to the desktop's org, backs off rather than locks (trap 32), is invalidated by
 * the person's token version, and makes a session that reaches the till only.
 *
 * NOTE: no `.rejects` / `.resolves` (Bun-on-Windows deadlock, see Known Issues).
 */

const SECRET = 'front secret of this test run'
const saved = { role: config.node.role, id: (config.node as any).id, front: config.front.secret }
const signer = new Elysia().use(jwt({ name: 'jwt', secret: config.jwt.secret }))

let app: Elysia
let orgId: string
let deskToken: string
let identityId: string
const tokens: Record<string, string> = {}

function asMaster() {
  ;(config.node as any).role = 'master'
  ;(config.node as any).id = 'master-testpinsxxxxxxxx'
  ;(config.front as any).secret = SECRET
}

async function call(method: string, path: string, opts: { token?: string; body?: unknown; source?: string; desk?: string | null } = {}) {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (opts.token) headers.authorization = `Bearer ${opts.token}`
  const source = opts.source === undefined ? 'lan' : opts.source
  if (source) headers['x-lgr-source'] = source
  const desk = opts.desk === undefined ? deskToken : opts.desk
  if (desk) headers['x-lgr-desktop-token'] = desk
  const res = await app.handle(new Request(`http://localhost${path}`, {
    method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  }))
  let json: any = null
  try { json = await res.json() } catch { /* not json */ }
  return { status: res.status, json, headers: res.headers }
}

async function sign(user: any, extra: Record<string, unknown> = {}) {
  return (signer as any).decorator.jwt.sign({
    id: String(user._id), orgId, role: user.role, email: user.email, username: user.username,
    firstName: 'P', lastName: 'In', permissions: DEFAULT_ROLE_PERMISSIONS[user.role as keyof typeof DEFAULT_ROLE_PERMISSIONS],
    ownRecordsModules: [], operatorCode: user.operatorCode, ...extra,
  })
}

beforeAll(async () => {
  await setupTestDB()
  asMaster()
  app = new Elysia().onError(spaErrorHandler({}) as any).use(createApiApp()) as any
  const org = await createTestOrg()
  orgId = String(org._id)
  await homeNewOrg(orgId)

  const identity = await Identity.create({
    email: 'cashier@pins.test', firstName: 'Cash', lastName: 'Ier', password: await Bun.password.hash('the password'), isActive: true,
  })
  identityId = String(identity._id)
  const cashier = await createTestUser(org._id, { role: 'sales', email: 'cashier@pins.test', identityId: identity._id, operatorCode: '0007' } as any)
  tokens.cashier = await sign(cashier, { iid: identityId, tv: 0 })

  const boss = await Identity.create({ email: 'boss@pins.test', firstName: 'B', lastName: 'Oss', password: await Bun.password.hash('boss password'), isActive: true })
  const admin = await createTestUser(org._id, { role: 'admin', email: 'boss@pins.test', identityId: boss._id, operatorCode: '0001' } as any)
  tokens.admin = await sign(admin, { iid: String(boss._id), tv: 0 })

  const desktop = await Desktop.create({
    orgId: org._id, name: 'Till 1', machineId: 'm-pins', installationId: `inst-${Math.random()}`, publicKey: 'x'.repeat(60), keyEpoch: 1, status: 'active',
  })
  deskToken = signDesktopToken({ desktopId: String(desktop._id), orgId, keyEpoch: 1 }).token
}, 60_000)

afterEach(() => {
  forgetDesktopStreaks()
})

afterAll(async () => {
  ;(config.node as any).role = saved.role
  ;(config.node as any).id = saved.id
  ;(config.front as any).secret = saved.front
  forgetAllHomes()
  await teardownTestDB()
}, 60_000)

describe('where a PIN is offered', () => {
  it('a paired desktop on the LAN may; the tunnel, no front and a stranger may not', async () => {
    expect((await call('GET', '/api/auth/local/methods')).json.pin).toBe(true)
    expect((await call('GET', '/api/auth/local/methods', { source: 'tunnel' })).json.pin).toBe(false)
    expect((await call('GET', '/api/auth/local/methods', { desk: null })).json.pin).toBe(false)
    const tunnel = await call('POST', '/api/auth/local/pin', { source: 'tunnel', body: { operatorCode: '0007', pin: '402613' } })
    expect(tunnel.status).toBe(404)
    const forged = await call('POST', '/api/auth/local/pin', { desk: 'not.a.token', body: { operatorCode: '0007', pin: '402613' } })
    expect(forged.status).toBe(404)
  })

  it('never on global', async () => {
    ;(config.node as any).role = 'global'
    try {
      expect((await call('GET', '/api/auth/local/methods')).status).toBe(404)
      expect((await call('POST', '/api/auth/local/pin', { body: { operatorCode: '0007', pin: '402613' } })).status).toBe(404)
      expect((await call('PUT', '/api/auth/local/pin', { token: tokens.cashier, body: { password: 'the password', pin: '402613' } })).status).toBe(404)
    } finally {
      asMaster()
    }
  })
})

describe('setting a PIN', () => {
  it('takes the password, and refuses a PIN a person guesses first', async () => {
    const wrong = await call('PUT', '/api/auth/local/pin', { token: tokens.cashier, body: { password: 'not it', pin: '402613' } })
    expect(wrong.status).toBe(403)
    for (const pin of ['1234', '111111', '123456', '987654', '12345a']) {
      const weak = await call('PUT', '/api/auth/local/pin', { token: tokens.cashier, body: { password: 'the password', pin } })
      expect(weak.status).toBe(422)
    }
    const ok = await call('PUT', '/api/auth/local/pin', { token: tokens.cashier, body: { password: 'the password', pin: '402613' } })
    expect(ok.status).toBe(200)
    expect((await call('GET', '/api/auth/local/pin', { token: tokens.cashier })).json.set).toBe(true)

    // Stored as argon2id, never the digits.
    const row: any = await LocalCredential.findOne({ identityId }).select('+verifier').lean().exec()
    expect(row.verifier).toStartWith('$argon2id$')
  })

  it('is no backup\'s business: the collection is not tenant data', () => {
    expect(tenantCollections().map((m: any) => m.modelName ?? m)).not.toContain('LocalCredential')
  })
})

describe('signing in with it', () => {
  it('lands in the desktop\'s org, for a shift, and reaches the till only', async () => {
    const r = await call('POST', '/api/auth/local/pin', { body: { operatorCode: '0007', pin: '402613' } })
    expect(r.status).toBe(200)
    expect(r.json.user.amr).toEqual(['pin'])
    expect(r.json.user.orgId).toBe(orgId)
    const token = r.json.token

    expect((await call('GET', `/api/org/${orgId}/trade/pos/catalog`, { token })).status).toBe(200)
    expect((await call('GET', '/api/auth/me', { token })).status).toBe(200)
    // Not what the cashier's password reaches: invoices, and no switching into a full session.
    const invoices = await call('GET', `/api/org/${orgId}/invoices`, { token })
    expect(invoices.status).toBe(403)
    expect(invoices.json.code).toBe('pin_session_scope')
    expect((await call('POST', '/api/auth/switch', { token, body: { orgId } })).status).toBe(403)
    expect((await call('PUT', '/api/auth/local/pin', { token, body: { password: 'the password', pin: '402614' } })).status).toBe(403)
  })

  it("an admin's PIN reaches the till only too", async () => {
    await call('PUT', '/api/auth/local/pin', { token: tokens.admin, body: { password: 'boss password', pin: '730518' } })
    const r = await call('POST', '/api/auth/local/pin', { body: { operatorCode: '0001', pin: '730518' } })
    expect(r.status).toBe(200)
    expect((await call('GET', `/api/org/${orgId}/payroll/payslip`, { token: r.json.token })).status).toBe(403)
    expect((await call('GET', `/api/org/${orgId}/trade/pos/session`, { token: r.json.token })).status).toBe(200)
  })

  it('the next operator signs in over the last one\'s PIN session', async () => {
    const first = await call('POST', '/api/auth/local/pin', { body: { operatorCode: '0007', pin: '402613' } })
    const next = await call('POST', '/api/auth/local/pin', { token: first.json.token, body: { operatorCode: '0001', pin: '730518' } })
    expect(next.status).toBe(200)
  })

  it('does not name another org\'s operator', async () => {
    const other = await createTestOrg()
    await homeNewOrg(String(other._id))
    await createTestUser(other._id, { role: 'sales', email: 'elsewhere@pins.test', identityId, operatorCode: '0009' } as any)
    expect((await call('POST', '/api/auth/local/pin', { body: { operatorCode: '0009', pin: '402613' } })).status).toBe(401)
  })
})

describe('wrong PINs slow down, and never lock', () => {
  it('backs off after three, and the right PIN still works once the wait is over', async () => {
    const t0 = Date.now()
    for (let i = 0; i < 3; i++) {
      const r = await pinSignIn({ orgId, operatorCode: '0007', pin: '000001', now: t0 + i }).catch((e: any) => e)
      expect(r.code).toBe('invalid_pin')
    }
    const fourth = await pinSignIn({ orgId, operatorCode: '0007', pin: '000001', now: t0 + 10 }).catch((e: any) => e)
    expect(fourth.code).toBe('invalid_pin')
    expect(fourth.retryAfterSeconds).toBe(1)
    // Within the wait even the right PIN is told to wait, without being checked.
    const early = await pinSignIn({ orgId, operatorCode: '0007', pin: '402613', now: t0 + 500 }).catch((e: any) => e)
    expect(early.code).toBe('pin_backoff')
    // After it, the right PIN works, and the streak is gone.
    const later = await pinSignIn({ orgId, operatorCode: '0007', pin: '402613', now: t0 + 1_200 })
    expect(String(later.user.operatorCode)).toBe('0007')
    const row: any = await LocalCredential.findOne({ identityId }).lean().exec()
    expect(row.failures).toBe(0)
  })

  it('says so over HTTP, with Retry-After', async () => {
    for (let i = 0; i < 4; i++) await call('POST', '/api/auth/local/pin', { body: { operatorCode: '0007', pin: '000002' } })
    const r = await call('POST', '/api/auth/local/pin', { body: { operatorCode: '0007', pin: '000002' } })
    expect(r.status).toBe(429)
    expect(Number(r.headers.get('retry-after'))).toBeGreaterThan(0)
    await LocalCredential.updateOne({ identityId }, { $set: { failures: 0 }, $unset: { nextAttemptAt: 1 } }).exec()
  })
})

describe('what ends a PIN', () => {
  it('a token-version bump (a password change, a sign-out everywhere)', async () => {
    await Identity.updateOne({ _id: identityId }, { $inc: { tokenVersion: 1 } }).exec()
    const r = await call('POST', '/api/auth/local/pin', { body: { operatorCode: '0007', pin: '402613' } })
    expect(r.status).toBe(401)
    expect(r.json.code).toBe('pin_not_set')
    await Identity.updateOne({ _id: identityId }, { $inc: { tokenVersion: -1 } }).exec()
  })

  it('a deactivated membership', async () => {
    await User.updateOne({ orgId, operatorCode: '0007' }, { $set: { isActive: false } }).exec()
    expect((await call('POST', '/api/auth/local/pin', { body: { operatorCode: '0007', pin: '402613' } })).status).toBe(401)
    await User.updateOne({ orgId, operatorCode: '0007' }, { $set: { isActive: true } }).exec()
  })
})

describe('an Air-gapped master owns its people (AC 64)', () => {
  it('its admin creates a person, renames them and resets the password, all locally; the person signs in', async () => {
    const created = await call('POST', `/api/org/${orgId}/user`, {
      token: tokens.admin,
      body: { email: 'new@pins.test', username: 'newcomer', password: 'first local word', firstName: 'New', lastName: 'Comer', role: 'sales' },
    })
    expect(created.status).toBe(200)
    const id = created.json.user._id ?? created.json.user.id

    const edited = await call('PUT', `/api/org/${orgId}/user/${id}`, {
      token: tokens.admin, body: { firstName: 'Renamed', password: 'second local word' },
    })
    expect(edited.status).toBe(200)

    const signIn = await call('POST', '/api/auth/login', { body: { username: 'new@pins.test', password: 'second local word' } })
    expect(signIn.status).toBe(200)
    expect(signIn.json.user.firstName).toBe('Renamed')
    expect((await call('POST', '/api/auth/login', { body: { username: 'new@pins.test', password: 'first local word' } })).status).toBe(401)
  })
})

describe("a master's password sign-in backs off, never locks (FR-20.40, trap 32)", () => {
  it('a counter at its limit waits seconds, not the cloud\'s quarter of an hour, and the right password still works', async () => {
    const saved = { ...config.loginThrottle }
    Object.assign(config.loginThrottle, { enabled: true, perAccount: 3 })
    try {
      const wrong = { username: 'cashier@pins.test', password: 'not the password' }
      for (let i = 0; i < 3; i++) expect((await call('POST', '/api/auth/login', { body: wrong })).status).toBe(401)
      const waiting = await call('POST', '/api/auth/login', { body: { username: 'cashier@pins.test', password: 'the password' } })
      expect(waiting.status).toBe(429)
      const retryAfter = Number(waiting.headers.get('retry-after'))
      expect(retryAfter).toBeGreaterThan(0)
      expect(retryAfter).toBeLessThanOrEqual(60)
      await Bun.sleep(retryAfter * 1000 + 200)
      expect((await call('POST', '/api/auth/login', { body: { username: 'cashier@pins.test', password: 'the password' } })).status).toBe(200)
    } finally {
      Object.assign(config.loginThrottle, saved)
    }
  }, 30_000)
})
