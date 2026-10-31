import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { Elysia } from 'elysia'
import jwt from '@elysiajs/jwt'
import { PERMISSIONS } from 'config/constants'
import { mongoose } from 'db/connection'
import { createTestOrg, createTestWarehouse, createTestFiscalDevice } from '../helpers/factories'
import { EltradeSimulator } from '../helpers/eltrade-simulator'
import { IslResponseCollector } from 'ui-shared/composables/fiscalIslResponse'
import { startTwoPods, type TwoPods } from './harness'

/**
 * FR-24.54: the two-pod till lane. Two processes of one global on one database (`replicas: 2`), a
 * simulated Eltrade bridged to pod A, and the till's requests sent to pod B. Each must print on the
 * device through A, exactly once; with A gone, B refuses with nothing done. Runs with `LGR_TWO_NODE=1`
 * (CI, beside two-node.test.ts).
 */

const enabled = process.env.LGR_TWO_NODE === '1'

describe.skipIf(!enabled)('two pods of one global, one till', () => {
  let pods: TwoPods
  let orgId = ''
  let deviceId = ''
  let warehouseId = ''
  let token = ''
  const sim = new EltradeSimulator()
  let bridge: WebSocket | null = null

  const api = (pod: 'a' | 'b', method: string, path: string, body?: unknown) =>
    fetch(`${pods[pod].url}/api/org/${orgId}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    }).then(async r => ({ status: r.status, json: (await r.json().catch(() => null)) as any }))

  beforeAll(async () => {
    pods = await startTwoPods()
    await mongoose.connect(pods.mongoUri)
    const org = await createTestOrg()
    const wh = await createTestWarehouse(org._id)
    const device = await createTestFiscalDevice(org._id, wh._id, {
      name: 'Каса 1', deviceNumber: sim.serial, manufacturer: 'eltrade', connectionType: 'browser', status: 'offline',
    } as any)
    orgId = String(org._id)
    deviceId = String(device._id)
    warehouseId = String(wh._id)
    const signer = new Elysia().use(jwt({ name: 'jwt', secret: pods.jwtSecret })) as any
    token = await signer.decorator.jwt.sign({
      id: '000000000000000000000001', orgId, role: 'admin', firstName: 'Ana', lastName: 'Till',
      permissions: [...PERMISSIONS], ownRecordsModules: [], operatorCode: '0001',
    })

    // The till's browser, bridged to pod A: it relays each command to the simulated device.
    bridge = new WebSocket(`${pods.a.url.replace('http', 'ws')}/ws/fiscal-bridge`)
    const registered = new Promise<void>((resolve, reject) => {
      bridge!.onmessage = async (event) => {
        const msg = JSON.parse(String(event.data))
        if (msg.type === 'fiscal:bridge:registered') resolve()
        if (msg.type === 'fiscal:bridge:error') reject(new Error(msg.message))
        if (msg.type !== 'fiscal:command') return
        const frame = Buffer.from(msg.frame, 'base64')
        const collector = new IslResponseCollector(frame[2])
        collector.push(new Uint8Array(await sim.exchange(frame)))
        bridge!.send(JSON.stringify({ type: 'fiscal:response', commandId: msg.commandId, frame: Buffer.from(collector.bytes()).toString('base64') }))
      }
    })
    await new Promise<void>((resolve, reject) => { bridge!.onopen = () => resolve(); bridge!.onerror = () => reject(new Error('bridge socket failed')) })
    bridge.send(JSON.stringify({ type: 'fiscal:bridge:register', deviceNumber: sim.serial, orgId, token, instanceId: 'till-tab-1' }))
    await registered
  }, 300_000)

  afterAll(async () => {
    try { bridge?.close() } catch { /* gone */ }
    await mongoose.disconnect().catch(() => undefined)
    await pods?.stop()
  }, 120_000)

  it('pod B sees the device as connected, via the till on pod A (FR-24.47)', async () => {
    const { status, json } = await api('b', 'GET', '/fiscal/device')
    expect(status).toBe(200)
    const d = json.fiscalDevices.find((x: any) => String(x._id ?? x.id) === deviceId)
    expect(d.connected).toBe(true)
    expect(d.bridgedBy).toMatchObject({ kind: 'user', label: 'Ana Till' })
  })

  it('a device report asked of pod B prints once, on the device pod A holds (FR-24.50/24.51)', async () => {
    const before = sim.reports.length
    const res = await api('b', 'POST', `/fiscal/device/${deviceId}/x-report`)
    expect(res.status).toBe(200)
    expect(sim.reports.length).toBe(before + 1)
  })

  it('the device status asked of pod B is read from the device through pod A', async () => {
    const res = await api('b', 'GET', `/fiscal/device/${deviceId}/status`)
    expect(res.status).toBe(200)
    expect(res.json.serialNumber ?? res.json.status?.serialNumber ?? JSON.stringify(res.json)).toContain(sim.serial)
  })

  it('a till session opened on pod B is opened where the printer is, and only once', async () => {
    const res = await api('b', 'POST', '/trade/pos/session', { warehouseId, openingBalance: 0, currency: 'EUR' })
    expect(res.status).toBe(200)
    expect(res.json.session).toBeTruthy()
    const again = await api('b', 'POST', '/trade/pos/session', { warehouseId, openingBalance: 0, currency: 'EUR' })
    expect(again.status).toBe(400) // "You already have an open session": the same database answered
  })

  it('pod A gone: pod B refuses with nothing done, never prints elsewhere or skips the receipt (FR-24.51/24.52)', async () => {
    const before = sim.reports.length
    await pods.a.stop()
    const res = await api('b', 'POST', `/fiscal/device/${deviceId}/x-report`)
    expect(res.status).toBe(503)
    expect(res.json.code).toBe('fiscal_holder_unreachable')
    expect(sim.reports.length).toBe(before)
  }, 60_000)
})
