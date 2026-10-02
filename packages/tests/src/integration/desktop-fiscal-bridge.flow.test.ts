import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup.js'
import {
  createTestOrg,
  createTestUser,
  createTestWarehouse,
  createTestFiscalDevice,
} from '../helpers/factories.js'
import { Desktop, FiscalDevice } from 'db/models'
import { isDeviceConnected } from 'fiscal/fiscal-device.service'
import { signDesktopToken } from 'services/biz/desktop/desktop.service'
import {
  handleMessage,
  handleClose,
  bridgeHolder,
  stopDesktopBridges,
} from '../../../portal-api/src/websocket/fiscal-bridge'
import { Elysia } from 'elysia'
import jwt from '@elysiajs/jwt'
import { config } from 'config'

/**
 * C18 — the native fiscal bridge's half of `/ws/fiscal-bridge` (FR-14.26, FR-14.27, AC 13).
 *
 * C02 made the endpoint authenticate a **browser** relay. This covers the other principal: a
 * registered LGR Desktop holding its till's serial port.
 *
 * ## What is actually being pinned down
 *
 * The chunk's one irreducible rule is **one owner per serial port**. It is enforced structurally —
 * the device lookup filters on `connectionType`, and the two bridges' sets are disjoint — so these
 * assert it from both directions, because a rule enforced in one direction only is how a desktop
 * device ends up offered to Web Serial after a refactor.
 *
 * ⚠ These drive the exported handlers with a stand-in socket, so the real token verification, the
 * row re-read, the assignment check and the registry writes all run. No listening server.
 *
 * ⚠ No `.rejects` / `.resolves` anywhere: one of them reaps the shared mongod on Windows and
 * cascades every later file into ECONNREFUSED (CLAUDE.md).
 */

const signer = (new Elysia().use(jwt({ name: 'jwt', secret: config.jwt.secret })) as any).decorator.jwt

/** A stand-in for Elysia's ws wrapper. `raw` is the identity the handlers key on. */
function fakeWs() {
  const sent: any[] = []
  const closed: Array<{ code?: number; reason?: string }> = []
  return {
    raw: { id: Math.random() },
    send: (s: string) => { sent.push(JSON.parse(s)) },
    close: (code?: number, reason?: string) => { closed.push({ code, reason }) },
    sent,
    closed,
    last: (type: string) => [...sent].reverse().find(m => m.type === type),
    has: (type: string) => sent.some(m => m.type === type),
  }
}

/**
 * An org with a till: one desktop-bridged fiscal device, assigned to one registered desktop.
 *
 * `assign: false` creates the same pair WITHOUT the assignment, which is the negative case the
 * `device_not_assigned` rule exists for.
 */
async function seedDesktop(opts: { assign?: boolean; pin?: boolean } = {}) {
  const org = await createTestOrg()
  const wh = await createTestWarehouse(org._id)
  const device = await createTestFiscalDevice(org._id, wh._id, {
    connectionType: 'desktop',
    manufacturer: 'datecs',
  } as any)

  const desktop = await Desktop.create({
    orgId: org._id,
    name: 'Till 2',
    machineId: 'm-1',
    installationId: `inst-${Math.random()}`,
    publicKey: 'x'.repeat(60),
    keyEpoch: 1,
    status: 'active',
    fiscalDeviceIds: opts.assign === false ? [] : [device._id],
  })

  if (opts.pin) {
    await FiscalDevice.updateOne(
      { _id: device._id },
      { $set: { 'connectionParams.bridgeDesktopId': desktop._id } },
    )
  }

  const { token } = signDesktopToken({
    desktopId: String(desktop._id),
    orgId: String(org._id),
    keyEpoch: desktop.keyEpoch ?? 1,
  })

  return { org, wh, device, desktop, token }
}

/** A cashier's browser token, for the "may a browser take a desktop device" cases. */
async function userToken(orgId: any, permissions: string[]) {
  const user = await createTestUser(orgId, { permissions } as any)
  const token = await signer.sign({
    id: String(user._id),
    email: user.email,
    username: user.username,
    firstName: user.firstName,
    lastName: user.lastName,
    role: user.role,
    orgId: String(orgId),
    permissions,
  })
  return { user, token }
}

const registerMsg = (extra: Record<string, unknown> = {}) => ({ type: 'fiscal:bridge:register', ...extra })

beforeAll(async () => {
  await setupTestDB()
})

afterAll(async () => {
  await teardownTestDB()
})

afterEach(async () => {
  await clearCollections()
})

describe('the native bridge authenticates as a desktop', () => {
  it('registers an assigned device and is served', async () => {
    const { org, device, token } = await seedDesktop()
    const ws = fakeWs()

    await handleMessage(ws, registerMsg({ deviceNumber: device.deviceNumber, orgId: String(org._id), token }))

    expect(ws.has('fiscal:bridge:registered')).toBe(true)
    expect(isDeviceConnected(String(device._id))).toBe(true)
    const fresh = await FiscalDevice.findById(device._id).lean()
    expect((fresh as any).status).toBe('online')

    await handleClose(ws)
  })

  it('reports the holder as the desktop, by name, for the POS label', async () => {
    // FR-14.27 — "connected via Till 2". Read from the LIVE socket map, which is why it goes
    // away on close rather than lingering like the stored `status`.
    const { org, device, token } = await seedDesktop()
    const ws = fakeWs()

    await handleMessage(ws, registerMsg({ deviceNumber: device.deviceNumber, orgId: String(org._id), token }))

    const holder = bridgeHolder(String(org._id), device.deviceNumber)
    expect(holder?.kind).toBe('desktop')
    expect(holder?.label).toBe('Till 2')
    expect(holder?.desktopId).toBeTruthy()

    await handleClose(ws)
    expect(bridgeHolder(String(org._id), device.deviceNumber)).toBeNull()
  })

  it('refuses a device that is not assigned to this desktop', async () => {
    const { org, device, token } = await seedDesktop({ assign: false })
    const ws = fakeWs()

    await handleMessage(ws, registerMsg({ deviceNumber: device.deviceNumber, orgId: String(org._id), token }))

    expect(ws.last('fiscal:bridge:error')?.code).toBe('device_not_assigned')
    expect(ws.has('fiscal:bridge:registered')).toBe(false)
    expect(isDeviceConnected(String(device._id))).toBe(false)
  })

  it('honours bridgeDesktopId as a pin, and refuses another desktop that IS assigned', async () => {
    // The two-tills-on-one-counter case. Desktop B holds a valid credential and the device is in
    // its assignment, so only the pin stands between B and A's printer.
    const { org, device, desktop } = await seedDesktop({ pin: true })

    const other = await Desktop.create({
      orgId: org._id,
      name: 'Till 3',
      machineId: 'm-2',
      installationId: `inst-${Math.random()}`,
      publicKey: 'y'.repeat(60),
      keyEpoch: 1,
      status: 'active',
      fiscalDeviceIds: [device._id],
    })
    expect(String(other._id)).not.toBe(String(desktop._id))

    const { token } = signDesktopToken({
      desktopId: String(other._id),
      orgId: String(org._id),
      keyEpoch: 1,
    })
    const ws = fakeWs()
    await handleMessage(ws, registerMsg({ deviceNumber: device.deviceNumber, orgId: String(org._id), token }))

    expect(ws.last('fiscal:bridge:error')?.code).toBe('device_not_assigned')
    expect(isDeviceConnected(String(device._id))).toBe(false)
  })

  it('refuses a revoked desktop — the row is the revocation list', async () => {
    const { org, device, desktop, token } = await seedDesktop()
    await Desktop.updateOne({ _id: desktop._id }, { $set: { status: 'revoked' } })

    const ws = fakeWs()
    await handleMessage(ws, registerMsg({ deviceNumber: device.deviceNumber, orgId: String(org._id), token }))

    // ⚠ The specific code, not a flat `unauthenticated`: the shell deletes its key on this one.
    expect(ws.last('fiscal:bridge:error')?.code).toBe('desktop_revoked')
    expect(ws.closed.length).toBe(1)
    expect(isDeviceConnected(String(device._id))).toBe(false)
  })

  it('refuses a token minted before a key rotation', async () => {
    const { org, device, desktop, token } = await seedDesktop()
    await Desktop.updateOne({ _id: desktop._id }, { $set: { keyEpoch: 2 } })

    const ws = fakeWs()
    await handleMessage(ws, registerMsg({ deviceNumber: device.deviceNumber, orgId: String(org._id), token }))

    expect(ws.last('fiscal:bridge:error')?.code).toBe('key_rotated')
    expect(isDeviceConnected(String(device._id))).toBe(false)
  })

  it('refuses a desktop asking for ANOTHER org\'s device', async () => {
    // The org is taken from the row behind the credential, never from the message, so B's device
    // is simply not in A's lookup.
    const a = await seedDesktop()
    const b = await seedDesktop()
    const ws = fakeWs()

    await handleMessage(ws, registerMsg({
      deviceNumber: b.device.deviceNumber, orgId: String(a.org._id), token: a.token,
    }))

    expect(ws.has('fiscal:bridge:registered')).toBe(false)
    expect(isDeviceConnected(String(b.device._id))).toBe(false)
  })
})

describe('one owner per serial port', () => {
  it('a browser relay is refused a desktop-bridged device, and told why', async () => {
    // ⚠ The direction that matters most: a cashier opening the POS page must not be able to take
    // the port from the till's own bridge. `pos.write` is deliberately granted here — the refusal
    // must come from the device TYPE, not from a permission.
    const { org, device } = await seedDesktop()
    const { token } = await userToken(org._id, ['pos.write'])
    const ws = fakeWs()

    await handleMessage(ws, registerMsg({ deviceNumber: device.deviceNumber, orgId: String(org._id), token }))

    expect(ws.last('fiscal:bridge:error')?.code).toBe('bridged_by_desktop')
    expect(ws.has('fiscal:bridge:registered')).toBe(false)
    expect(isDeviceConnected(String(device._id))).toBe(false)
  })

  it('an ADMIN browser cannot take over a desktop-bridged device, takeover flag or not', async () => {
    // ⚠ The eviction path is reached only after the device lookup matches, and a `desktop` device
    // never matches for a user principal. So `admin.settings` + `takeover: true` — the one
    // combination that CAN evict another browser — still cannot touch a till's bridge.
    const { org, device, token: deskToken } = await seedDesktop()
    const deskWs = fakeWs()
    await handleMessage(deskWs, registerMsg({
      deviceNumber: device.deviceNumber, orgId: String(org._id), token: deskToken,
    }))
    expect(isDeviceConnected(String(device._id))).toBe(true)

    const { token } = await userToken(org._id, ['pos.write', 'admin.settings'])
    const ws = fakeWs()
    await handleMessage(ws, registerMsg({
      deviceNumber: device.deviceNumber, orgId: String(org._id), token, takeover: true,
    }))

    expect(ws.has('fiscal:bridge:registered')).toBe(false)
    expect(ws.last('fiscal:bridge:error')?.code).toBe('bridged_by_desktop')
    // And the till's bridge is intact — not evicted, not even notified.
    expect(deskWs.has('fiscal:bridge:evicted')).toBe(false)
    expect(isDeviceConnected(String(device._id))).toBe(true)
    expect(bridgeHolder(String(org._id), device.deviceNumber)?.kind).toBe('desktop')

    await handleClose(deskWs)
  })

  it('a desktop is refused a browser device', async () => {
    // The mirror image, so the disjointness is asserted in both directions.
    const { org, wh, desktop, token } = await seedDesktop()
    const browserDevice = await createTestFiscalDevice(org._id, wh._id, {
      connectionType: 'browser',
    } as any)
    await Desktop.updateOne(
      { _id: desktop._id },
      { $set: { fiscalDeviceIds: [browserDevice._id] } },
    )

    const ws = fakeWs()
    await handleMessage(ws, registerMsg({
      deviceNumber: browserDevice.deviceNumber, orgId: String(org._id), token,
    }))

    expect(ws.last('fiscal:bridge:error')?.code).toBe('device_not_found')
    expect(isDeviceConnected(String(browserDevice._id))).toBe(false)
  })

  it('a second desktop cannot take the port from the one holding it', async () => {
    const { org, device, token } = await seedDesktop()
    const first = fakeWs()
    await handleMessage(first, registerMsg({ deviceNumber: device.deviceNumber, orgId: String(org._id), token }))
    expect(first.has('fiscal:bridge:registered')).toBe(true)

    const other = await Desktop.create({
      orgId: org._id,
      name: 'Till 3',
      machineId: 'm-3',
      installationId: `inst-${Math.random()}`,
      publicKey: 'z'.repeat(60),
      keyEpoch: 1,
      status: 'active',
      fiscalDeviceIds: [device._id],
    })
    const second = signDesktopToken({
      desktopId: String(other._id), orgId: String(org._id), keyEpoch: 1,
    }).token

    const ws = fakeWs()
    // ⚠ `takeover: true` is sent on purpose: a desktop must not be able to evict even by asking.
    await handleMessage(ws, registerMsg({
      deviceNumber: device.deviceNumber, orgId: String(org._id), token: second, takeover: true,
    }))

    expect(ws.last('fiscal:bridge:error')?.code).toBe('bridge_in_use')
    expect(first.has('fiscal:bridge:evicted')).toBe(false)
    expect(bridgeHolder(String(org._id), device.deviceNumber)?.label).toBe('Till 2')

    await handleClose(first)
  })

  it('re-registering the SAME socket stays idempotent', async () => {
    const { org, device, token } = await seedDesktop()
    const ws = fakeWs()
    const msg = registerMsg({ deviceNumber: device.deviceNumber, orgId: String(org._id), token })

    await handleMessage(ws, msg)
    await handleMessage(ws, msg)

    expect(ws.sent.filter(m => m.type === 'fiscal:bridge:registered').length).toBe(2)
    expect(ws.has('fiscal:bridge:error')).toBe(false)
    expect(isDeviceConnected(String(device._id))).toBe(true)

    await handleClose(ws)
  })
})

describe('a desktop token is not a user token', () => {
  it('a user JWT is refused on a desktop device without reaching the user path', async () => {
    const { org, device } = await seedDesktop()
    const { token } = await userToken(org._id, [])
    const ws = fakeWs()

    await handleMessage(ws, registerMsg({ deviceNumber: device.deviceNumber, orgId: String(org._id), token }))

    // No pos.write, so the user path refuses it — the point is that it is never treated as a
    // desktop on the strength of what it claims.
    expect(ws.last('fiscal:bridge:error')?.code).toBe('forbidden')
    expect(isDeviceConnected(String(device._id))).toBe(false)
  })

  it('a desktop token cannot be used where a browser session is expected', async () => {
    const { org, wh, token } = await seedDesktop()
    const browserDevice = await createTestFiscalDevice(org._id, wh._id, {
      connectionType: 'browser',
    } as any)
    const ws = fakeWs()

    await handleMessage(ws, registerMsg({
      deviceNumber: browserDevice.deviceNumber, orgId: String(org._id), token,
    }))

    // It authenticates as a desktop (the signature decides, not the message), and then fails to
    // find a device of a type it may serve. What it must NEVER do is pass as a user.
    expect(ws.has('fiscal:bridge:registered')).toBe(false)
    expect(isDeviceConnected(String(browserDevice._id))).toBe(false)
  })

  it('an unauthenticated socket still registers nothing (C02 holds)', async () => {
    const { org, device } = await seedDesktop()
    const ws = fakeWs()

    await handleMessage(ws, registerMsg({ deviceNumber: device.deviceNumber, orgId: String(org._id) }))

    expect(ws.last('fiscal:bridge:error')?.code).toBe('unauthenticated')
    expect(ws.closed.length).toBe(1)
    expect(isDeviceConnected(String(device._id))).toBe(false)
  })
})

describe('revocation stops the bridge from the server side', () => {
  it('drops the socket and unregisters the printer', async () => {
    /**
     * ⚠ The shell stops its own bridge when it learns it was revoked (FR-14.22), but it may be
     * offline, mid-print, or simply not listening. Revocation must not depend on the till
     * cooperating, so the hub drops the socket too — and, crucially, unregisters the printer, or
     * a sale could still be routed to a revoked till.
     */
    const { org, device, desktop, token } = await seedDesktop()
    const ws = fakeWs()
    await handleMessage(ws, registerMsg({ deviceNumber: device.deviceNumber, orgId: String(org._id), token }))
    expect(isDeviceConnected(String(device._id))).toBe(true)

    const stopped = await stopDesktopBridges(String(desktop._id))

    expect(stopped).toBe(1)
    expect(ws.has('fiscal:bridge:evicted')).toBe(true)
    expect(ws.closed.length).toBe(1)
    expect(isDeviceConnected(String(device._id))).toBe(false)
    expect(bridgeHolder(String(org._id), device.deviceNumber)).toBeNull()
    const fresh = await FiscalDevice.findById(device._id).lean()
    expect((fresh as any).status).toBe('offline')
  })

  it('leaves another desktop\'s bridge alone', async () => {
    // A reaper that gets this wrong takes a working till offline because a different one was
    // revoked, so the negative case is the one worth asserting.
    const a = await seedDesktop()
    const b = await seedDesktop()
    const wsA = fakeWs()
    const wsB = fakeWs()
    await handleMessage(wsA, registerMsg({ deviceNumber: a.device.deviceNumber, orgId: String(a.org._id), token: a.token }))
    await handleMessage(wsB, registerMsg({ deviceNumber: b.device.deviceNumber, orgId: String(b.org._id), token: b.token }))

    const stopped = await stopDesktopBridges(String(a.desktop._id))

    expect(stopped).toBe(1)
    expect(isDeviceConnected(String(a.device._id))).toBe(false)
    expect(isDeviceConnected(String(b.device._id))).toBe(true)
    expect(wsB.has('fiscal:bridge:evicted')).toBe(false)

    await handleClose(wsB)
  })

  it('stopping bridges for a desktop that holds none is a no-op, not an error', async () => {
    const { desktop } = await seedDesktop()
    expect(await stopDesktopBridges(String(desktop._id))).toBe(0)
  })

  it('does not touch a BROWSER bridge', async () => {
    // `stopDesktopBridges` walks every live bridge; a cashier's relay must not be collateral.
    const { org, wh } = await seedDesktop()
    const browserDevice = await createTestFiscalDevice(org._id, wh._id, {
      connectionType: 'browser',
    } as any)
    const { token } = await userToken(org._id, ['pos.write'])
    const ws = fakeWs()
    await handleMessage(ws, registerMsg({
      deviceNumber: browserDevice.deviceNumber, orgId: String(org._id), token,
    }))
    expect(isDeviceConnected(String(browserDevice._id))).toBe(true)

    expect(await stopDesktopBridges('000000000000000000000000')).toBe(0)
    expect(isDeviceConnected(String(browserDevice._id))).toBe(true)

    await handleClose(ws)
  })
})
