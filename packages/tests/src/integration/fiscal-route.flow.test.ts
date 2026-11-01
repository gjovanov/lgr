import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test'
import { Elysia } from 'elysia'
import jwt from '@elysiajs/jwt'
import { config } from 'config'
import { PERMISSIONS } from 'config/constants'
import { FiscalPresence } from 'db/models'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { createTestOrg, createTestWarehouse, createTestFiscalDevice } from '../helpers/factories'
import { EltradeSimulator } from '../helpers/eltrade-simulator'
import { fiscalDeviceController } from '../../../portal-api/src/controllers/fiscal-device.controller'
import { EltradeFiscalPrinter } from 'fiscal/eltrade'
import { registerPrinter, unregisterPrinter } from 'fiscal/fiscal-device.service'
import { setFiscalForwarding } from 'fiscal/fiscal-route'
import { getFiscalContext } from '../../../invoicing-api/src/lib/cash-register-till'

/**
 * FR-24.50–24.52 through the real device controller: a request for a printer another pod holds is
 * forwarded there, with its raw body, and its answer is this answer; an unreachable holder is 503
 * with nothing done; a hop is never forwarded again; a device held here runs here; and nothing that
 * reached the driver completes without a receipt while another pod holds the device.
 *
 * The "other pod" is a stand-in `forward` that records what it was handed. The real hop over HTTP
 * between two processes is the two-pod lane (`two-node/two-pods.test.ts`).
 *
 * ⚠ No `.rejects` / `.resolves` (CLAUDE.md).
 */

let app: Elysia
const forwarded: Array<{ to: string; method: string; path: string; body: string; client: string | null }> = []
let reachable = true
let hop = false

beforeAll(async () => {
  await setupTestDB()
  app = new Elysia().use(fiscalDeviceController)
  setFiscalForwarding({
    async forward(to, request, client) {
      const body = request.method === 'GET' ? '' : await request.text()
      forwarded.push({ to, method: request.method, path: new URL(request.url).pathname, body, client })
      return reachable ? new Response(JSON.stringify({ from: 'pod-b' }), { status: 200, headers: { 'content-type': 'application/json' } }) : null
    },
    isHop: () => hop,
    clientIp: () => '203.0.113.7',
  })
}, 60_000)
afterAll(async () => {
  setFiscalForwarding(null)
  await teardownTestDB()
}, 60_000)
afterEach(async () => {
  forwarded.splice(0)
  reachable = true
  hop = false
  await clearCollections()
}, 30_000)

const signer = new Elysia().use(jwt({ name: 'jwt', secret: config.jwt.secret }))
const token = (orgId: string) =>
  (signer as any).decorator.jwt.sign({ id: '000000000000000000000001', orgId, role: 'admin', permissions: [...PERMISSIONS], ownRecordsModules: [] })

async function world() {
  const org = await createTestOrg()
  const wh = await createTestWarehouse(org._id)
  const device = await createTestFiscalDevice(org._id, wh._id, {
    name: 'Каса 1', deviceNumber: 'ED123456', manufacturer: 'eltrade', connectionType: 'browser', status: 'online',
  } as any)
  const orgId = String(org._id)
  const deviceId = String(device._id)
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await app.handle(new Request(`http://localhost/org/${orgId}/fiscal/device/${deviceId}${path}`, {
      method,
      headers: { authorization: `Bearer ${await token(orgId)}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    }))
    return { status: res.status, json: (await res.json().catch(() => null)) as any }
  }
  return { orgId, deviceId, wh, device, call }
}

/** The device held on pod B, as its presence row says. */
async function heldOnPodB(w: { orgId: string; deviceId: string; device: any }, podAddr: string | null = 'http://10.0.0.2:4001') {
  await FiscalPresence.init()
  const now = new Date()
  await FiscalPresence.create({
    orgId: w.orgId, deviceNumber: w.device.deviceNumber, deviceId: w.deviceId, kind: 'user', label: 'Till on B',
    podId: 'pod-b', ...(podAddr ? { podAddr } : {}), connId: 'conn-b', connectedAt: now, heartbeatAt: now,
  })
}

describe('FR-24.50/24.51: the request goes to the printer', () => {
  it('a device held on another pod: forwarded there, raw body and all, and its answer is the answer', async () => {
    const w = await world()
    await heldOnPodB(w)
    const body = { operator: 3, from: '2026-10-01', note: 'Каса — „ден"' }
    const res = await w.call('POST', '/operator-report', body)
    expect(res).toEqual({ status: 200, json: { from: 'pod-b' } })
    expect(forwarded).toHaveLength(1)
    expect(forwarded[0]).toMatchObject({ to: 'http://10.0.0.2:4001', method: 'POST', path: `/org/${w.orgId}/fiscal/device/${w.deviceId}/operator-report`, client: '203.0.113.7' })
    expect(forwarded[0].body).toBe(JSON.stringify(body)) // byte for byte
  })

  it('a GET is forwarded too (the device status lives where the device is)', async () => {
    const w = await world()
    await heldOnPodB(w)
    expect((await w.call('GET', '/status')).json).toEqual({ from: 'pod-b' })
    expect(forwarded[0]).toMatchObject({ method: 'GET', body: '' })
  })

  it('the holder unreachable: 503 fiscal_holder_unreachable, nothing done here', async () => {
    const w = await world()
    await heldOnPodB(w)
    reachable = false
    const res = await w.call('POST', '/x-report')
    expect(res.status).toBe(503)
    expect(res.json.code).toBe('fiscal_holder_unreachable')
  })

  it('a holder row with no address cannot be reached either', async () => {
    const w = await world()
    await heldOnPodB(w, null)
    const res = await w.call('POST', '/x-report')
    expect({ status: res.status, code: res.json.code }).toEqual({ status: 503, code: 'fiscal_holder_unreachable' })
    expect(forwarded).toHaveLength(0)
  })

  it('a hop is never forwarded again: the device has moved, 409', async () => {
    const w = await world()
    await heldOnPodB(w)
    hop = true
    const res = await w.call('POST', '/x-report')
    expect({ status: res.status, code: res.json.code }).toEqual({ status: 409, code: 'fiscal_holder_moved' })
    expect(forwarded).toHaveLength(0)
  })

  it('a device this process holds runs here, whatever a stale row says', async () => {
    const w = await world()
    await heldOnPodB(w)
    const sim = new EltradeSimulator()
    registerPrinter(w.deviceId, new EltradeFiscalPrinter(sim.exchange, w.deviceId))
    try {
      const res = await w.call('POST', '/x-report')
      expect(res.status).toBe(200)
      expect(forwarded).toHaveLength(0)
      expect(sim.reports.length).toBe(1)
    } finally {
      unregisterPrinter(w.deviceId)
    }
  })

  it('a device nobody holds runs here, with the route\'s own rule (no forward)', async () => {
    const w = await world()
    const res = await w.call('POST', '/x-report')
    expect(res.status).toBe(503) // "not connected": the device page's own answer
    expect(forwarded).toHaveLength(0)
  })
})

describe('FR-24.52: held elsewhere is never offline', () => {
  it('getFiscalContext refuses rather than returning "no device" while another pod holds it', async () => {
    const w = await world()
    await heldOnPodB(w)
    let err: any = null
    try {
      await getFiscalContext(w.orgId, String(w.wh._id))
    } catch (e) {
      err = e
    }
    expect(err?.code).toBe('fiscal_held_elsewhere')
  })

  it('and with nobody holding it anywhere, the old rule stands: no device, no receipt', async () => {
    const w = await world()
    expect(await getFiscalContext(w.orgId, String(w.wh._id))).toBeNull()
  })
})
