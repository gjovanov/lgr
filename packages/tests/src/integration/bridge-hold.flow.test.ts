import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test'
import { Elysia } from 'elysia'
import jwt from '@elysiajs/jwt'
import { config } from 'config'
import { DEFAULT_ROLE_PERMISSIONS } from 'config/constants'
import { Desktop, FiscalDevice, FiscalPresence, Invoice } from 'db/models'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import {
  createTestOrg, createTestProduct, createTestStockLevel, createTestUser, createTestWarehouse, createTestFiscalDevice,
} from '../helpers/factories'
import { captureRejection } from '../helpers/capture-rejection'
import { EltradeSimulator } from '../helpers/eltrade-simulator'
import { tokenize } from 'services/biz/auth.service'
import { getRepos } from 'services/context'
import { getNextNumber } from 'services/biz/sequence.service'
import { signDesktopToken } from 'services/biz/desktop/desktop.service'
import { EltradeFiscalPrinter } from 'fiscal/eltrade'
import { getPrinter, isDeviceConnected, lostHereAt, registerPrinter, unregisterPrinter } from 'fiscal/fiscal-device.service'
import { deviceForWarehouse, setFiscalForwarding } from 'fiscal/fiscal-route'
import { BRIDGE_HOLD_MS, BRIDGE_LOST_RECENT_MS, justLost } from 'fiscal/bridge-hold'
import { deviceTurn } from 'fiscal/device-turn'
import { fiscalDeviceController } from '../../../portal-api/src/controllers/fiscal-device.controller'
import { handleClose, handleMessage, stopDesktopBridges } from '../../../portal-api/src/websocket/fiscal-bridge'
import { posController } from 'invoicing-api/src/controllers/pos.controller'

/**
 * #869 (the owner's ruling, 2026-11-19): a request for a fiscal device whose bridge has JUST dropped waits for it, up to
 * 5 s, instead of being refused or saving a sale without its receipt; and nothing already handed to the old bridge is
 * ever sent again.
 *
 * Three places, each through the real code: the routing layer (`fiscal-route.ts`, the device controller and the till's
 * sale route), the hub's close (`fiscal-bridge.ts`, its exported handlers with a stand-in socket), and the till's
 * printer at the start of a print (`tillPrinter`, the POS sale route on the Eltrade simulator). The "other pod" is a
 * stand-in `forward`, as in `fiscal-route.flow.test.ts`.
 *
 * ⚠ No `.rejects` / `.resolves` (CLAUDE.md).
 */

let app: Elysia
const forwarded: Array<{ to: string; path: string }> = []
const registered: string[] = []
/** Every stand-in socket a test opened (`fakeWs`): the hub keeps a bridge it registered until its socket closes. */
const sockets: Array<{ raw: unknown }> = []

beforeAll(async () => {
  await setupTestDB()
  app = new Elysia().use(fiscalDeviceController).use(posController)
  setFiscalForwarding({
    async forward(to, request) {
      forwarded.push({ to, path: new URL(request.url).pathname })
      return new Response(JSON.stringify({ from: 'pod-b' }), { status: 200, headers: { 'content-type': 'application/json' } })
    },
    isHop: () => false,
    clientIp: () => '203.0.113.7',
    self: () => null,
  })
}, 60_000)
afterAll(async () => {
  setFiscalForwarding(null)
  await teardownTestDB()
}, 60_000)
afterEach(async () => {
  // A bridge the hub registered (`registerOn`) is not in `registered`. Left open, its printer outlives this file, and
  // the next file's scheduled clock sync (`clock-sync.flow`) holds it and then waits on its socket, which never answers.
  // `handleClose` is a no-op for a socket it already closed.
  for (const ws of sockets.splice(0)) await handleClose(ws)
  for (const id of registered.splice(0)) unregisterPrinter(id)
  forwarded.splice(0)
  await clearCollections()
}, 30_000)

const signer = (new Elysia().use(jwt({ name: 'jwt', secret: config.jwt.secret })) as any).decorator.jwt

/**
 * An Eltrade on a bridge, played by the simulator. `drop()` is the bridge going away: from then on every command it is
 * handed fails, as a closed socket's does. `commands` is what reached the device through it.
 */
function bridgeTo(sim: EltradeSimulator, deviceId: string) {
  let alive = true
  const commands: number[] = []
  const printer = new EltradeFiscalPrinter(async (frame: Buffer) => {
    if (!alive) throw new Error('Fiscal bridge disconnected')
    commands.push(new Uint8Array(frame)[3])
    return sim.exchange(frame)
  }, deviceId)
  return { printer, commands, drop: () => { alive = false } }
}

/** What the hub does when a bridge closes by itself: the printer goes, and this process stamps when. */
function lose(deviceId: string): void {
  unregisterPrinter(deviceId, { lost: true })
}

function register(deviceId: string, printer: EltradeFiscalPrinter): void {
  registerPrinter(deviceId, printer)
  registered.push(deviceId)
}

async function until(test: () => Promise<boolean> | boolean, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms
  while (!(await test())) {
    if (Date.now() > deadline) throw new Error('timed out waiting')
    await new Promise(r => setTimeout(r, 20))
  }
}

/** The device page's routes, as an Administrator calls them. */
async function deviceWorld() {
  const org = await createTestOrg()
  const wh = await createTestWarehouse(org._id)
  const device = await createTestFiscalDevice(org._id, wh._id, {
    name: 'Каса 1', deviceNumber: 'ED123456', manufacturer: 'eltrade', connectionType: 'browser', status: 'offline',
  } as any)
  const orgId = String(org._id)
  const deviceId = String(device._id)
  const token = await signer.sign(await tokenize(await createTestUser(org._id, { role: 'admin' } as any)))
  const call = async (method: string, path: string) => {
    const started = Date.now()
    const res = await app.handle(new Request(`http://localhost/org/${orgId}/fiscal/device/${deviceId}${path}`, {
      method, headers: { authorization: `Bearer ${token}` },
    }))
    return { status: res.status, json: (await res.json().catch(() => null)) as any, ms: Date.now() - started }
  }
  return { org, wh, device, orgId, deviceId, call }
}

/** Another pod holds the device now, as its presence row says. */
async function heldOnPodB(w: { orgId: string; deviceId: string; device: any }) {
  await FiscalPresence.init()
  const now = new Date()
  await FiscalPresence.create({
    orgId: w.orgId, deviceNumber: w.device.deviceNumber, deviceId: w.deviceId, kind: 'user', label: 'Till on B',
    podId: 'pod-b', podAddr: 'http://10.0.0.2:4001', connId: 'conn-b', connectedAt: now, heartbeatAt: now,
  })
}

describe('#869: what counts as "just lost"', () => {
  it('within a minute, either way of a few seconds of clock skew; nothing, or longer ago, is not', () => {
    const now = Date.now()
    expect(justLost(now - 1_000, now)).toBe(true)
    expect(justLost(new Date(now - BRIDGE_LOST_RECENT_MS + 1_000), now)).toBe(true)
    expect(justLost(now + 2_000, now)).toBe(true)
    expect(justLost(now - BRIDGE_LOST_RECENT_MS - 1_000, now)).toBe(false)
    expect(justLost(undefined, now)).toBe(false)
    expect(justLost(null, now)).toBe(false)
    expect(BRIDGE_HOLD_MS).toBe(5_000)
  })
})

describe('#869: the routing layer waits for a bridge that has just dropped', () => {
  it('and runs the request here once the bridge registers here again', async () => {
    const w = await deviceWorld()
    await FiscalDevice.updateOne({ _id: w.deviceId }, { bridgeLostAt: new Date() })
    const sim = new EltradeSimulator()
    setTimeout(() => register(w.deviceId, bridgeTo(sim, w.deviceId).printer), 300)

    const res = await w.call('POST', '/x-report')

    expect(res.status).toBe(200)
    expect(sim.reports).toHaveLength(1)
    expect(res.ms).toBeGreaterThanOrEqual(250)
    expect(res.ms).toBeLessThan(BRIDGE_HOLD_MS)
    expect(forwarded).toHaveLength(0)
  })

  it('and forwards it when the bridge comes back on another pod', async () => {
    const w = await deviceWorld()
    await FiscalDevice.updateOne({ _id: w.deviceId }, { bridgeLostAt: new Date() })
    setTimeout(() => { void heldOnPodB(w) }, 300)

    const res = await w.call('POST', '/x-report')

    expect(res.json).toEqual({ from: 'pod-b' })
    expect(forwarded).toEqual([{ to: 'http://10.0.0.2:4001', path: `/org/${w.orgId}/fiscal/device/${w.deviceId}/x-report` }])
    expect(res.ms).toBeGreaterThanOrEqual(250)
  })

  it('this process\'s own stamp is enough: it is there the moment the socket closes, before the device row says so', async () => {
    const w = await deviceWorld()
    const sim = new EltradeSimulator()
    register(w.deviceId, bridgeTo(sim, w.deviceId).printer)
    lose(w.deviceId)
    expect(justLost(lostHereAt(w.deviceId))).toBe(true)
    setTimeout(() => register(w.deviceId, bridgeTo(sim, w.deviceId).printer), 300)

    const res = await w.call('POST', '/x-report')

    expect(res.status).toBe(200)
    expect(res.ms).toBeGreaterThanOrEqual(250)
    expect(lostHereAt(w.deviceId)).toBeUndefined() // the registration cleared it
  })

  it('a bridge that does not come back: the route\'s own answer, after the hold, with nothing sent', async () => {
    const w = await deviceWorld()
    await FiscalDevice.updateOne({ _id: w.deviceId }, { bridgeLostAt: new Date() })

    const res = await w.call('POST', '/x-report')

    expect(res.status).toBe(503) // the device page's own "not connected"
    expect(res.ms).toBeGreaterThanOrEqual(BRIDGE_HOLD_MS - 50)
    expect(res.ms).toBeLessThan(BRIDGE_HOLD_MS + 3_000)
    expect(forwarded).toHaveLength(0)
  }, 20_000)

  it('a bridge lost longer ago than a minute is gone: no wait', async () => {
    const w = await deviceWorld()
    await FiscalDevice.updateOne({ _id: w.deviceId }, { bridgeLostAt: new Date(Date.now() - BRIDGE_LOST_RECENT_MS - 5_000) })

    const res = await w.call('POST', '/x-report')

    expect(res.status).toBe(503)
    expect(res.ms).toBeLessThan(2_000)
  })

  it('a read never waits: a status poll says what is true now', async () => {
    const w = await deviceWorld()
    await FiscalDevice.updateOne({ _id: w.deviceId }, { bridgeLostAt: new Date() })

    const res = await w.call('GET', '/status')

    expect(res.ms).toBeLessThan(2_000)
    expect(forwarded).toHaveLength(0)
  })

  it('a warehouse\'s device whose bridge just dropped is what a sale there waits for; one lost long ago is nothing', async () => {
    const org = await createTestOrg()
    const wh = await createTestWarehouse(org._id)
    const device = await createTestFiscalDevice(org._id, wh._id, { bridgeLostAt: new Date() } as any)

    expect((await deviceForWarehouse(String(org._id), wh._id))?.deviceId).toBe(String(device._id))

    await FiscalDevice.updateOne({ _id: device._id }, { bridgeLostAt: new Date(Date.now() - 2 * 60_000) })
    expect(await deviceForWarehouse(String(org._id), wh._id)).toBeNull()
  })
})

// ── The hub's side ────────────────────────────────────────────────────────────────────────────────

/** A stand-in for Elysia's ws wrapper (`fiscal-bridge-auth.flow.test.ts`). */
function fakeWs() {
  const sent: any[] = []
  const closed: Array<{ code?: number; reason?: string }> = []
  const ws = {
    raw: { id: Math.random() },
    send: (s: string) => { sent.push(JSON.parse(s)) },
    close: (code?: number, reason?: string) => { closed.push({ code, reason }) },
    sent,
    closed,
    has: (type: string) => sent.some(m => m.type === type),
  }
  sockets.push(ws)
  return ws
}

/** A cashier's browser relay for a Datecs (which sends nothing on its own once registered). */
async function browserBridge() {
  const org = await createTestOrg()
  const wh = await createTestWarehouse(org._id)
  const device = await createTestFiscalDevice(org._id, wh._id)
  const token = await signer.sign(await tokenize(await createTestUser(org._id)) as any)
  const registerOn = async (ws: ReturnType<typeof fakeWs>) => {
    await handleMessage(ws, { type: 'fiscal:bridge:register', deviceNumber: device.deviceNumber, orgId: String(org._id), token })
    expect(ws.has('fiscal:bridge:registered')).toBe(true)
  }
  return { org, device, deviceId: String(device._id), registerOn }
}

describe('#869: the hub says when a bridge went away by itself', () => {
  it('its printer goes at once, before anything is awaited, and the device row says when', async () => {
    const b = await browserBridge()
    const ws = fakeWs()
    await b.registerOn(ws)
    expect(isDeviceConnected(b.deviceId)).toBe(true)

    const closing = handleClose(ws)
    expect(isDeviceConnected(b.deviceId)).toBe(false) // synchronously: a request in the gap must never get it
    expect(justLost(lostHereAt(b.deviceId))).toBe(true)
    await closing

    const row: any = await FiscalDevice.findById(b.deviceId).lean().exec()
    expect(row.status).toBe('offline')
    expect(justLost(row.bridgeLostAt)).toBe(true)
  })

  it('a revoked till is no loss: nothing will wait for it', async () => {
    const org = await createTestOrg()
    const wh = await createTestWarehouse(org._id)
    const device = await createTestFiscalDevice(org._id, wh._id, { connectionType: 'desktop', manufacturer: 'datecs' } as any)
    const desktop = await Desktop.create({
      orgId: org._id, name: 'Till 2', machineId: 'm-1', installationId: `inst-${Math.random()}`,
      publicKey: 'x'.repeat(60), keyEpoch: 1, status: 'active', fiscalDeviceIds: [device._id],
    })
    const { token } = signDesktopToken({ desktopId: String(desktop._id), orgId: String(org._id), keyEpoch: 1 })
    const ws = fakeWs()
    await handleMessage(ws, { type: 'fiscal:bridge:register', deviceNumber: device.deviceNumber, orgId: String(org._id), token })
    expect(isDeviceConnected(String(device._id))).toBe(true)

    expect(await stopDesktopBridges(String(desktop._id))).toBe(1)

    expect(isDeviceConnected(String(device._id))).toBe(false)
    expect(lostHereAt(String(device._id))).toBeUndefined()
    const row: any = await FiscalDevice.findById(device._id).lean().exec()
    expect(row.status).toBe('offline')
    expect(row.bridgeLostAt).toBeUndefined()
  })

  it('a command in flight when its bridge drops fails, and is never sent through the bridge that comes back', async () => {
    const b = await browserBridge()
    const first = fakeWs()
    await b.registerOn(first)
    const held = getPrinter(b.deviceId)

    const inFlight = captureRejection(held.openFiscalReceipt('0001', 'Иван Петров', 'DT000001-0001-0000001'))
    await until(() => first.has('fiscal:command'))
    await handleClose(first)
    const err = await inFlight
    expect(String(err?.message)).toBe('Fiscal bridge disconnected')

    const second = fakeWs()
    await b.registerOn(second)
    await new Promise(r => setTimeout(r, 300))
    expect(second.has('fiscal:command')).toBe(false)
    expect(getPrinter(b.deviceId)).not.toBe(held)
  })
})

// ── The till: a sale over HTTP, on the Eltrade simulator (`pos-eltrade.flow.test.ts`) ─────────────

async function tillToken(u: { id: string; orgId: string }) {
  return signer.sign({
    id: u.id, orgId: u.orgId, role: 'admin', email: 'cashier@test.com', username: 'cashier',
    firstName: 'Иван', lastName: 'Петров', operatorCode: '0001',
    permissions: DEFAULT_ROLE_PERMISSIONS.admin, ownRecordsModules: [],
  })
}

/** 2 × 10.00 net at 20 % → 24.00 to pay. */
function saleBody(productId: string) {
  return {
    type: 'sale',
    lines: [{ productId, name: 'Болт DIN 933 М8Х25', quantity: 2, unitPrice: 10, discount: 0, taxRate: 20, taxAmount: 4, lineTotal: 20 }],
    subtotal: 20, discountTotal: 0, taxTotal: 4, total: 24,
    payments: [{ method: 'cash', amount: 24 }],
    changeDue: 0,
  }
}

async function tillWorld() {
  const org = await createTestOrg()
  const warehouse = await createTestWarehouse(org._id)
  const user = await createTestUser(org._id, { operatorCode: '0001' } as any)
  const product = await createTestProduct(org._id, { sellingPrice: 10, taxRate: 20 } as any)
  await createTestStockLevel(org._id, product._id, warehouse._id, { quantity: 100 })
  const device = await createTestFiscalDevice(org._id, warehouse._id, {
    name: 'Eltrade A3', deviceNumber: 'ED123456', manufacturer: 'eltrade', connectionType: 'browser', status: 'online',
  } as any)
  const deviceId = String(device._id)
  const sim = new EltradeSimulator()
  const first = bridgeTo(sim, deviceId)
  register(deviceId, first.printer)
  const session = await getRepos().posSessions.create({
    orgId: String(org._id), warehouseId: String(warehouse._id), cashierId: String(user._id),
    sessionNumber: await getNextNumber(String(org._id), 'POS', 6),
    openedAt: new Date(), status: 'open', openingBalance: 0, currency: 'EUR',
    totalSales: 0, totalReturns: 0, totalCash: 0, totalCard: 0, transactionCount: 0,
  } as any)
  const token = await tillToken({ id: String(user._id), orgId: String(org._id) })
  const sell = async () => {
    const started = Date.now()
    const res = await app.handle(new Request(`http://localhost/org/${org._id}/trade/pos/session/${session.id}/transaction`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(saleBody(String(product._id))),
    }))
    return { status: res.status, json: (await res.json().catch(() => null)) as any, ms: Date.now() - started }
  }
  return { org, deviceId, sim, first, sell }
}

describe('#869: a sale and its bridge', () => {
  it('a sale that arrives just after its bridge dropped waits for it, and prints once it is back', async () => {
    const w = await tillWorld()
    w.first.drop()
    lose(w.deviceId)
    const second = bridgeTo(w.sim, w.deviceId)
    setTimeout(() => register(w.deviceId, second.printer), 300)

    const { status, json, ms } = await w.sell()

    expect(status).toBe(200)
    expect(json.receiptError).toBeUndefined()
    expect(json.transaction.fiscalReceiptNumber).toBe('0000101')
    expect(ms).toBeGreaterThanOrEqual(250)
    expect(w.first.commands).toHaveLength(0)
    expect(w.sim.receipts).toHaveLength(1)
  })

  it('a sale that waited for the device\'s turn while its bridge dropped and came back prints on the new one', async () => {
    const w = await tillWorld()
    // The device's turn is held, as by another receipt printing: the sale writes its document, then waits there.
    let release!: () => void
    const blocker = deviceTurn(w.deviceId, () => new Promise<void>(r => { release = r }))
    const sale = w.sell()
    await until(async () => !!(await Invoice.exists({ orgId: w.org._id }).exec()))

    w.first.drop()
    lose(w.deviceId)
    const second = bridgeTo(w.sim, w.deviceId)
    register(w.deviceId, second.printer)
    release()
    await blocker
    const { status, json } = await sale

    expect(status).toBe(200)
    expect(json.receiptError).toBeUndefined()
    expect(json.transaction.fiscalReceiptNumber).toBe('0000101')
    expect(w.first.commands).toHaveLength(0) // nothing of it went to the bridge that dropped
    expect(second.commands.length).toBeGreaterThan(0)
    expect(w.sim.receipts).toHaveLength(1)
  })

  it('a receipt whose bridge drops mid-print is never finished nor sent again through the bridge that comes back', async () => {
    const w = await tillWorld()
    let second: ReturnType<typeof bridgeTo> | null = null
    // The bridge drops as the receipt's first line is on its way, and a new one registers at once.
    w.sim.beforeCommand = (cmd) => {
      if (cmd !== 0x31 || second) return
      w.first.drop()
      lose(w.deviceId)
      second = bridgeTo(w.sim, w.deviceId)
      register(w.deviceId, second.printer)
      throw new Error('Fiscal bridge disconnected')
    }

    const { status, json } = await w.sell()

    expect(status).toBe(200) // the sale is recorded, and says its receipt did not print
    expect(json.receiptError).toBeTruthy()
    expect(second).not.toBeNull()
    expect(second!.commands).toHaveLength(0) // not one command of it through the new bridge
    expect(w.sim.receipts).toHaveLength(0)
    expect(w.sim.receipt?.sales).toEqual([]) // its receipt is still open on the device, as the old bridge left it

    // The next sale prints on the new bridge, and voids what the interrupted one left open first.
    const next = await w.sell()
    expect(next.json.receiptError).toBeUndefined()
    expect(w.sim.receipts.map(r => ({ voided: !!r.voided, sales: r.sales.length }))).toEqual([
      { voided: true, sales: 0 },
      { voided: false, sales: 1 },
    ])
    expect(second!.commands.length).toBeGreaterThan(0)
  })
})
