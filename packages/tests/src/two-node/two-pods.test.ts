import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { Elysia } from 'elysia'
import jwt from '@elysiajs/jwt'
import { PERMISSIONS } from 'config/constants'
import { mongoose } from 'db/connection'
import { Invoice } from 'db/models'
import { createTestContact, createTestOrg, createTestWarehouse, createTestFiscalDevice } from '../helpers/factories'
import { EltradeSimulator } from '../helpers/eltrade-simulator'
import { IslResponseCollector } from 'ui-shared/composables/fiscalIslResponse'
import { startTwoPods, type TwoPods } from './harness'

/**
 * FR-24.54: the two-pod till lane. Two processes of one global on one database (`replicas: 2`), a
 * simulated Eltrade bridged to pod A, and the till's requests sent to pod B. Each must print on the
 * device through A, exactly once; with A gone, B refuses with nothing done. Runs with `LGR_TWO_NODE=1`
 * (CI, beside two-node.test.ts).
 *
 * FR-23's doors are in it: an invoice issued, a payment and a delivery receipt, asked of pod B. With
 * pod A gone no receipt is skipped and no money is booked without one (FR-24.52): held elsewhere is
 * never offline, and once the row has lapsed and it is, the printer gate refuses instead.
 */

const enabled = process.env.LGR_TWO_NODE === '1'

describe.skipIf(!enabled)('two pods of one global, one till', () => {
  let pods: TwoPods
  let orgId = ''
  let deviceId = ''
  let warehouseId = ''
  let contactId = ''
  let token = ''
  /** What pod A's crash leaves to ask of pod B: a part-paid invoice, a delivery receipt owed, a cash draft. */
  let stillDue = ''
  let owedReceipt = ''
  let cashDraft = ''
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
    contactId = String((await createTestContact(org._id, { companyName: 'Клиент ООД', type: 'customer' } as any))._id)
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

  it('a part payment asked of pod B prints once, through pod A, and the rest stays due (FR-23)', async () => {
    const before = sim.receipts.length
    const id = await invoiceOnPodB('bank_transfer')
    expect((await api('b', 'POST', `/invoices/${id}/send`, {})).status).toBe(200)
    expect(sim.receipts.length).toBe(before)

    const res = await api('b', 'POST', `/invoices/${id}/payments`, { date: new Date().toISOString().slice(0, 10), amount: 4, method: 'cash' })

    expect(res.status).toBe(200)
    expect(res.json.invoice).toMatchObject({ status: 'partially_paid', amountPaid: 4 })
    expect(sim.receipts.length).toBe(before + 1)
    expect(sim.receipts.at(-1)!.total).toBe(4)
    stillDue = id
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

  it('pod A crashed: pod B refuses with nothing done, never prints elsewhere or skips the receipt (FR-24.51/24.52)', async () => {
    const before = sim.reports.length
    // A crash, not a graceful stop: a graceful stop releases the presence row (Phase 5), and pod B then
    // rightly answers `not_connected`. Killed, the row still names pod A, whose address answers nothing.
    await pods.a.kill()
    const res = await api('b', 'POST', `/fiscal/device/${deviceId}/x-report`)
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
      const { json } = await api('b', 'GET', '/fiscal/device')
      if (!json.fiscalDevices.find((x: any) => String(x._id ?? x.id) === deviceId).connected) break
      expect(Date.now()).toBeLessThan(deadline)
      await new Promise(r => setTimeout(r, 1000))
    }

    const books = await theBooks()
    for (const answer of await theDoors()) {
      expect(answer.status).toBe(409)
      expect(answer.json.code).toBe('fiscal_device_not_connected')
    }
    expect(await theBooks()).toEqual(books)
  }, 70_000)

  /** Issue a cash draft, pay part of an invoice, print a delivery receipt: all of it asked of pod B. */
  const theDoors = async () => [
    await api('b', 'POST', `/invoices/${cashDraft}/send`, {}),
    await api('b', 'POST', `/invoices/${stillDue}/payments`, { date: new Date().toISOString().slice(0, 10), amount: 8, method: 'cash' }),
    await api('b', 'POST', `/invoices/${owedReceipt}/receipt`, {}),
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
})
