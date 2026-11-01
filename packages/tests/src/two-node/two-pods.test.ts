import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { Elysia } from 'elysia'
import jwt from '@elysiajs/jwt'
import { PERMISSIONS } from 'config/constants'
import { createHmac } from 'node:crypto'
import { mongoose } from 'db/connection'
import { Desktop, Invoice } from 'db/models'
import { DESKTOP_TOKEN_AUDIENCE } from 'services/biz/desktop/desktop.service'
import { createTestContact, createTestOrg, createTestWarehouse, createTestFiscalDevice, createTestProduct, createTestStockLevel } from '../helpers/factories'
import { EltradeSimulator } from '../helpers/eltrade-simulator'
import { IslResponseCollector } from 'ui-shared/composables/fiscalIslResponse'
import { startTwoPods, type TwoPods } from './harness'

/**
 * FR-24.54: the two-pod till lane. Two processes of one global on one database (`replicas: 2`), a
 * simulated Eltrade bridged to pod A, and the till's requests sent to pod B: device report, status,
 * session open, sale, storno, close with its Z-report. Each must reach the device through the pod
 * holding it, exactly once. Then an admin on pod B takes the device over (FR-24.48), and the holder
 * crashes: the other pod refuses with nothing done. Runs with `LGR_TWO_NODE=1` (CI, beside
 * two-node.test.ts).
 *
 * FR-23's doors are in it: an invoice issued, a payment and a delivery receipt, asked of pod B. With
 * the holder gone no receipt is skipped and no money is booked without one (FR-24.52): held
 * elsewhere is never offline, and once the row has lapsed and it is, the printer gate refuses.
 */

const enabled = process.env.LGR_TWO_NODE === '1'

type Pod = 'a' | 'b'

interface Bridge {
  ws: WebSocket
  /** Resolves with the eviction message, if the server ever sends one. */
  evicted: Promise<string>
  /** Resolves once the socket is closed, by either side. */
  closed: Promise<void>
}

describe.skipIf(!enabled)('two pods of one global, one till', () => {
  let pods: TwoPods
  let orgId = ''
  let deviceId = ''
  let warehouseId = ''
  let productId = ''
  let sessionId = ''
  let saleId = ''
  let contactId = ''
  /** What the holder's crash leaves to ask of the other pod: part paid, a delivery receipt owed, a cash draft. */
  let stillDue = ''
  let owedReceipt = ''
  let cashDraft = ''
  let token = ''
  const sim = new EltradeSimulator()
  const bridges: WebSocket[] = []
  /** Which pod holds the device's bridge right now. */
  let holder: Pod = 'a'
  const other = (p: Pod): Pod => (p === 'a' ? 'b' : 'a')

  const api = (pod: Pod, method: string, path: string, body?: unknown, key?: string) =>
    fetch(`${pods[pod].url}/api/org/${orgId}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(key ? { 'idempotency-key': key } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    }).then(async r => ({ status: r.status, json: (await r.json().catch(() => null)) as any }))

  /**
   * A till bridged to `pod`: it relays each command to the simulated device. A browser tab by
   * default; with `credential`, a desktop's (FR-14.26), which registers on its signature.
   */
  async function openBridge(pod: Pod, instanceId: string, opts: { takeover?: boolean; credential?: string; device?: EltradeSimulator } = {}): Promise<Bridge> {
    const { takeover = false, credential = token, device = sim } = opts
    const ws = new WebSocket(`${pods[pod].url.replace('http', 'ws')}/ws/fiscal-bridge`)
    bridges.push(ws)
    let onEvicted: (m: string) => void = () => undefined
    const evicted = new Promise<string>(resolve => { onEvicted = resolve })
    const closed = new Promise<void>(resolve => ws.addEventListener('close', () => resolve()))
    const registered = new Promise<void>((resolve, reject) => {
      ws.onmessage = async (event) => {
        const msg = JSON.parse(String(event.data))
        if (msg.type === 'fiscal:bridge:registered') resolve()
        if (msg.type === 'fiscal:bridge:error') reject(new Error(msg.message))
        if (msg.type === 'fiscal:bridge:evicted') onEvicted(String(msg.message ?? ''))
        if (msg.type !== 'fiscal:command') return
        const frame = Buffer.from(msg.frame, 'base64')
        const collector = new IslResponseCollector(frame[2])
        collector.push(new Uint8Array(await device.exchange(frame)))
        ws.send(JSON.stringify({ type: 'fiscal:response', commandId: msg.commandId, frame: Buffer.from(collector.bytes()).toString('base64') }))
      }
    })
    await new Promise<void>((resolve, reject) => { ws.onopen = () => resolve(); ws.onerror = () => reject(new Error('bridge socket failed')) })
    ws.send(JSON.stringify({ type: 'fiscal:bridge:register', deviceNumber: device.serial, orgId, token: credential, instanceId, ...(takeover ? { takeover: true } : {}) }))
    await registered
    return { ws, evicted, closed }
  }

  /** A desktop's credential, signed as `services/biz/desktop` signs it, with the pods' shared secret. */
  function desktopCredential(desktopId: string): string {
    const iat = Math.floor(Date.now() / 1000)
    const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')
    const payload = Buffer.from(JSON.stringify({ desktopId, orgId, keyEpoch: 1, aud: DESKTOP_TOKEN_AUDIENCE, iat, exp: iat + 600 })).toString('base64url')
    const sig = createHmac('sha256', pods.desktopTokenSecret).update(`${header}.${payload}`).digest('base64url')
    return `${header}.${payload}.${sig}`
  }

  /** `quantity` × 10.00 net at 20 %, paid in cash. */
  const saleBody = (quantity: number) => ({
    type: 'sale',
    lines: [{ productId, name: 'Болт DIN 933 М8Х25', quantity, unitPrice: 10, discount: 0, taxRate: 20, taxAmount: 2 * quantity, lineTotal: 10 * quantity }],
    subtotal: 10 * quantity, discountTotal: 0, taxTotal: 2 * quantity, total: 12 * quantity,
    payments: [{ method: 'cash', amount: 12 * quantity }],
    changeDue: 0,
    nonFiscal: false,
  })

  let tillA: Bridge

  beforeAll(async () => {
    pods = await startTwoPods()
    await mongoose.connect(pods.mongoUri)
    const org = await createTestOrg()
    const wh = await createTestWarehouse(org._id)
    const device = await createTestFiscalDevice(org._id, wh._id, {
      name: 'Каса 1', deviceNumber: sim.serial, manufacturer: 'eltrade', connectionType: 'browser', status: 'offline',
    } as any)
    const product = await createTestProduct(org._id, { name: 'Болт DIN 933 М8Х25', sellingPrice: 10, purchasePrice: 4, taxRate: 20, unit: 'бр.' } as any)
    await createTestStockLevel(org._id, product._id, wh._id, { quantity: 50, availableQuantity: 50, avgCost: 4 } as any)
    orgId = String(org._id)
    deviceId = String(device._id)
    warehouseId = String(wh._id)
    productId = String(product._id)
    contactId = String((await createTestContact(org._id, { companyName: 'Клиент ООД', type: 'customer' } as any))._id)
    const signer = new Elysia().use(jwt({ name: 'jwt', secret: pods.jwtSecret })) as any
    token = await signer.decorator.jwt.sign({
      id: '000000000000000000000001', orgId, role: 'admin', firstName: 'Ana', lastName: 'Till',
      permissions: [...PERMISSIONS], ownRecordsModules: [], operatorCode: '0001',
    })

    tillA = await openBridge('a', 'till-tab-1')
  }, 300_000)

  afterAll(async () => {
    for (const ws of bridges) try { ws.close() } catch { /* gone */ }
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
    sessionId = String(res.json.session.id ?? res.json.session._id)
    const again = await api('b', 'POST', '/trade/pos/session', { warehouseId, openingBalance: 0, currency: 'EUR' })
    expect(again.status).toBe(400) // "You already have an open session": the same database answered
  })

  it('a sale rung on pod B prints one fiscal receipt on the device pod A holds, and its retry none', async () => {
    const before = sim.receipts.length
    const res = await api('b', 'POST', `/trade/pos/session/${sessionId}/transaction`, saleBody(2), 'two-pods-sale-0001')
    expect(res.status).toBe(200)
    expect(res.json.receiptError).toBeFalsy()
    saleId = String(res.json.transaction?.id ?? res.json.transaction?._id)
    expect(sim.receipts.length).toBe(before + 1)
    expect(sim.receipts.at(-1)?.voided).toBeFalsy()

    // The client retrying under the same key (FR-24.51): the first outcome, nothing printed again.
    const again = await api('b', 'POST', `/trade/pos/session/${sessionId}/transaction`, saleBody(2), 'two-pods-sale-0001')
    expect(again.status).toBe(200)
    expect(String(again.json.transaction?.id ?? again.json.transaction?._id)).toBe(saleId)
    expect(sim.receipts.length).toBe(before + 1)
  })

  it('a storno asked of pod B prints one storno receipt through pod A', async () => {
    const before = sim.receipts.length
    const res = await api('b', 'POST', `/trade/pos/session/${sessionId}/storno`, { originalTransactionId: saleId, reason: 'customer_return' }, 'two-pods-storno-01')
    expect(res.status).toBe(200)
    expect(res.json.receiptError).toBeFalsy()
    expect(sim.receipts.length).toBe(before + 1)
  })

  it('a cash invoice issued on pod B prints once, on the device pod A holds, and is paid (FR-23)', async () => {
    const before = sim.receipts.length
    const id = await invoiceOnPodB('cash')

    const res = await api('b', 'POST', `/invoices/${id}/send`, {})

    expect(res.status).toBe(200)
    expect(res.json.receipt.state).toBe('printed')
    expect(res.json.invoice).toMatchObject({ status: 'paid', amountPaid: 12 })
    expect(sim.receipts.length).toBe(before + 1)
    expect(sim.receipts.at(-1)).toMatchObject({ total: 12, texts: [`Фактура № ${res.json.invoice.invoiceNumber}`] })
  })

  it('a part payment asked of pod B prints once, through pod A, and its retry none (FR-23)', async () => {
    const before = sim.receipts.length
    const id = await invoiceOnPodB('bank_transfer')
    expect((await api('b', 'POST', `/invoices/${id}/send`, {})).status).toBe(200)
    expect(sim.receipts.length).toBe(before)
    const payment = { date: new Date().toISOString().slice(0, 10), amount: 4, method: 'cash' }

    const res = await api('b', 'POST', `/invoices/${id}/payments`, payment, 'two-pods-payment-01')

    expect(res.status).toBe(200)
    expect(res.json.invoice).toMatchObject({ status: 'partially_paid', amountPaid: 4 })
    expect(sim.receipts.length).toBe(before + 1)
    expect(sim.receipts.at(-1)!.total).toBe(4)

    // The client retrying under the same key (FR-24.51): the first outcome, nothing printed again.
    const again = await api('b', 'POST', `/invoices/${id}/payments`, payment, 'two-pods-payment-01')
    expect(again.status).toBe(200)
    expect(again.json.invoice).toMatchObject({ status: 'partially_paid', amountPaid: 4 })
    expect(sim.receipts.length).toBe(before + 1)
    stillDue = id
  })

  it('a sale and a payment at once, asked of either pod, take turns on the device pod A holds (FR-23)', async () => {
    const id = await invoiceOnPodB('bank_transfer')
    expect((await api('b', 'POST', `/invoices/${id}/send`, {})).status).toBe(200)
    const before = sim.receipts.length
    sim.latencyMs = 15
    try {
      const [sale, payment] = await Promise.all([
        api('b', 'POST', `/trade/pos/session/${sessionId}/transaction`, saleBody(1)),
        api('a', 'POST', `/invoices/${id}/payments`, { date: new Date().toISOString().slice(0, 10), amount: 12, method: 'cash' }),
      ])
      expect(sale.status).toBe(200)
      expect(sale.json.receiptError).toBeFalsy()
      expect(payment.status).toBe(200)
      expect(payment.json.invoice).toMatchObject({ status: 'paid', amountPaid: 12 })
    } finally {
      sim.latencyMs = 0
    }
    expect(sim.receipts.slice(before).map(r => [r.total, !!r.voided])).toEqual([[12, false], [12, false]])
  })

  it('a cash-on-delivery print that failed prints on its own, asked of pod B, and books no money (FR-23)', async () => {
    const failsAtIssue = async () => {
      const id = await invoiceOnPodB('cash_on_delivery')
      sim.paper = false
      const res = await api('b', 'POST', `/invoices/${id}/send`, {})
      sim.paper = true
      expect(res.status).toBe(200)
      expect(res.json.receipt.state).toBe('failed')
      return id
    }
    owedReceipt = await failsAtIssue()
    const id = await failsAtIssue()
    const before = sim.receipts.length

    const res = await api('b', 'POST', `/invoices/${id}/receipt`, {})

    expect(res.status).toBe(200)
    expect(res.json.receipt.state).toBe('printed')
    expect(res.json.invoice).toMatchObject({ status: 'sent', amountPaid: 0, amountDue: 12 })
    expect(sim.receipts.length).toBe(before + 1)
    expect(sim.receipts.at(-1)!.payments).toEqual([{ mode: 'R', amount: 12 }])
    cashDraft = await invoiceOnPodB('cash')
  })

  it('closing the session on pod B prints its Z-report once, on the device pod A holds', async () => {
    const before = sim.reports.length
    const res = await api('b', 'POST', `/trade/pos/session/${sessionId}/close`, { counted: { cash: 0 } }, 'two-pods-close-001')
    expect(res.status).toBe(200)
    expect(sim.reports.length).toBe(before + 1)
  })

  it('an admin on pod B takes the device over: the till on pod A is told, and requests follow the device (FR-24.48)', async () => {
    const tillB = await openBridge('b', 'till-tab-2', { takeover: true })
    holder = 'b'
    const message = await Promise.race([tillA.evicted, Bun.sleep(15_000).then(() => 'not evicted within 15 s')])
    expect(message).not.toBe('not evicted within 15 s')

    // Pod A no longer holds it: its own request now goes to pod B, and prints once.
    const before = sim.reports.length
    const res = await api('a', 'POST', `/fiscal/device/${deviceId}/x-report`)
    expect(res.status).toBe(200)
    expect(sim.reports.length).toBe(before + 1)
    const list = await api('a', 'GET', '/fiscal/device')
    expect(list.json.fiscalDevices.find((x: any) => String(x._id ?? x.id) === deviceId).connected).toBe(true)
    void tillB
  }, 60_000)

  it('a desktop revoked on pod A loses its bridge on pod B, without the till cooperating (FR-24.48, FR-14.26)', async () => {
    const till2 = new EltradeSimulator()
    till2.serial = 'ED654321'
    const device = await createTestFiscalDevice(orgId, warehouseId, {
      name: 'Каса 2', deviceNumber: till2.serial, manufacturer: 'eltrade', connectionType: 'desktop', status: 'offline',
    } as any)
    const desktop = await Desktop.create({
      orgId, name: 'Till 2', machineId: 'm-2', installationId: `inst-${Math.random()}`,
      publicKey: 'x'.repeat(60), keyEpoch: 1, status: 'active', fiscalDeviceIds: [device._id],
    })
    const desktopBridge = await openBridge('b', 'desktop-till-2', { credential: desktopCredential(String(desktop._id)), device: till2 })

    // Held on pod B, asked of pod A: it prints through pod B.
    const before = till2.reports.length
    const res = await api('a', 'POST', `/fiscal/device/${device._id}/x-report`)
    expect(res.status).toBe(200)
    expect(till2.reports.length).toBe(before + 1)

    // Revoked on pod A. Pod B's heartbeat acts on the row within 5 s and drops the socket itself.
    const revoked = await api('a', 'POST', `/desktops/${desktop._id}/revoke`, { reason: 'two-pod lane' })
    expect(revoked.status).toBe(200)
    const outcome = await Promise.race([desktopBridge.closed.then(() => 'closed'), Bun.sleep(15_000).then(() => 'still open after 15 s')])
    expect(outcome).toBe('closed')

    // Nothing holds it any more, on either pod: refused, nothing printed.
    const after = till2.reports.length
    const refused = await api('a', 'POST', `/fiscal/device/${device._id}/x-report`)
    expect(refused.status).toBe(503)
    expect(till2.reports.length).toBe(after)
  }, 60_000)

  it('the holder crashes: the other pod refuses with nothing done, never prints elsewhere or skips the receipt (FR-24.51/24.52)', async () => {
    const before = sim.reports.length
    // A session stands open: FR-23's doors follow it to the printer.
    expect((await api(other(holder), 'POST', '/trade/pos/session', { warehouseId, openingBalance: 0, currency: 'EUR' })).status).toBe(200)
    // A crash, not a graceful stop: a graceful stop releases the presence row (Phase 5), and the
    // other pod then rightly answers `not_connected`. Killed, the row still names the holder, whose
    // address answers nothing.
    await pods[holder].kill()
    const res = await api(other(holder), 'POST', `/fiscal/device/${deviceId}/x-report`)
    expect(res.status).toBe(503)
    expect(res.json.code).toBe('fiscal_holder_unreachable')
    expect(sim.reports.length).toBe(before)

    // FR-23's doors likewise: no receipt prints somewhere else or not at all, and no money is booked.
    const books = await theBooks()
    for (const answer of await theDoors()) {
      expect(answer.status).toBe(503)
      expect(answer.json.code).toBe('fiscal_holder_unreachable')
    }
    expect(await theBooks()).toEqual(books)
  }, 60_000)

  it('its row lapsed: "offline" at last, and the printer gate still refuses, so no money is booked without a receipt (FR-24.52)', async () => {
    // A crashed pod's row is dead after 20 s. Only now may a device read as offline at all.
    const deadline = Date.now() + 45_000
    for (;;) {
      const { json } = await api(other(holder), 'GET', '/fiscal/device')
      if (!json.fiscalDevices.find((x: any) => String(x._id ?? x.id) === deviceId).connected) break
      expect(Date.now()).toBeLessThan(deadline)
      await Bun.sleep(1000)
    }

    const books = await theBooks()
    for (const answer of await theDoors()) {
      expect(answer.status).toBe(409)
      expect(answer.json.code).toBe('fiscal_device_not_connected')
    }
    expect(await theBooks()).toEqual(books)
  }, 70_000)

  /** A draft of one free line, 12 gross at 20 %, as the form saves it: it moves no stock. */
  async function invoiceOnPodB(paymentMethod: string) {
    const res = await api('b', 'POST', '/invoices', {
      type: 'invoice', direction: 'outgoing', contactId, issueDate: new Date().toISOString().slice(0, 10), currency: 'EUR', paymentMethod,
      lines: [{ description: 'Услуга', quantity: 1, unit: 'бр.', unitPrice: 10, taxRate: 20, taxAmount: 2, lineTotal: 12 }],
      subtotal: 10, taxTotal: 2, total: 12,
    })
    expect(res.status).toBe(200)
    return String(res.json.invoice.id)
  }

  /** Issue a cash draft, pay part of an invoice, print a delivery receipt: all of it on the pod still up. */
  const theDoors = async () => [
    await api(other(holder), 'POST', `/invoices/${cashDraft}/send`, {}),
    await api(other(holder), 'POST', `/invoices/${stillDue}/payments`, { date: new Date().toISOString().slice(0, 10), amount: 8, method: 'cash' }),
    await api(other(holder), 'POST', `/invoices/${owedReceipt}/receipt`, {}),
  ]

  /** What a refused door must leave as it was: the documents, their money, and the device's paper. */
  async function theBooks() {
    const money = async (id: string) => {
      const d: any = await Invoice.findById(id).lean().exec()
      return { status: d.status, number: d.invoiceNumber, paid: d.amountPaid, due: d.amountDue, payments: d.payments.length, holds: (d.receiptHolds ?? []).length }
    }
    return {
      printed: sim.receipts.length,
      documents: await Invoice.countDocuments({ orgId }),
      draft: await money(cashDraft),
      partPaid: await money(stillDue),
      owed: await money(owedReceipt),
    }
  }
})
