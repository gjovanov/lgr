import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup.js'
import { createTestOrg, createTestUser, createTestWarehouse, createTestFiscalDevice } from '../helpers/factories.js'
import { AuditLog, FiscalDevice } from 'db/models'
import { isDeviceConnected } from 'fiscal/fiscal-device.service'
import {
  handleMessage,
  handleOpen,
  handleClose,
  AUTH_DEADLINE_MS,
} from '../../../portal-api/src/websocket/fiscal-bridge'
import { Elysia } from 'elysia'
import jwt from '@elysiajs/jwt'
import { config } from 'config'

/**
 * `/ws/fiscal-bridge` authentication (FR-14.25).
 *
 * The endpoint used to authenticate NOTHING: a registration named `{deviceNumber, orgId}` and was
 * believed, and a new registration silently evicted the till's current bridge. The device number is
 * printed on every fiscal receipt, so "take a named shop's printer offline from anywhere" was a
 * one-line script.
 *
 * These drive the exported WS handlers with a stand-in socket, so the real token verification,
 * device lookup, eviction rules and audit entry run — no listening server, no mocks of the logic
 * under test.
 *
 * ⚠ No `.rejects` / `.resolves` anywhere: one of them reaps the shared mongod on Windows and
 * cascades every later file into ECONNREFUSED (CLAUDE.md).
 */

/** Sign a token exactly as the app does, so the verifier under test is the one that matters. */
const signer = (new Elysia().use(jwt({ name: 'jwt', secret: config.jwt.secret })) as any).decorator.jwt
const signToken = (payload: Record<string, unknown>) => signer.sign(payload) as Promise<string>

/** A stand-in for Elysia's ws wrapper. `raw` is the identity the handlers key on. */
function fakeWs() {
  const sent: any[] = []
  const closed: Array<{ code?: number; reason?: string }> = []
  const ws = {
    raw: { id: Math.random() },
    send: (s: string) => { sent.push(JSON.parse(s)) },
    close: (code?: number, reason?: string) => { closed.push({ code, reason }) },
    sent,
    closed,
    /** The last message of a type, for readable assertions. */
    last: (type: string) => [...sent].reverse().find(m => m.type === type),
    has: (type: string) => sent.some(m => m.type === type),
  }
  return ws
}

async function seed(opts: { role?: string; permissions?: string[] } = {}) {
  const org = await createTestOrg()
  const wh = await createTestWarehouse(org._id)
  const device = await createTestFiscalDevice(org._id, wh._id)
  const user = await createTestUser(org._id, {
    ...(opts.role ? { role: opts.role as any } : {}),
    ...(opts.permissions ? { permissions: opts.permissions } : {}),
  } as any)
  const token = await signToken({
    id: String(user._id),
    email: user.email,
    username: user.username,
    firstName: user.firstName,
    lastName: user.lastName,
    role: user.role,
    orgId: String(org._id),
    permissions: opts.permissions ?? [...(user.permissions as any)],
  })
  return { org, wh, device, user, token }
}

function registerMsg(extra: Record<string, unknown> = {}) {
  return { type: 'fiscal:bridge:register', ...extra }
}

beforeAll(async () => {
  await setupTestDB()
})

afterAll(async () => {
  await teardownTestDB()
})

afterEach(async () => {
  await clearCollections()
})

describe('fiscal bridge — an unauthenticated caller registers nothing', () => {
  it('refuses a registration with no token at all (the original hole)', async () => {
    const { org, device } = await seed()
    const ws = fakeWs()

    await handleMessage(ws, registerMsg({ deviceNumber: device.deviceNumber, orgId: String(org._id) }))

    expect(ws.last('fiscal:bridge:error')?.code).toBe('unauthenticated')
    expect(ws.has('fiscal:bridge:registered')).toBe(false)
    expect(ws.closed.length).toBe(1)
    // And no printer was registered, so a sale cannot be routed to this socket.
    expect(isDeviceConnected(String(device._id))).toBe(false)
  })

  it('refuses a garbage token', async () => {
    const { org, device } = await seed()
    const ws = fakeWs()

    await handleMessage(ws, registerMsg({
      deviceNumber: device.deviceNumber, orgId: String(org._id), token: 'not.a.jwt',
    }))

    expect(ws.last('fiscal:bridge:error')?.code).toBe('unauthenticated')
    expect(isDeviceConnected(String(device._id))).toBe(false)
  })

  it('refuses a token signed with the wrong secret', async () => {
    const { org, device, user } = await seed()
    const other = (new Elysia().use(jwt({ name: 'jwt', secret: 'x'.repeat(48) })) as any).decorator.jwt
    const forged = await other.sign({
      id: String(user._id), orgId: String(org._id), permissions: ['pos.write'],
    })
    const ws = fakeWs()

    await handleMessage(ws, registerMsg({
      deviceNumber: device.deviceNumber, orgId: String(org._id), token: forged,
    }))

    expect(ws.last('fiscal:bridge:error')?.code).toBe('unauthenticated')
    expect(isDeviceConnected(String(device._id))).toBe(false)
  })

  it('says nothing but "register first" to an unauthenticated socket', async () => {
    const ws = fakeWs()

    // A response carries a commandId the caller cannot guess, and ping is harmless — but an
    // unauthenticated socket does nothing at all, rather than nothing anyone has checked.
    await handleMessage(ws, { type: 'ping' })
    await handleMessage(ws, { type: 'fiscal:response', commandId: 'made-up', frame: '' })

    expect(ws.sent.every(m => m.type === 'fiscal:bridge:error' && m.code === 'unauthenticated')).toBe(true)
    expect(ws.has('pong')).toBe(false)
  })

  it('closes a socket that never authenticates', async () => {
    const ws = fakeWs()
    handleOpen(ws)
    expect(ws.closed.length).toBe(0)

    await Bun.sleep(AUTH_DEADLINE_MS + 250)

    expect(ws.last('fiscal:bridge:error')?.code).toBe('unauthenticated')
    expect(ws.closed.length).toBe(1)
  }, AUTH_DEADLINE_MS + 5000)

  it('does not close a socket that did authenticate, and clears its timer on close', async () => {
    const { org, device, token } = await seed({ permissions: ['pos.write'] })
    const ws = fakeWs()
    handleOpen(ws)
    await handleMessage(ws, registerMsg({ deviceNumber: device.deviceNumber, orgId: String(org._id), token }))
    expect(ws.has('fiscal:bridge:registered')).toBe(true)

    await Bun.sleep(AUTH_DEADLINE_MS + 250)
    expect(ws.closed.length).toBe(0)

    await handleClose(ws)
  }, AUTH_DEADLINE_MS + 5000)
})

describe('fiscal bridge — permission and tenancy', () => {
  it('refuses a signed-in user without pos.write', async () => {
    const { org, device, token } = await seed({ permissions: ['invoicing.read'] })
    const ws = fakeWs()

    await handleMessage(ws, registerMsg({ deviceNumber: device.deviceNumber, orgId: String(org._id), token }))

    expect(ws.last('fiscal:bridge:error')?.code).toBe('forbidden')
    expect(isDeviceConnected(String(device._id))).toBe(false)
  })

  it('accepts a user with pos.write', async () => {
    const { org, device, token } = await seed({ permissions: ['pos.write'] })
    const ws = fakeWs()

    await handleMessage(ws, registerMsg({ deviceNumber: device.deviceNumber, orgId: String(org._id), token }))

    expect(ws.has('fiscal:bridge:registered')).toBe(true)
    expect(isDeviceConnected(String(device._id))).toBe(true)
    const fresh = await FiscalDevice.findById(device._id).lean()
    expect((fresh as any).status).toBe('online')

    await handleClose(ws)
  })

  it('refuses another org\'s device — the org comes from the token, not the message', async () => {
    const a = await seed({ permissions: ['pos.write'] })
    const b = await seed({ permissions: ['pos.write'] })
    const ws = fakeWs()

    // A's user, naming A's org, but asking for B's device number.
    await handleMessage(ws, registerMsg({
      deviceNumber: b.device.deviceNumber, orgId: String(a.org._id), token: a.token,
    }))

    expect(ws.last('fiscal:bridge:error')?.code).toBe('device_not_found')
    expect(isDeviceConnected(String(b.device._id))).toBe(false)
  })

  it('refuses a message that names an org other than the token\'s', async () => {
    const a = await seed({ permissions: ['pos.write'] })
    const b = await seed({ permissions: ['pos.write'] })
    const ws = fakeWs()

    await handleMessage(ws, registerMsg({
      deviceNumber: a.device.deviceNumber, orgId: String(b.org._id), token: a.token,
    }))

    expect(ws.last('fiscal:bridge:error')?.code).toBe('org_mismatch')
    expect(isDeviceConnected(String(a.device._id))).toBe(false)
  })

  it('keeps two orgs sharing one device number apart', async () => {
    // ⚠ Bridges used to be keyed by deviceNumber alone, so registering in org A unregistered
    // org B's printer. Both must hold their own device at the same time.
    const a = await seed({ permissions: ['pos.write'] })
    const orgB = await createTestOrg()
    const whB = await createTestWarehouse(orgB._id)
    const deviceB = await createTestFiscalDevice(orgB._id, whB._id, {
      deviceNumber: a.device.deviceNumber,
    } as any)
    const userB = await createTestUser(orgB._id, { permissions: ['pos.write'] } as any)
    const tokenB = await signToken({
      id: String(userB._id), orgId: String(orgB._id), permissions: ['pos.write'],
    })

    const wsA = fakeWs()
    const wsB = fakeWs()
    await handleMessage(wsA, registerMsg({ deviceNumber: a.device.deviceNumber, orgId: String(a.org._id), token: a.token }))
    await handleMessage(wsB, registerMsg({ deviceNumber: deviceB.deviceNumber, orgId: String(orgB._id), token: tokenB }))

    expect(wsA.has('fiscal:bridge:registered')).toBe(true)
    expect(wsB.has('fiscal:bridge:registered')).toBe(true)
    expect(isDeviceConnected(String(a.device._id))).toBe(true)
    expect(isDeviceConnected(String(deviceB._id))).toBe(true)

    await handleClose(wsA)
    await handleClose(wsB)
  })
})

describe('fiscal bridge — no silent eviction', () => {
  it('refuses a second opener instead of taking the device from the first', async () => {
    const { org, device, token } = await seed({ permissions: ['pos.write'] })
    const first = fakeWs()
    await handleMessage(first, registerMsg({ deviceNumber: device.deviceNumber, orgId: String(org._id), token }))
    expect(first.has('fiscal:bridge:registered')).toBe(true)

    const second = fakeWs()
    await handleMessage(second, registerMsg({ deviceNumber: device.deviceNumber, orgId: String(org._id), token }))

    expect(second.last('fiscal:bridge:error')?.code).toBe('bridge_in_use')
    expect(second.has('fiscal:bridge:registered')).toBe(false)
    // The first bridge is untouched: not told anything, not closed, still holding the printer.
    expect(first.has('fiscal:bridge:evicted')).toBe(false)
    expect(first.closed.length).toBe(0)
    expect(isDeviceConnected(String(device._id))).toBe(true)

    await handleClose(first)
  })

  it('names the holder, so the cashier knows where the receipt will print', async () => {
    const { org, device, token } = await seed({ permissions: ['pos.write'] })
    const first = fakeWs()
    await handleMessage(first, registerMsg({ deviceNumber: device.deviceNumber, orgId: String(org._id), token }))

    const second = fakeWs()
    await handleMessage(second, registerMsg({ deviceNumber: device.deviceNumber, orgId: String(org._id), token }))

    expect(second.last('fiscal:bridge:error')?.message).toContain('Test User')

    await handleClose(first)
  })

  it('is idempotent for the SAME socket re-registering', async () => {
    const { org, device, token } = await seed({ permissions: ['pos.write'] })
    const ws = fakeWs()
    const msg = registerMsg({ deviceNumber: device.deviceNumber, orgId: String(org._id), token })

    await handleMessage(ws, msg)
    await handleMessage(ws, msg)

    expect(ws.sent.filter(m => m.type === 'fiscal:bridge:registered').length).toBe(2)
    expect(ws.has('fiscal:bridge:error')).toBe(false)
    expect(isDeviceConnected(String(device._id))).toBe(true)

    await handleClose(ws)
  })

  it('refuses takeover by an admin who did not ask for it', async () => {
    const { org, device, token } = await seed({ permissions: ['pos.write'] })
    const first = fakeWs()
    await handleMessage(first, registerMsg({ deviceNumber: device.deviceNumber, orgId: String(org._id), token }))

    const adminToken = await signToken({
      id: String(org.ownerId), orgId: String(org._id), firstName: 'Ada', lastName: 'Admin',
      permissions: ['pos.write', 'admin.settings'],
    })
    const admin = fakeWs()
    // No `takeover: true` — opening a second tab must not steal a printing till's port.
    await handleMessage(admin, registerMsg({ deviceNumber: device.deviceNumber, orgId: String(org._id), token: adminToken }))

    expect(admin.last('fiscal:bridge:error')?.code).toBe('bridge_in_use')
    expect(first.closed.length).toBe(0)

    await handleClose(first)
  })

  it('refuses takeover by a non-admin who asks for it', async () => {
    const { org, device, token } = await seed({ permissions: ['pos.write'] })
    const first = fakeWs()
    await handleMessage(first, registerMsg({ deviceNumber: device.deviceNumber, orgId: String(org._id), token }))

    const second = fakeWs()
    await handleMessage(second, registerMsg({
      deviceNumber: device.deviceNumber, orgId: String(org._id), token, takeover: true,
    }))

    expect(second.last('fiscal:bridge:error')?.code).toBe('bridge_in_use')
    expect(first.closed.length).toBe(0)

    await handleClose(first)
  })

  it('lets an admin take over explicitly, tells the evicted bridge why, and audits it', async () => {
    const { org, device, token } = await seed({ permissions: ['pos.write'] })
    const first = fakeWs()
    await handleMessage(first, registerMsg({ deviceNumber: device.deviceNumber, orgId: String(org._id), token }))

    const adminToken = await signToken({
      id: String(org.ownerId), orgId: String(org._id), firstName: 'Ada', lastName: 'Admin',
      permissions: ['pos.write', 'admin.settings'],
    })
    const admin = fakeWs()
    await handleMessage(admin, registerMsg({
      deviceNumber: device.deviceNumber, orgId: String(org._id), token: adminToken, takeover: true,
    }))

    expect(admin.has('fiscal:bridge:registered')).toBe(true)
    // The evicted bridge is TOLD, and told who — not just dropped.
    expect(first.has('fiscal:bridge:evicted')).toBe(true)
    expect(first.last('fiscal:bridge:evicted')?.message).toContain('Ada Admin')
    expect(first.closed.length).toBe(1)
    // The printer belongs to the admin's socket now.
    expect(isDeviceConnected(String(device._id))).toBe(true)

    const audit = await AuditLog.find({ entityType: 'fiscalDevice' }).lean()
    expect(audit.length).toBe(1)
    expect(String((audit[0] as any).entityName)).toBe(String(device.deviceNumber))
    // ⚠ Recorded in `changes`, not a free-text note: `AuditEntry` has no `notes` field, and
    // Mongoose drops unknown keys without a word — a note would have logged nothing.
    expect((audit[0] as any).changes?.[0]).toMatchObject({
      field: 'bridge',
      oldValue: 'Test User',
      newValue: 'Ada Admin',
    })

    await handleClose(admin)
  })

  it('a closing socket does not unregister the bridge that replaced it', async () => {
    const { org, device, token } = await seed({ permissions: ['pos.write'] })
    const first = fakeWs()
    await handleMessage(first, registerMsg({ deviceNumber: device.deviceNumber, orgId: String(org._id), token }))

    const adminToken = await signToken({
      id: String(org.ownerId), orgId: String(org._id), permissions: ['pos.write', 'admin.settings'],
    })
    const admin = fakeWs()
    await handleMessage(admin, registerMsg({
      deviceNumber: device.deviceNumber, orgId: String(org._id), token: adminToken, takeover: true,
    }))

    // The evicted socket's close arrives late, as it always does.
    await handleClose(first)

    expect(isDeviceConnected(String(device._id))).toBe(true)

    await handleClose(admin)
  })
})

describe('fiscal bridge — the desktop principal', () => {
  it('refuses a desktop-audience token rather than treating it as a user token', async () => {
    // ⚠ A desktop token must never be valid as a user token. C18 gives it its own branch, checked
    // against the Desktop row's fiscalDeviceIds; until that row exists it is refused outright
    // rather than relying on "it happens to carry no permissions".
    const { org, device } = await seed({ permissions: ['pos.write'] })
    const desktopToken = await signToken({
      desktopId: 'abc', orgId: String(org._id), keyEpoch: 1, aud: 'lgr-desktop',
      permissions: ['pos.write', 'admin.settings'],
    })
    const ws = fakeWs()

    await handleMessage(ws, registerMsg({
      deviceNumber: device.deviceNumber, orgId: String(org._id), token: desktopToken,
    }))

    expect(ws.last('fiscal:bridge:error')?.code).toBe('desktop_bridge_unsupported')
    expect(ws.has('fiscal:bridge:registered')).toBe(false)
    expect(isDeviceConnected(String(device._id))).toBe(false)
  })
})

describe('fiscal bridge — housekeeping unchanged', () => {
  it('marks the device offline and drops the printer when the bridge closes', async () => {
    const { org, device, token } = await seed({ permissions: ['pos.write'] })
    const ws = fakeWs()
    await handleMessage(ws, registerMsg({ deviceNumber: device.deviceNumber, orgId: String(org._id), token }))
    expect(isDeviceConnected(String(device._id))).toBe(true)

    await handleClose(ws)

    expect(isDeviceConnected(String(device._id))).toBe(false)
    const fresh = await FiscalDevice.findById(device._id).lean()
    expect((fresh as any).status).toBe('offline')
  })

  it('answers ping once authenticated', async () => {
    const { org, device, token } = await seed({ permissions: ['pos.write'] })
    const ws = fakeWs()
    await handleMessage(ws, registerMsg({ deviceNumber: device.deviceNumber, orgId: String(org._id), token }))

    await handleMessage(ws, { type: 'ping' })

    expect(ws.has('pong')).toBe(true)

    await handleClose(ws)
  })
})
