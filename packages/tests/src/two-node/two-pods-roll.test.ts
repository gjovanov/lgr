import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { Elysia } from 'elysia'
import jwt from '@elysiajs/jwt'
import { PERMISSIONS } from 'config/constants'
import { mongoose } from 'db/connection'
import { Invoice } from 'db/models'
import { createTestContact, createTestFiscalDevice, createTestOrg, createTestProduct, createTestStockLevel, createTestWarehouse } from '../helpers/factories'
import { EltradeSimulator } from '../helpers/eltrade-simulator'
import { IslResponseCollector } from 'ui-shared/composables/fiscalIslResponse'
import { startTwoPods, type Node, type TwoPods } from './harness'

/**
 * FR-23 on two pods, while the pods change: what production does from the moment R1 deploys.
 *
 * A device's turn (`fiscal/device-turn.ts`) is a queue in the process holding the device, and the
 * holder moves: a roll stops pods one by one, an admin takes a device over, a pod crashes. So each of
 * these holds one thing still: **every receipt closed on the device has exactly one payment, and no
 * payment was printed twice.**
 *
 * - A graceful stop finishes the queue before it lets go of the device.
 * - A device taken over mid-queue costs the waiting request its print, and nothing else.
 * - A request that waits its turn past the server's 30 s idle limit loses its connection and keeps
 *   its place, and its key finds what it did.
 * - A crash leaves a receipt whose lease (120 s) outlives the holder's presence row (20 s): on the pod
 *   that took the device over, that document reads as printing until the lease lapses, and only then
 *   is the receipt proved or held. A person settles what cannot be proved.
 *
 * Runs with `LGR_TWO_NODE=1`, beside `two-pods.test.ts`.
 */

const enabled = process.env.LGR_TWO_NODE === '1'

const PAYMENT = 0x35
const CLOSE = 0x38
const REPORT = 0x45

const until = async (what: string, condition: () => boolean | Promise<boolean>, ms = 30_000) => {
  const deadline = Date.now() + ms
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await Bun.sleep(20)
  }
}
const gate = () => {
  let open!: () => void
  const closed = new Promise<void>(resolve => { open = resolve })
  return { closed, open }
}

describe.skipIf(!enabled)('a device whose holder moves between pods (FR-23, FR-24)', () => {
  let pods: TwoPods
  let orgId = ''
  let deviceId = ''
  let warehouseId = ''
  let contactId = ''
  let token = ''
  const sim = new EltradeSimulator()
  const sockets: WebSocket[] = []
  /** Who holds the device now, and the pods the roll has left. */
  let holder: Node
  let spare: Node
  let till: Awaited<ReturnType<typeof openBridge>>

  const api = (pod: Node, method: string, path: string, body?: unknown, key?: string) =>
    fetch(`${pod.url}/api/org/${orgId}${path}`, {
      method,
      headers: {
        ...pods.frontHeaders,
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(key ? { 'idempotency-key': key } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    }).then(async r => ({ status: r.status, json: (await r.json().catch(() => null)) as any }))

  /** A till's bridge on `pod`: it relays each command to the simulated device, one at a time. */
  async function openBridge(pod: Node, instanceId: string, opts: { takeover?: boolean } = {}) {
    const ws = new WebSocket(`${pod.url.replace('http', 'ws')}/ws/fiscal-bridge`, { headers: pods.frontHeaders } as any)
    sockets.push(ws)
    let closeCode = 0
    let onEvicted: () => void = () => undefined
    const evicted = new Promise<void>(resolve => { onEvicted = resolve })
    const closed = new Promise<void>(resolve => ws.addEventListener('close', (e: any) => { closeCode = e.code; resolve() }))
    const registered = new Promise<void>((resolve, reject) => {
      ws.onmessage = async (event) => {
        const msg = JSON.parse(String(event.data))
        if (msg.type === 'fiscal:bridge:registered') resolve()
        if (msg.type === 'fiscal:bridge:error') reject(new Error(`${msg.code}: ${msg.message}`))
        if (msg.type === 'fiscal:bridge:evicted') onEvicted()
        if (msg.type !== 'fiscal:command') return
        const frame = Buffer.from(msg.frame, 'base64')
        const collector = new IslResponseCollector(frame[2])
        // A frame the device never took, or an answer with nobody left to hear it.
        const answer = await sim.exchange(frame).catch(() => null)
        if (!answer || ws.readyState !== WebSocket.OPEN) return
        collector.push(new Uint8Array(answer))
        ws.send(JSON.stringify({ type: 'fiscal:response', commandId: msg.commandId, frame: Buffer.from(collector.bytes()).toString('base64') }))
      }
    })
    await new Promise<void>((resolve, reject) => { ws.onopen = () => resolve(); ws.onerror = () => reject(new Error('bridge socket failed')) })
    ws.send(JSON.stringify({ type: 'fiscal:bridge:register', deviceNumber: sim.serial, orgId, token, instanceId, ...(opts.takeover ? { takeover: true } : {}) }))
    await registered
    return { ws, evicted, closed, closeCode: () => closeCode }
  }

  const today = () => new Date().toISOString().slice(0, 10)
  const toPay = (amount = 12, method = 'cash') => ({ date: today(), amount, method })
  /** An invoice issued on a bank transfer, 12 gross: what a payment at the counter pays. */
  async function issued() {
    const draft = await api(spare, 'POST', '/invoices', {
      type: 'invoice', direction: 'outgoing', contactId, issueDate: today(), currency: 'EUR', paymentMethod: 'bank_transfer',
      lines: [{ description: 'Услуга', quantity: 1, unit: 'бр.', unitPrice: 10, taxRate: 20, taxAmount: 2, lineTotal: 12 }],
      subtotal: 10, taxTotal: 2, total: 12,
    })
    expect(draft.status).toBe(200)
    const id = String(draft.json.invoice.id)
    expect((await api(spare, 'POST', `/invoices/${id}/send`, {})).status).toBe(200)
    return id
  }
  const raw = (id: string) => Invoice.findById(id).lean().exec() as Promise<any>
  const receiptOf = (id: string) => Invoice.findOne({ type: 'payment_receipt', 'register.paidInvoiceId': id }).sort({ _id: -1 }).lean().exec() as Promise<any>
  const closedOnDevice = () => sim.receipts.filter(r => !r.voided)

  beforeAll(async () => {
    pods = await startTwoPods({ front: true })
    await mongoose.connect(pods.mongoUri)
    const org = await createTestOrg()
    const wh = await createTestWarehouse(org._id)
    const device = await createTestFiscalDevice(org._id, wh._id, {
      name: 'Каса 1', deviceNumber: sim.serial, manufacturer: 'eltrade', connectionType: 'browser', status: 'offline',
    } as any)
    const product = await createTestProduct(org._id, { name: 'Болт', sellingPrice: 10, purchasePrice: 4, taxRate: 20 } as any)
    await createTestStockLevel(org._id, product._id, wh._id, { quantity: 50, availableQuantity: 50, avgCost: 4 } as any)
    orgId = String(org._id)
    deviceId = String(device._id)
    warehouseId = String(wh._id)
    contactId = String((await createTestContact(org._id, { companyName: 'Клиент ООД', type: 'customer' } as any))._id)
    const signer = new Elysia().use(jwt({ name: 'jwt', secret: pods.jwtSecret })) as any
    token = await signer.decorator.jwt.sign({
      id: '000000000000000000000001', orgId, role: 'admin', firstName: 'Ana', lastName: 'Till',
      permissions: [...PERMISSIONS], ownRecordsModules: [], operatorCode: '0001',
    })
    holder = pods.a
    spare = pods.b
    till = await openBridge(holder, 'till-tab-1')
    const opened = await api(spare, 'POST', '/trade/pos/session', { warehouseId, openingBalance: 0, currency: 'EUR' })
    expect(opened.status).toBe(200)
  }, 300_000)

  afterAll(async () => {
    for (const ws of sockets) try { ws.close() } catch { /* gone */ }
    await mongoose.disconnect().catch(() => undefined)
    await pods?.stop()
  }, 120_000)

  it('a roll: the stop finishes a print and the one waiting behind it, then lets go, and the next prints on the pod that took over', async () => {
    const started = await pods.startPod() // the roll starts its new pod first (`maxUnavailable: 0`)
    const [first, second] = [await issued(), await issued()]
    const before = closedOnDevice().length
    sim.latencyMs = 30

    // One asked of the other pod, one of the holder: both on the holder's queue.
    const hopped = api(spare, 'POST', `/invoices/${first}/payments`, toPay(), 'roll-hopped-0001')
    const opened = sim.executed.filter(c => c.cmd === 0x90).length
    await until('the first print to reach the device', () => sim.executed.filter(c => c.cmd === 0x90).length > opened || sim.frames > 0)
    const queued = api(holder, 'POST', `/invoices/${second}/payments`, toPay(), 'roll-queued-0001')
    await until('the second to wait its turn', async () => !!(await receiptOf(second)))

    await pods.drain(holder)
    const [a, b] = await Promise.all([hopped, queued])
    sim.latencyMs = 0

    expect([a.status, b.status]).toEqual([200, 200])
    expect(a.json.receipt.state).toBe('printed')
    expect(b.json.receipt.state).toBe('printed')
    expect(closedOnDevice().length).toBe(before + 2)
    expect((await raw(first)).status).toBe('paid')
    expect((await raw(second)).status).toBe('paid')
    // 1012: a till reconnects at once, and to a pod that takes connections.
    await till.closed
    expect(till.closeCode()).toBe(1012)

    holder = spare
    spare = started
    till = await openBridge(holder, 'till-tab-1')
    const after = await issued()
    expect((await api(spare, 'POST', `/invoices/${after}/payments`, toPay(), 'roll-after-00001')).status).toBe(200)
    expect(closedOnDevice().length).toBe(before + 3)
    expect(sim.receipts.filter(r => r.voided)).toHaveLength(0)
  }, 120_000)

  it('a request past the idle limit behind a slow report keeps its place, and its key finds what it did', async () => {
    const id = await issued()
    const before = closedOnDevice().length
    const report = gate()
    let reached = false
    sim.beforeCommand = (cmd) => {
      if (cmd !== REPORT) return undefined
      reached = true
      return report.closed
    }
    // Cut at 30 s too, and it goes on: the same limit, on the report itself.
    const reporting = api(holder, 'POST', `/fiscal/device/${deviceId}/x-report`).catch(() => null)
    await until('the report to reach the device', () => reached)

    // Asked of the other pod: on the holder it waits for the report, past the 30 s the server allows.
    const started = Date.now()
    const first = await api(spare, 'POST', `/invoices/${id}/payments`, toPay(), 'idle-limit-00001').catch(() => null)
    const waited = Date.now() - started
    expect(waited).toBeGreaterThan(25_000)
    // Not an answer about the money: refused as unreachable, or cut. Nothing is known, so the key stays.
    if (first) expect(first.status).toBe(503)
    expect(closedOnDevice().length).toBe(before)

    report.open()
    sim.beforeCommand = null
    await reporting
    await until('the waiting print to print', () => closedOnDevice().length === before + 1)

    const retry = await api(spare, 'POST', `/invoices/${id}/payments`, toPay(), 'idle-limit-00001')

    expect(retry.status).toBe(200)
    expect((await raw(id))).toMatchObject({ status: 'paid', amountPaid: 12 })
    expect(closedOnDevice().length).toBe(before + 1)
  }, 120_000)

  it('a takeover mid-queue costs the waiting request its print, and nothing prints twice', async () => {
    const [printing, waiting] = [await issued(), await issued()]
    const before = closedOnDevice().length
    const held = gate()
    sim.beforeCommand = cmd => (cmd === CLOSE ? held.closed : undefined)
    const paid = sim.executed.filter(c => c.cmd === PAYMENT).length

    const first = api(holder, 'POST', `/invoices/${printing}/payments`, toPay(), 'takeover-first-01')
    await until('the first print to reach its payment', () => sim.executed.filter(c => c.cmd === PAYMENT).length > paid)
    const second = api(holder, 'POST', `/invoices/${waiting}/payments`, toPay(), 'takeover-second1')
    await until('the second to wait its turn', async () => !!(await receiptOf(waiting)))

    // An admin on the other pod takes the device: the old holder drops its bridge within 5 s.
    const next = await openBridge(spare, 'till-tab-2', { takeover: true })
    await Promise.race([till.evicted, Bun.sleep(15_000)])
    held.open()
    sim.beforeCommand = null
    const [a, b] = await Promise.all([first, second])

    // The first closed on the device with its answer lost: unknown, and its money stands.
    expect(a.status).toBe(200)
    expect(a.json.receipt.state).toBe('unknown')
    expect((await raw(printing))).toMatchObject({ status: 'paid', amountPaid: 12 })
    // The second never reached the device: nothing is on it, nothing is booked, and it can be paid again.
    expect(b.status).toBe(503)
    expect(b.json.code).toBe('fiscal_error')
    expect((await raw(waiting))).toMatchObject({ status: 'sent', amountPaid: 0 })
    expect(closedOnDevice().length).toBe(before + 1)

    const moved = holder
    holder = spare
    spare = moved
    till = next
    const again = await api(spare, 'POST', `/invoices/${waiting}/payments`, toPay(), 'takeover-second2')
    expect(again.status).toBe(200)
    expect(closedOnDevice().length).toBe(before + 2)
  }, 120_000)

  it('a crash mid-print: the presence row lapses in 20 s, the lease in 120 s, and until it does the document reads as printing', async () => {
    const id = await issued()
    const before = closedOnDevice().length
    const held = gate()
    // The device took the money, and the close never reaches it.
    sim.beforeCommand = async (cmd) => {
      if (cmd !== CLOSE) return
      await held.closed
      throw new Error('the bridge is gone')
    }
    const paid = sim.executed.filter(c => c.cmd === PAYMENT).length
    const printing = api(holder, 'POST', `/invoices/${id}/payments`, toPay(), 'crash-print-0001').catch(() => null)
    await until('the print to reach its payment', () => sim.executed.filter(c => c.cmd === PAYMENT).length > paid)
    await until('its counter to be noted', async () => !!(await receiptOf(id))?.register?.fiscal?.attemptedAt)

    await holder.kill()
    await printing
    const down = holder
    held.open()
    sim.beforeCommand = null

    // Within the row's 20 s: held elsewhere, never offline, and no money moved.
    const early = await api(spare, 'POST', `/invoices/${id}/payments`, toPay(), 'crash-other-0001')
    expect(early.status).toBe(503)
    expect(early.json.code).toBe('fiscal_holder_unreachable')

    // The row lapses, and the till comes back on the pod that is up.
    await until('the row to lapse', async () => {
      const { json } = await api(spare, 'GET', '/fiscal/device')
      return !json.fiscalDevices.find((x: any) => String(x._id ?? x.id) === deviceId).connected
    }, 45_000)
    holder = spare
    till = await openBridge(holder, 'till-tab-3')

    // Past the row, inside the lease: the device is back, and the document still reads as printing.
    const inside = await api(holder, 'POST', `/invoices/${id}/payments`, toPay())
    expect(inside.status).toBe(409)
    expect(inside.json.code).toBe('payment_in_progress')
    expect((await raw(id))).toMatchObject({ status: 'sent', amountPaid: 0 })
    expect(closedOnDevice().length).toBe(before)

    // The lease lapses (120 s, here by hand). Nothing proves it: a receipt stands open on the device.
    const receipt: any = await receiptOf(id)
    await Invoice.updateOne({ _id: receipt._id }, { $set: { leaseUntil: new Date(Date.now() - 1000) } })
    const retry = await api(holder, 'POST', `/invoices/${id}/payments`, toPay(), 'crash-print-0001')

    expect(retry.status).toBe(409)
    expect(retry.json.code).toBe('receipt_in_doubt')
    expect((await raw(id))).toMatchObject({ status: 'sent', amountPaid: 0 })
    expect(closedOnDevice().length).toBe(before)

    // A person looks at the device: it took the money.
    const settled = await api(holder, 'POST', `/cash-register/documents/${receipt._id}/settle`, { printed: true })
    expect(settled.status).toBe(200)
    expect((await raw(id))).toMatchObject({ status: 'paid', amountPaid: 12 })
    void down
  }, 180_000)
})
