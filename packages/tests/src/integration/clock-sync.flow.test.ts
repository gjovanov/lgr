/**
 * FR-20.22 / AC 58 (plan step P1-10) — no unverified clock reaches a fiscal device, by the scheduled
 * sync or without a person's say-so.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { Elysia } from 'elysia'
import jwt from '@elysiajs/jwt'
import { config } from 'config'
import { PERMISSIONS } from 'config/constants'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { createTestOrg, createTestWarehouse, createTestFiscalDevice } from '../helpers/factories'
import { fiscalDeviceController } from '../../../portal-api/src/controllers/fiscal-device.controller'
import { registerPrinter, unregisterPrinter } from 'fiscal/fiscal-device.service'
import { forgetClockVerification, TIME_SOURCES, verifyClock } from 'fiscal/clock'
import { syncAllFiscalDevices } from 'fiscal/time-sync.service'

let server: any
let port = 0
const registered: string[] = []

beforeAll(async () => {
  await setupTestDB()
  server = new Elysia().use(fiscalDeviceController).listen(0)
  port = server.server.port
}, 60_000)
afterAll(async () => {
  server?.stop?.()
  await teardownTestDB()
}, 60_000)
afterEach(async () => {
  for (const id of registered.splice(0)) unregisterPrinter(id)
  forgetClockVerification()
  await clearCollections()
})

const MIN = 60_000

/** A device whose clock reads `offsetMs` from now, and that records what it is set to. */
function fakeDevice(deviceId: string, offsetMs: number) {
  const set: Date[] = []
  registerPrinter(deviceId, {
    readDateTime: async () => new Date(Date.now() + offsetMs),
    syncDateTime: async (d: Date) => { set.push(d) },
  } as any)
  registered.push(deviceId)
  return set
}

/** Verify the server clock as `driftMs` off (Cloudflare's answer is now − drift), or unreachable. */
async function serverClock(driftMs: number | 'unreachable') {
  const fetchImpl = (async (url: string) => {
    if (driftMs === 'unreachable') throw Object.assign(new Error('reset'), { code: 'ECONNRESET' })
    if (url !== TIME_SOURCES[0].url) throw new Error('only Cloudflare here')
    return new Response(`ts=${((Date.now() - driftMs) / 1000).toFixed(3)}\n`)
  }) as unknown as typeof fetch
  return verifyClock({ fetch: fetchImpl })
}

describe('the scheduled sync', () => {
  test('AC 58: the OS clock three days wrong and no time source reachable: nothing is set', async () => {
    const set = fakeDevice('dev-a', -3 * 24 * 60 * MIN)
    expect((await serverClock('unreachable')).state).toBe('unknown')
    const r = await syncAllFiscalDevices()
    expect(set).toEqual([])
    expect(r.set).toEqual([])
    expect(r.held).toEqual([{ deviceId: 'dev-a', reason: 'the server clock has not been verified since it started' }])
  })

  test('a server clock verified but three days off sets nothing either', async () => {
    const set = fakeDevice('dev-a', 0)
    await serverClock(3 * 24 * 60 * MIN)
    const r = await syncAllFiscalDevices()
    expect(set).toEqual([])
    expect(r.held[0].reason).toContain('the server clock is off by +3 d 0 h')
  })

  test('a verified clock sets a device within 2 minutes, and holds one further off for a person', async () => {
    const near = fakeDevice('dev-near', -40_000)
    const far = fakeDevice('dev-far', -10 * MIN)
    await serverClock(300)
    const r = await syncAllFiscalDevices()
    expect(near.length).toBe(1)
    expect(far).toEqual([])
    expect(r.set).toEqual(['dev-near'])
    expect(r.held).toEqual([{ deviceId: 'dev-far', reason: "the device's clock would move by +10 min 0 s: a step that large waits for a person" }])
  })
})

describe('a person setting a device clock', () => {
  const signer = new Elysia().use(jwt({ name: 'jwt', secret: config.jwt.secret }))
  const token = (orgId: string, role = 'admin') =>
    (signer as any).decorator.jwt.sign({ id: '000000000000000000000001', orgId, role, permissions: [...PERMISSIONS], ownRecordsModules: [] })

  async function device() {
    const org = await createTestOrg()
    const wh = await createTestWarehouse(org._id)
    const d = await createTestFiscalDevice(org._id, wh._id, { connectionType: 'browser' } as any)
    return { orgId: String(org._id), deviceId: String(d._id) }
  }

  const syncTime = async (orgId: string, deviceId: string, body?: object, role?: string) =>
    fetch(`http://localhost:${port}/org/${orgId}/fiscal/device/${deviceId}/sync-time`, {
      method: 'POST',
      headers: { authorization: `Bearer ${await token(orgId, role)}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    })

  test('an unverified clock is not pushed without confirm: 409 with both times, then set on confirm', async () => {
    const { orgId, deviceId } = await device()
    const set = fakeDevice(deviceId, -5 * MIN)
    const asked = await syncTime(orgId, deviceId)
    expect(asked.status).toBe(409)
    const why = await asked.json()
    expect(why.code).toBe('clock_unconfirmed')
    expect(why.message).toContain('has not been verified')
    expect(typeof why.serverTime).toBe('string')
    expect(typeof why.deviceTime).toBe('string')
    expect(set).toEqual([])

    const confirmed = await syncTime(orgId, deviceId, { confirm: true })
    expect(confirmed.status).toBe(200)
    expect((await confirmed.json()).verified).toBe(false)
    expect(set.length).toBe(1)
  })

  test('a verified clock and a small step need no confirmation; a large step does', async () => {
    const { orgId, deviceId } = await device()
    await serverClock(0)
    const set = fakeDevice(deviceId, -30_000)
    const res = await syncTime(orgId, deviceId)
    expect(res.status).toBe(200)
    expect(set.length).toBe(1)

    unregisterPrinter(deviceId)
    const far = fakeDevice(deviceId, -30 * MIN)
    const big = await syncTime(orgId, deviceId)
    expect(big.status).toBe(409)
    expect((await big.json()).message).toContain("the device's clock would move by +30 min 0 s")
    expect(far).toEqual([])
  })

  test('a cashier cannot set a device clock at all', async () => {
    const { orgId, deviceId } = await device()
    fakeDevice(deviceId, 0)
    expect((await syncTime(orgId, deviceId, { confirm: true }, 'member')).status).toBe(403)
  })
})
