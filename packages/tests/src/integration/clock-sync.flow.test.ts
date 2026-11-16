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
import { EltradeFiscalPrinter } from 'fiscal/eltrade'
import { EltradeSimulator } from '../helpers/eltrade-simulator'

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

// #450: an Eltrade that stayed on summer time reads an hour ahead. The driver refused any step back over 5 minutes, so
// a person who checked both times had no way to correct it: its Z-reports carried the wrong hour.
describe('an Eltrade an hour ahead (#450)', () => {
  const HOUR = 60 * MIN
  function eltradeAhead(deviceId: string, aheadMs: number) {
    const sim = new EltradeSimulator()
    sim.clock = new Date(Date.now() + aheadMs)
    registerPrinter(deviceId, new EltradeFiscalPrinter(sim.exchange, deviceId))
    registered.push(deviceId)
    return sim
  }

  test('the scheduled sync never moves it back: that waits for a person', async () => {
    const sim = eltradeAhead('dev-summer', HOUR)
    const before = sim.clock.getTime()
    await serverClock(0)
    const r = await syncAllFiscalDevices()
    expect(r.set).toEqual([])
    expect(r.held[0].reason).toContain('waits for a person')
    expect(sim.clock.getTime()).toBe(before)
  })

  test('the driver on its own still refuses a step back that large', async () => {
    const sim = eltradeAhead('dev-driver', HOUR)
    const printer = new EltradeFiscalPrinter(sim.exchange, 'dev-driver')
    let refused: any = null
    try { await printer.syncDateTime(new Date()) } catch (e) { refused = e }
    expect(String(refused?.message)).toContain('Refusing to move the Eltrade clock back')
    expect(sim.clock.getTime()).toBeGreaterThan(Date.now() + 50 * MIN)
  })

  test('a person who confirms it on the device page sets it back to the right hour', async () => {
    const org = await createTestOrg()
    const wh = await createTestWarehouse(org._id)
    const d = await createTestFiscalDevice(org._id, wh._id, { connectionType: 'browser', manufacturer: 'eltrade' } as any)
    const orgId = String(org._id)
    const deviceId = String(d._id)
    const sim = eltradeAhead(deviceId, HOUR)
    await serverClock(0)
    const signer = new Elysia().use(jwt({ name: 'jwt', secret: config.jwt.secret }))
    const auth = `Bearer ${await (signer as any).decorator.jwt.sign({ id: '000000000000000000000001', orgId, role: 'admin', permissions: [...PERMISSIONS], ownRecordsModules: [] })}`
    const post = (body?: object) => fetch(`http://localhost:${port}/org/${orgId}/fiscal/device/${deviceId}/sync-time`, {
      method: 'POST', headers: { authorization: auth, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined,
    })

    const asked = await post()
    expect(asked.status).toBe(409)
    expect((await asked.json()).message).toMatch(/the device's clock would move by -(1 h|59 min)/)

    const confirmed = await post({ confirm: true })
    expect(confirmed.status).toBe(200)
    expect(Math.abs(sim.clock.getTime() - Date.now())).toBeLessThan(5_000)
  })
})

// #450, the owner's decision: LGR adds no rule of its own on a fiscalized unit (the device refuses a time before its last
// fiscal record by itself), and it says when a device's clock waits for a person, so the October hour is not found by
// reading a Z-report. The scheduled sync notes it on the device; the device page, the device list and the sessions list
// show it; a person's confirmed time sync settles it.
describe('a clock the sync left for a person is noted on the device (#450)', () => {
  const HOUR = 60 * MIN
  const signer = new Elysia().use(jwt({ name: 'jwt', secret: config.jwt.secret }))

  test('noted when held, carried by the device list and by id, and cleared by the confirmed sync', async () => {
    const { FiscalDevice } = await import('db/models')
    const org = await createTestOrg()
    const wh = await createTestWarehouse(org._id)
    const d = await createTestFiscalDevice(org._id, wh._id, { connectionType: 'browser', name: 'Каса 1' } as any)
    const orgId = String(org._id)
    const deviceId = String(d._id)
    fakeDevice(deviceId, HOUR)
    await serverClock(0)

    const r = await syncAllFiscalDevices()
    expect(r.set).toEqual([])
    const noted: any = (await FiscalDevice.findById(deviceId).lean().exec())!.clockHeld
    expect(noted).toBeTruthy()
    // Ahead by an hour: the step is minus an hour, give or take the test's own seconds.
    expect(Math.abs(noted.stepMs + HOUR)).toBeLessThan(5_000)

    const auth = { authorization: `Bearer ${await (signer as any).decorator.jwt.sign({ id: '000000000000000000000001', orgId, role: 'admin', permissions: [...PERMISSIONS], ownRecordsModules: [] })}` }
    const list = await (await fetch(`http://localhost:${port}/org/${orgId}/fiscal/device?size=100`, { headers: auth })).json()
    expect(list.fiscalDevices.find((x: any) => String(x._id ?? x.id) === deviceId)?.clockHeld?.stepMs).toBe(noted.stepMs)
    const one = await (await fetch(`http://localhost:${port}/org/${orgId}/fiscal/device/${deviceId}`, { headers: auth })).json()
    expect(one.fiscalDevice.clockHeld?.stepMs).toBe(noted.stepMs)

    const confirmed = await fetch(`http://localhost:${port}/org/${orgId}/fiscal/device/${deviceId}/sync-time`, {
      method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ confirm: true }),
    })
    expect(confirmed.status).toBe(200)
    expect((await FiscalDevice.findById(deviceId).lean().exec())!.clockHeld).toBeUndefined()
  })

  test('a clock the sync sets clears what an earlier sync noted', async () => {
    const { FiscalDevice } = await import('db/models')
    const org = await createTestOrg()
    const wh = await createTestWarehouse(org._id)
    const d = await createTestFiscalDevice(org._id, wh._id, { connectionType: 'browser' } as any)
    const deviceId = String(d._id)
    await FiscalDevice.updateOne({ _id: deviceId }, { $set: { clockHeld: { deviceTime: new Date(), serverTime: new Date(), stepMs: -HOUR, at: new Date() } } }).exec()
    const set = fakeDevice(deviceId, -30_000)
    await serverClock(0)
    const r = await syncAllFiscalDevices()
    expect(r.set).toEqual([deviceId])
    expect(set.length).toBe(1)
    expect((await FiscalDevice.findById(deviceId).lean().exec())!.clockHeld).toBeUndefined()
  })
})
