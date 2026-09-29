import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { Elysia } from 'elysia'
import jwt from '@elysiajs/jwt'
import { config } from 'config'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { createTestOrg, createTestWarehouse, createTestFiscalDevice } from '../helpers/factories'
import { EltradeSimulator } from '../helpers/eltrade-simulator'
import { setupFiscalBridgeWS } from '../../../portal-api/src/websocket/fiscal-bridge'
import { fiscalDeviceController } from '../../../portal-api/src/controllers/fiscal-device.controller'
import { getPrinter, isDeviceConnected } from 'fiscal/fiscal-device.service'
import { EltradeFiscalPrinter } from 'fiscal/eltrade'
import { IslResponseCollector } from 'ui-shared/composables/fiscalIslResponse'

/**
 * The browser bridge over a real WebSocket: `/ws/fiscal-bridge` on a live port, and a fake
 * browser that relays exactly as `useFiscalBridge` does for `protocol: 'isl'` — the frame goes
 * to the device (EltradeSimulator), the answer comes back through the same
 * `IslResponseCollector` the relay uses.
 *
 * NOTE: no `.rejects` / `.resolves` — the Bun-on-Windows deadlock in the Known Issues table.
 */

let server: any
let port = 0
const sockets: WebSocket[] = []

beforeAll(async () => {
  await setupTestDB()
  const app = new Elysia()
  setupFiscalBridgeWS(app)
  app.use(fiscalDeviceController)
  server = app.listen(0)
  port = server.server.port
}, 60_000)

afterAll(async () => {
  server?.stop?.()
  await teardownTestDB()
}, 60_000)

afterEach(async () => {
  for (const ws of sockets.splice(0)) ws.close()
  await new Promise(r => setTimeout(r, 100)) // let the server run its close handlers
  await clearCollections()
}, 30_000)

interface FakeBrowser {
  ws: WebSocket
  messages: any[]
  commands: { protocol?: string; timeoutMs?: number }[]
  next(type: string): Promise<any>
}

/** Connect and relay like the browser does; resolves once registered. */
async function connectBrowser(orgId: string, deviceNumber: string, sim: EltradeSimulator): Promise<FakeBrowser> {
  const ws = new WebSocket(`ws://localhost:${port}/ws/fiscal-bridge`)
  sockets.push(ws)
  const messages: any[] = []
  const commands: FakeBrowser['commands'] = []
  const waiters: { type: string; resolve: (m: any) => void }[] = []

  ws.onmessage = async (event) => {
    const msg = JSON.parse(String(event.data))
    messages.push(msg)
    for (const w of waiters.filter(w => w.type === msg.type)) {
      waiters.splice(waiters.indexOf(w), 1)
      w.resolve(msg)
    }
    if (msg.type !== 'fiscal:command') return
    commands.push({ protocol: msg.protocol, timeoutMs: msg.timeoutMs })
    const frame = Buffer.from(msg.frame, 'base64')
    try {
      const collector = new IslResponseCollector(frame[2])
      collector.push(new Uint8Array(await sim.exchange(frame)))
      ws.send(JSON.stringify({ type: 'fiscal:response', commandId: msg.commandId, frame: Buffer.from(collector.bytes()).toString('base64') }))
    } catch (e: any) {
      ws.send(JSON.stringify({ type: 'fiscal:response:error', commandId: msg.commandId, error: e.message }))
    }
  }
  await new Promise<void>((resolve, reject) => { ws.onopen = () => resolve(); ws.onerror = () => reject(new Error('ws failed')) })

  const next = (type: string) => {
    const seen = messages.find(m => m.type === type)
    if (seen) return Promise.resolve(seen)
    return new Promise<any>(resolve => waiters.push({ type, resolve }))
  }
  // ⚠ The register message carries the cashier's JWT (FR-14.25). Before that, this endpoint
  // authenticated nothing and a registration could evict a till's bridge from anywhere. The token
  // goes in the MESSAGE, never in the socket URL — a URL ends up in proxy logs.
  const token = await bridgeToken(orgId)
  ws.send(JSON.stringify({ type: 'fiscal:bridge:register', deviceNumber, orgId, warehouseId: '', token }))
  await next('fiscal:bridge:registered')
  return { ws, messages, commands, next }
}

/** A cashier's token: in the device's org, holding `pos.write` — the minimum the bridge needs. */
function bridgeToken(orgId: string): Promise<string> {
  return (signer as any).decorator.jwt.sign({
    id: '000000000000000000000001',
    orgId,
    role: 'member',
    firstName: 'Cashier',
    lastName: 'One',
    permissions: ['pos.write'],
    ownRecordsModules: [],
  })
}

async function eltradeDevice(deviceNumber = 'ED123456') {
  const org = await createTestOrg()
  const warehouse = await createTestWarehouse(org._id)
  const device = await createTestFiscalDevice(org._id, warehouse._id, {
    deviceNumber, manufacturer: 'eltrade', connectionType: 'browser',
  } as any)
  return { orgId: String(org._id), deviceId: String(device._id) }
}

describe('fiscal bridge with an Eltrade', () => {
  it('registers an Eltrade driver and reports what device answered', async () => {
    const { orgId, deviceId } = await eltradeDevice()
    const sim = new EltradeSimulator()
    sim.fiscalized = false
    const browser = await connectBrowser(orgId, 'ED123456', sim)

    expect(browser.messages.find(m => m.type === 'fiscal:bridge:registered').manufacturer).toBe('eltrade')
    expect(isDeviceConnected(deviceId)).toBe(true)
    expect(getPrinter(deviceId)).toBeInstanceOf(EltradeFiscalPrinter)

    const info = await browser.next('fiscal:bridge:info')
    expect(info.responding).toBe(true)
    expect(info.device).toMatchObject({ serialNumber: 'ED123456', fiscalMemoryNumber: '44123456', fiscalized: false, serialMismatch: false })
    // every frame asked for ISL framing with a time budget
    expect(browser.commands.length).toBeGreaterThan(0)
    expect(browser.commands.every(c => c.protocol === 'isl' && (c.timeoutMs ?? 0) > 0)).toBe(true)
  })

  it('flags a port that belongs to a different device than the one configured', async () => {
    const { orgId } = await eltradeDevice('ED000001')
    const sim = new EltradeSimulator() // reports ED123456
    const browser = await connectBrowser(orgId, 'ED000001', sim)
    const info = await browser.next('fiscal:bridge:info')
    expect(info.device.serialMismatch).toBe(true)
    expect(info.device.serialNumber).toBe('ED123456')
  })

  it('reports a device that does not answer, instead of discovering it on the first sale', async () => {
    const { orgId } = await eltradeDevice()
    const sim = new EltradeSimulator()
    sim.silent = true
    const browser = await connectBrowser(orgId, 'ED123456', sim)
    const info = await browser.next('fiscal:bridge:info')
    expect(info.responding).toBe(false)
    expect(info.device.errors.join()).toContain('main menu')
  })

  it('prints a whole receipt through the bridge', async () => {
    const { orgId, deviceId } = await eltradeDevice()
    const sim = new EltradeSimulator()
    const browser = await connectBrowser(orgId, 'ED123456', sim)
    await browser.next('fiscal:bridge:info')

    const printer = getPrinter(deviceId)
    await printer.openFiscalReceipt('0001', 'Оператор', 'ED123456-0001-0000001')
    await printer.printSaleLine('Шайба М8', 10, 0.12, 'Б', undefined, 20)
    await printer.printPayment('card', 1.2)
    const result = await printer.closeFiscalReceipt()
    expect(result.fiscalReceiptNumber).toBe('0000101')
    expect(sim.receipts[0].payments).toEqual([{ mode: 'L', amount: 1.2 }])
  })

  it('unregisters the printer when the browser goes away', async () => {
    const { orgId, deviceId } = await eltradeDevice()
    const browser = await connectBrowser(orgId, 'ED123456', new EltradeSimulator())
    await browser.next('fiscal:bridge:info')
    browser.ws.close()
    for (let i = 0; i < 50 && isDeviceConnected(deviceId); i++) await new Promise(r => setTimeout(r, 20))
    expect(isDeviceConnected(deviceId)).toBe(false)
  })
})

const signer = new Elysia().use(jwt({ name: 'jwt', secret: config.jwt.secret }))

/** GET /fiscal/device the way the POS terminal calls it, as a cashier (not an admin). */
async function listDevices(orgId: string) {
  const token = await (signer as any).decorator.jwt.sign({ id: '000000000000000000000001', orgId, role: 'member', permissions: [], ownRecordsModules: [] })
  const res = await fetch(`http://localhost:${port}/org/${orgId}/fiscal/device?isActive=true&size=0`, { headers: { authorization: `Bearer ${token}` } })
  return res.json() as Promise<any>
}

describe('the device list, as the POS terminal reads it', () => {
  it('says a device is connected exactly while a bridge holds it', async () => {
    const { orgId, deviceId } = await eltradeDevice()
    const connected = async () => (await listDevices(orgId)).fiscalDevices.find((d: any) => String(d.id || d._id) === deviceId).connected

    expect(await connected()).toBe(false)
    const browser = await connectBrowser(orgId, 'ED123456', new EltradeSimulator())
    await browser.next('fiscal:bridge:info')
    expect(await connected()).toBe(true) // another tab holds it: this one shows "connected in another tab"

    browser.ws.close()
    for (let i = 0; i < 50 && isDeviceConnected(deviceId); i++) await new Promise(r => setTimeout(r, 20))
    expect(await connected()).toBe(false)
  })

  /**
   * FR-14.25, over a real socket. The handler-level cases live in
   * `fiscal-bridge-auth.flow.test.ts`; these two are here because "a stranger cannot take a
   * shop's printer" deserves proving end to end, on the wire.
   */
  it('refuses an unauthenticated registration on the wire', async () => {
    const { orgId, deviceId } = await eltradeDevice()
    const ws = new WebSocket(`ws://localhost:${port}/ws/fiscal-bridge`)
    sockets.push(ws)
    const messages: any[] = []
    ws.onmessage = (e) => messages.push(JSON.parse(String(e.data)))
    await new Promise<void>((resolve, reject) => { ws.onopen = () => resolve(); ws.onerror = () => reject(new Error('ws failed')) })

    // Exactly what the old protocol accepted: a device number and an org id, nothing else.
    ws.send(JSON.stringify({ type: 'fiscal:bridge:register', deviceNumber: 'ED123456', orgId, warehouseId: '' }))
    for (let i = 0; i < 50 && !messages.length; i++) await new Promise(r => setTimeout(r, 20))

    expect(messages.find(m => m.type === 'fiscal:bridge:error')?.code).toBe('unauthenticated')
    expect(messages.some(m => m.type === 'fiscal:bridge:registered')).toBe(false)
    expect(isDeviceConnected(deviceId)).toBe(false)
  })

  it('refuses a second opener instead of evicting the till that is printing', async () => {
    const { orgId, deviceId } = await eltradeDevice()
    const first = await connectBrowser(orgId, 'ED123456', new EltradeSimulator())
    await first.next('fiscal:bridge:info')
    expect(isDeviceConnected(deviceId)).toBe(true)

    const second = new WebSocket(`ws://localhost:${port}/ws/fiscal-bridge`)
    sockets.push(second)
    const messages: any[] = []
    second.onmessage = (e) => messages.push(JSON.parse(String(e.data)))
    await new Promise<void>((resolve, reject) => { second.onopen = () => resolve(); second.onerror = () => reject(new Error('ws failed')) })
    second.send(JSON.stringify({
      type: 'fiscal:bridge:register', deviceNumber: 'ED123456', orgId, warehouseId: '',
      token: await bridgeToken(orgId),
    }))
    for (let i = 0; i < 50 && !messages.length; i++) await new Promise(r => setTimeout(r, 20))

    expect(messages.find(m => m.type === 'fiscal:bridge:error')?.code).toBe('bridge_in_use')
    // The till keeps its printer, and was never told to go away.
    expect(isDeviceConnected(deviceId)).toBe(true)
    expect(first.messages.some(m => m.type === 'fiscal:bridge:evicted')).toBe(false)
  })

  it('never hands a cashier the connection params, not even through the raw page items', async () => {
    const org = await createTestOrg()
    const warehouse = await createTestWarehouse(org._id)
    await createTestFiscalDevice(org._id, warehouse._id, {
      deviceNumber: 'DT000001', manufacturer: 'datecs', connectionType: 'tcp', connectionParams: { ip: '10.9.8.7', tcpPort: 9100 },
    } as any)
    const json = await listDevices(String(org._id))

    expect(json.fiscalDevices).toHaveLength(1)
    expect(json.total).toBe(1)
    expect(json.items).toBeUndefined()
    expect(JSON.stringify(json)).not.toContain('10.9.8.7')
  })
})
