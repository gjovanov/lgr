import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup.js'
import { createTestOrg, createTestUser, createTestWarehouse, createTestFiscalDevice } from '../helpers/factories.js'
import { FiscalDevice, FiscalPresence } from 'db/models'
import { isDeviceConnected } from 'fiscal/fiscal-device.service'
import {
  DEAD_MS,
  claimPresence,
  heartbeatPresence,
  livePresence,
  markUnheldDevicesOffline,
  releasePresence,
  requestEviction,
} from 'services/biz/fiscal-presence.service'
import { handleMessage, handleClose, presenceTick, closeAllBridges } from '../../../portal-api/src/websocket/fiscal-bridge'
import { Elysia } from 'elysia'
import jwt from '@elysiajs/jwt'
import { config } from 'config'

/**
 * FR-24 Phase 5: who holds a fiscal device is a row in `fiscal_presence`, so a bridge held on a
 * sibling pod counts. These drive the real registration with stand-in sockets, as
 * `desktop-fiscal-bridge.flow.test.ts` does, and write the "other pod" rows directly.
 *
 * ⚠ No `.rejects` / `.resolves`: one reaps the shared mongod on Windows (CLAUDE.md).
 */

const signer = (new Elysia().use(jwt({ name: 'jwt', secret: config.jwt.secret })) as any).decorator.jwt

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
  }
}

async function till() {
  const org = await createTestOrg()
  const wh = await createTestWarehouse(org._id)
  const device = await createTestFiscalDevice(org._id, wh._id, { connectionType: 'browser', manufacturer: 'datecs' } as any)
  const user = await createTestUser(org._id, { permissions: ['pos.write'] } as any)
  const token = await signer.sign({
    id: String(user._id), email: user.email, username: user.username, firstName: 'Ana', lastName: 'Till',
    role: user.role, orgId: String(org._id), permissions: ['pos.write'],
  })
  const admin = await createTestUser(org._id, { permissions: ['pos.write', 'admin.settings'] } as any)
  const adminToken = await signer.sign({
    id: String(admin._id), email: admin.email, username: admin.username, firstName: 'Boss', lastName: 'Admin',
    role: 'admin', orgId: String(org._id), permissions: ['pos.write', 'admin.settings'],
  })
  return { org, device, token, adminToken }
}

const register = (t: { device: any; token: string }, extra: Record<string, unknown> = {}) =>
  ({ type: 'fiscal:bridge:register', deviceNumber: t.device.deviceNumber, token: t.token, ...extra })

/** A row as a sibling pod would hold it. */
async function siblingRow(t: { org: any; device: any }, over: Record<string, unknown> = {}) {
  const now = new Date()
  await FiscalPresence.init()
  await FiscalPresence.create({
    orgId: t.org._id, deviceNumber: t.device.deviceNumber, deviceId: t.device._id, kind: 'user', label: 'Till on pod B',
    instanceId: 'tab-on-b', podId: 'pod-b', connId: 'conn-b', connectedAt: now, heartbeatAt: now, ...over,
  })
}

beforeAll(async () => { await setupTestDB() })
afterAll(async () => {
  await closeAllBridges()
  await teardownTestDB()
})
afterEach(async () => {
  await closeAllBridges() // each test's bridges go with it
  await clearCollections()
})

describe('FR-24.45: the presence row decides who holds a device', () => {
  it('a registration claims the row; its close releases it', async () => {
    const t = await till()
    const ws = fakeWs()
    await handleMessage(ws, register(t, { instanceId: 'tab-1' }))
    expect(ws.last('fiscal:bridge:registered')).toBeTruthy()
    const row: any = await livePresence({ orgId: String(t.org._id), deviceNumber: t.device.deviceNumber })
    expect(row).toMatchObject({ kind: 'user', label: 'Ana Till', instanceId: 'tab-1' })

    await handleClose(ws)
    expect(await FiscalPresence.countDocuments()).toBe(0)
    expect(isDeviceConnected(String(t.device._id))).toBe(false)
  })

  it('a bridge held on ANOTHER pod refuses a second opener here (bridge_in_use)', async () => {
    const t = await till()
    await siblingRow(t)
    const ws = fakeWs()
    await handleMessage(ws, register(t, { instanceId: 'tab-here' }))
    expect(ws.last('fiscal:bridge:error')).toMatchObject({ code: 'bridge_in_use' })
    expect(ws.last('fiscal:bridge:error').message).toContain('Till on pod B')
    expect(isDeviceConnected(String(t.device._id))).toBe(false)
  })

  it('the same tab reconnecting takes its own row over at once, even from a crashed pod', async () => {
    const t = await till()
    await siblingRow(t, { instanceId: 'tab-same' })
    const ws = fakeWs()
    await handleMessage(ws, register(t, { instanceId: 'tab-same' }))
    expect(ws.last('fiscal:bridge:registered')).toBeTruthy()
    expect((await FiscalPresence.findOne().lean() as any).podId).not.toBe('pod-b')
  })

  it('a dead row (no heartbeat for 20 s) is anyone\'s', async () => {
    const t = await till()
    await siblingRow(t, { heartbeatAt: new Date(Date.now() - DEAD_MS - 1000) })
    const ws = fakeWs()
    await handleMessage(ws, register(t, { instanceId: 'tab-new' }))
    expect(ws.last('fiscal:bridge:registered')).toBeTruthy()
  })

  it('an admin takes over a device held on another pod; that pod\'s heartbeat then lets go', async () => {
    const t = await till()
    await siblingRow(t)
    const ws = fakeWs()
    await handleMessage(ws, register({ device: t.device, token: t.adminToken }, { takeover: true, instanceId: 'admin-tab' }))
    expect(ws.last('fiscal:bridge:registered')).toBeTruthy()
    // Pod B's next heartbeat: its connection no longer owns the row.
    const lost = await heartbeatPresence([{ orgId: String(t.org._id), deviceNumber: t.device.deviceNumber, connId: 'conn-b' }])
    expect(lost).toEqual([{ connId: 'conn-b', reason: 'taken_over', by: 'Boss Admin' }])
  })

  it('a takeover decided on another pod drops the bridge here on the next tick, and tells it', async () => {
    const t = await till()
    const ws = fakeWs()
    await handleMessage(ws, register(t, { instanceId: 'tab-1' }))
    // Pod B replaced the row (its own admin took over).
    await FiscalPresence.updateOne({}, { $set: { connId: 'conn-b', label: 'Boss on pod B', podId: 'pod-b' } })
    await presenceTick()
    expect(ws.last('fiscal:bridge:evicted').message).toContain('Boss on pod B')
    expect(ws.closed.length).toBeGreaterThan(0)
    expect(isDeviceConnected(String(t.device._id))).toBe(false)
    // The row is pod B's: the drop here did not release it.
    expect(await FiscalPresence.countDocuments({ connId: 'conn-b' })).toBe(1)
  })

  it('a revocation asked for on another pod (evict) drops the bridge here on the next tick', async () => {
    const t = await till()
    const ws = fakeWs()
    await handleMessage(ws, register(t, { instanceId: 'tab-1' }))
    expect(await requestEviction({ orgId: String(t.org._id), deviceNumber: t.device.deviceNumber }, 'desktop_revoked')).toBe(1)
    await presenceTick()
    expect(ws.last('fiscal:bridge:evicted')).toBeTruthy()
    expect(isDeviceConnected(String(t.device._id))).toBe(false)
  })

  it('a late close of an old socket does not release the row its successor holds', async () => {
    const t = await till()
    const old = fakeWs()
    await handleMessage(old, register(t, { instanceId: 'tab-1' }))
    const fresh = fakeWs()
    await handleMessage(fresh, register(t, { instanceId: 'tab-1' }))
    expect(fresh.last('fiscal:bridge:registered')).toBeTruthy()
    await handleClose(old)
    expect(await livePresence({ orgId: String(t.org._id), deviceNumber: t.device.deviceNumber })).toBeTruthy()
    expect(isDeviceConnected(String(t.device._id))).toBe(true)
    await handleClose(fresh)
  })
})

describe('FR-24.44: a stop closes the bridges with 1012 and releases their rows', () => {
  it('closes with 1012 and leaves no row behind, so another pod can claim at once', async () => {
    const t = await till()
    const ws = fakeWs()
    await handleMessage(ws, register(t, { instanceId: 'tab-1' }))
    expect(await closeAllBridges()).toBe(1)
    expect(ws.closed).toContainEqual({ code: 1012, reason: 'server_restart' })
    expect(await FiscalPresence.countDocuments()).toBe(0)
  })
})

describe('FR-24.46: offline is decided by the rows, not by a reset at boot', () => {
  it('marks online only what no live row holds, on any pod', async () => {
    const t = await till()
    const other = await createTestFiscalDevice(t.org._id, (await createTestWarehouse(t.org._id))._id, { connectionType: 'browser' } as any)
    await FiscalDevice.updateMany({}, { status: 'online' })
    await siblingRow(t) // held on pod B
    expect(await markUnheldDevicesOffline()).toBe(1)
    expect((await FiscalDevice.findById(t.device._id).lean() as any).status).toBe('online')
    expect((await FiscalDevice.findById(other._id).lean() as any).status).toBe('offline')
  })
})

describe('the claim itself', () => {
  it('releases only with the claiming connection id', async () => {
    const t = await till()
    const key = { orgId: String(t.org._id), deviceNumber: t.device.deviceNumber }
    const res = await claimPresence({ ...key, deviceId: String(t.device._id) }, { kind: 'server', label: 'Server' }, { connId: 'c1' })
    expect(res.ok).toBe(true)
    expect(await releasePresence(key, 'someone-else')).toBe(false)
    expect(await releasePresence(key, 'c1')).toBe(true)
  })
})
