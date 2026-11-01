import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { Elysia } from 'elysia'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { tillApp, tillWorld, forgetDevices, type TillWorld } from '../helpers/till-world'
import {
  clerkSale, clerkSession, draftOf, gate, line, pay, raw, receiptsOf, send, sessionOf, shown, until,
} from '../helpers/receipt-world'
import { AuditLog, FiscalDevice, Invoice, POSSession } from 'db/models'
import { paymentReceiptDocument } from 'services/biz/cash-register/payment-receipt.service'
import { receiptBody } from 'services/biz/cash-register/receipt-lines'
import { applySessionTotals } from 'services/biz/cash-register/register.service'
import { requestHash } from 'services/biz/hot-path-key'
import { deviceFromCounter, deviceFromDeadReceipt } from 'fiscal/fiscal-route'
import { registerPrinter, unregisterPrinter } from 'fiscal/fiscal-device.service'
import { WsTremolFiscalPrinter } from 'fiscal/ws-tremol-printer'
import { TREMOL_CMD } from 'fiscal/tremol'
import { decodeCp1251 } from 'fiscal/cp1251'

/**
 * FR-23: what proves a receipt printed, and what happens when nothing does.
 *
 * In the device's turn the counter is ours, so a print that throws can be judged: `printed`, `failed`,
 * or `unknown` with the money kept. Out of it nothing moved by one proves anything, because the device
 * is shared: a receipt whose request died is given up only when it never reached the device or the
 * device confirms it idle and unmoved. Anything else books nothing and prints nothing: the receipt
 * stays held, and a person settles it.
 *
 * Every one of these was reproduced through the real routes on the simulator before it was fixed.
 *
 * NOTE: no `.rejects` / `.resolves` (Bun-on-Windows deadlock, see Known Issues).
 */

let app: Elysia
beforeAll(async () => {
  await setupTestDB()
  app = tillApp() as any
}, 60_000)
afterAll(async () => { await teardownTestDB() }, 60_000)
afterEach(async () => { forgetDevices(); await clearCollections() }, 30_000)

const CLOSE = 0x38
const PAYMENT = 0x35
const VOID = 0x3C
const LINE = 0x31

const onBank = async (w: TillWorld) => {
  const d = await draftOf(w, { method: 'bank_transfer' })
  await send(w, d.id)
  return d
}
const closedOnDevice = (w: TillWorld) => w.sim!.receipts.filter(r => !r.voided)
const settle = (w: TillWorld, id: string, printed: boolean, as?: string) =>
  w.call('POST', `/cash-register/documents/${id}/settle`, { printed }, undefined, as)

/** A receipt its request left at `fiscal`, its lease lapsed: the process died there. */
async function dead(w: TillWorld, d: { id: string; total: number }, fiscal: Record<string, unknown>, o: { key?: string; hash?: string; method?: string; deviceNumber?: string } = {}) {
  const invoice = await raw(d.id)
  const body = receiptBody({ doc: invoice, amount: d.total, whole: false, printsText: true, receipts: [] })!
  const document = paymentReceiptDocument({
    invoice, body, tender: { method: o.method ?? 'cash', amount: d.total, date: new Date() },
    session: { id: w.sessionId, warehouseId: String(w.warehouse._id) },
    user: { id: String(w.user._id), operatorCode: '0001' },
    printer: { deviceNumber: o.deviceNumber ?? 'ED123456' } as any,
  })
  const inserted: any = await Invoice.create({
    ...document, invoiceNumber: `CS-2026-${String(Math.floor(Math.random() * 90000) + 10000)}`, leaseUntil: new Date(Date.now() - 1000),
    ...(o.key ? { clientKey: o.key, requestHash: o.hash } : {}),
    register: { ...document.register, unp: 'ED123456-0001-0000099', fiscal: { state: 'pending', mode: 'fiscal', ...fiscal } },
  })
  await Invoice.updateOne({ _id: d.id }, { $push: { receiptHolds: { receiptId: inserted._id, amount: d.total } } })
  return inserted
}
const reread = (doc: any) => Invoice.findById(doc._id).lean().exec() as Promise<any>

describe('a print that throws, in its turn on the device (ruling 1)', () => {
  it('the paper runs out after the device took the money: unknown, the money kept, and no second receipt ever', async () => {
    const w = await tillWorld(app)
    const d = await onBank(w)
    w.sim!.beforeCommand = cmd => { if (cmd === CLOSE) w.sim!.paper = false }

    const r = await pay(w, d.id, 24, 'cash', 'paid-then-no-paper')

    expect(r.status).toBe(200)
    expect(r.json.receipt.state).toBe('unknown')
    expect(r.json.receiptError).toContain('Check the device')
    const [receipt] = await receiptsOf(d.id)
    expect(receipt.status).toBe('paid')
    expect(await raw(d.id)).toMatchObject({ status: 'paid', amountPaid: 24 })
    expect((await sessionOf(w)).totalCash).toBe(24)

    // The paper comes back. The same key finds what it did, and a new attempt finds it paid.
    w.sim!.beforeCommand = null
    w.sim!.paper = true
    expect((await pay(w, d.id, 24, 'cash', 'paid-then-no-paper')).status).toBe(200)
    expect((await pay(w, d.id, 24, 'cash', 'a-new-attempt-key')).status).toBe(400)

    // The next document finishes the one left open: one receipt for one payment.
    await w.sell(1)
    expect(closedOnDevice(w).filter(x => x.total === 24)).toHaveLength(1)
  })

  it('the close went through and the connection dropped before its answer: unknown, the money kept', async () => {
    const w = await tillWorld(app)
    const d = await onBank(w)
    w.sim!.dropAfter = CLOSE

    const r = await pay(w, d.id, 24)

    expect(r.status).toBe(200)
    expect(r.json.receipt.state).toBe('unknown')
    expect(await raw(d.id)).toMatchObject({ status: 'paid', amountPaid: 24 })
    expect(w.sim!.receipts).toHaveLength(1)
    expect((await receiptsOf(d.id))[0].status).toBe('paid')
  })

  it('the answer to the close was lost and the device still answers: the counter proves it, in its turn', async () => {
    const w = await tillWorld(app)
    const d = await onBank(w)
    const before = w.sim!.lastDocNumber
    w.sim!.beforeCommand = cmd => {
      if (cmd === CLOSE) w.sim!.loseNextAnswers = 99
      else w.sim!.loseNextAnswers = 0
    }

    const r = await pay(w, d.id, 24)

    expect(r.status).toBe(200)
    expect(r.json.receipt.state).toBe('printed')
    expect(r.json.receiptError).toBeUndefined()
    expect((await receiptsOf(d.id))[0].register.fiscalReceiptNumber).toBe(String(before + 1).padStart(7, '0'))
    expect(await raw(d.id)).toMatchObject({ status: 'paid', amountPaid: 24 })
  })

  it('a payment the device refused, and voided: nothing is on it, so the failure is proved and the money is not kept', async () => {
    const w = await tillWorld(app)
    const d = await onBank(w)
    w.sim!.beforeCommand = cmd => {
      if (cmd === PAYMENT) w.sim!.paper = false
      if (cmd === VOID) w.sim!.paper = true
    }

    const r = await pay(w, d.id, 24)

    expect(r.status).toBe(503)
    expect(r.json.code).toBe('fiscal_error')
    expect(await raw(d.id)).toMatchObject({ status: 'sent', amountPaid: 0 })
    expect((await receiptsOf(d.id))[0].status).toBe('voided')
    expect(closedOnDevice(w)).toHaveLength(0)
  })

  it('a line refused before any payment: voided, failed, the invoice as it was', async () => {
    const w = await tillWorld(app)
    const d = await onBank(w)
    w.sim!.beforeCommand = cmd => {
      if (cmd === LINE) w.sim!.paper = false
      if (cmd === VOID) w.sim!.paper = true
    }

    expect((await pay(w, d.id, 24)).status).toBe(503)
    expect(await raw(d.id)).toMatchObject({ status: 'sent', amountPaid: 0 })
  })

  it('a till sale is judged the same way: its money stood, and now its label does not lie', async () => {
    const w = await tillWorld(app)
    w.sim!.beforeCommand = cmd => { if (cmd === CLOSE) w.sim!.paper = false }

    const r = await w.sell(1)

    expect(r.status).toBe(200)
    const doc: any = await Invoice.findById(r.json.transaction.id).lean().exec()
    expect(doc.register.fiscal.state).toBe('unknown')
    expect((await sessionOf(w)).totalCash).toBe(12)
  })
})

describe('a driver with no cancel (ruling 1)', () => {
  /** A real `WsTremolFiscalPrinter` on a device that answers ACK, as the bridge carries it. */
  function tremolOn(w: TillWorld, fail: (cmd: number) => boolean = () => false) {
    const sent: { cmd: number; text: string }[] = []
    unregisterPrinter(w.deviceId)
    registerPrinter(w.deviceId, new WsTremolFiscalPrinter(async (frame: Buffer | Uint8Array) => {
      const f = Buffer.from(frame)
      const cmd = f[3]
      sent.push({ cmd, text: decodeCp1251(f.subarray(4, f.length - 3)) })
      if (fail(cmd)) throw new Error('Tremol NAK: command rejected')
      return Buffer.from([0x06])
    }, w.deviceId) as any)
    return sent
  }
  const onTremol = async (fail?: (cmd: number) => boolean) => {
    const w = await tillWorld(app, { manufacturer: 'tremol' })
    await FiscalDevice.updateOne({ _id: w.deviceId }, { $set: { manufacturer: 'tremol' } })
    return { w, sent: tremolOn(w, fail) }
  }

  it('a failure at the payment closes the receipt in the fallback: real, so unknown, and the money kept', async () => {
    const { w } = await onTremol(cmd => cmd === TREMOL_CMD.PAYMENT)
    const d = await onBank(w)

    const r = await pay(w, d.id, 24)

    expect(r.status).toBe(200)
    expect(r.json.receipt.state).toBe('unknown')
    expect(await raw(d.id)).toMatchObject({ status: 'paid', amountPaid: 24 })
    expect((await receiptsOf(d.id))[0].status).toBe('paid')
  })

  it('a failure at the payment, and the close refused too: it may have the money, so unknown, never failed', async () => {
    const { w } = await onTremol(cmd => cmd === TREMOL_CMD.PAYMENT || cmd === TREMOL_CMD.CLOSE_RECEIPT)
    const d = await onBank(w)

    const r = await pay(w, d.id, 24)

    expect(r.status).toBe(200)
    expect(r.json.receipt.state).toBe('unknown')
    expect(await raw(d.id)).toMatchObject({ status: 'paid', amountPaid: 24 })
  })

  it('a failure at a line, and the close refused too: nothing took money, so it failed', async () => {
    const { w } = await onTremol(cmd => cmd === TREMOL_CMD.SELL_ARTICLE || cmd === TREMOL_CMD.CLOSE_RECEIPT)
    const d = await onBank(w)

    expect((await pay(w, d.id, 24)).status).toBe(503)
    expect(await raw(d.id)).toMatchObject({ status: 'sent', amountPaid: 0 })
  })

  it('a failure at a line, and the fallback close went through: a receipt closed, so it is not failed', async () => {
    const { w } = await onTremol(cmd => cmd === TREMOL_CMD.SELL_ARTICLE)
    const d = await onBank(w)

    const r = await pay(w, d.id, 24)

    expect(r.status).toBe(200)
    expect(r.json.receipt.state).toBe('unknown')
    expect((await receiptsOf(d.id))[0].status).toBe('paid')
  })

  it('prints the number where a Tremol keeps it, and stores no "unknown" for a receipt number (finding 12)', async () => {
    const { w, sent } = await onTremol()
    const d = await onBank(w)
    await Invoice.updateOne({ _id: d.id }, { $set: { invoiceNumber: 'INV-2026-00123' } })

    expect((await pay(w, d.id, 10)).status).toBe(200)

    const lines = sent.filter(s => s.cmd === TREMOL_CMD.SELL_ARTICLE)
    expect(lines).toHaveLength(1)
    // Cut at 34 by the driver: the whole number has to fit before that.
    expect(lines[0].text.split(';')[0]).toContain('INV-2026-00123')
    const [receipt] = await receiptsOf(d.id)
    expect(receipt.register.fiscal.state).toBe('printed')
    expect(receipt.register.fiscalReceiptNumber).toBeUndefined()
    expect(receipt.register.fiscal.receiptNo).toBeUndefined()
    expect((await shown(w, d.id)).paymentReceipts[0].receiptNumber).toBeUndefined()
  })

  it('a debit note\'s number fits too, and a storno of a sale with no receipt number is still fiscal', async () => {
    const { w, sent } = await onTremol()
    const { id } = await (async () => {
      const inv = await draftOf(w)
      await send(w, inv.id)
      return inv
    })()
    const note = await draftOf(w, { type: 'debit_note', method: 'bank_transfer', extra: { relatedInvoiceId: id, contactId: String((await raw(id)).contactId) } })
    await send(w, note.id)
    await Invoice.updateOne({ _id: note.id }, { $set: { invoiceNumber: 'INV-2026-00124' } })

    expect((await pay(w, note.id, 5)).status).toBe(200)

    expect(sent.filter(s => s.cmd === TREMOL_CMD.SELL_ARTICLE).at(-1)!.text.split(';')[0]).toContain('INV-2026-00124')
    expect((await w.sell(1)).status).toBe(200)
    const sale: any = await Invoice.findOne({ type: 'cash_sale', orgId: w.oid }).lean().exec()
    const { printedFiscally } = await import('services/biz/cash-register/register.service')
    expect(printedFiscally(sale)).toBe(true)
  })
})

describe('the lease of a receipt that is printing (ruling 5)', () => {
  it('a payment that finds its lease lapsed mid-print waits for the device, and never gives a live print up', async () => {
    const w = await tillWorld(app)
    const d = await onBank(w)
    const held = gate()
    w.sim!.beforeCommand = cmd => (cmd === CLOSE ? held.closed : undefined)

    const paying = pay(w, d.id, 24)
    await until(async () => (await receiptsOf(d.id)).length === 1 && w.sim!.executed.some(c => c.cmd === PAYMENT), 'the print to reach its payment')
    await Invoice.updateOne({ type: 'payment_receipt' }, { $set: { leaseUntil: new Date(Date.now() - 1000) } })

    const bank = pay(w, d.id, 24, 'bank_transfer')
    await new Promise(r => setTimeout(r, 100))
    held.open()

    expect((await paying).status).toBe(200)
    expect((await bank).status).toBe(400)
    const inv = await raw(d.id)
    expect(inv).toMatchObject({ status: 'paid', amountPaid: 24 })
    expect(inv.payments.map((p: any) => p.method)).toEqual(['cash'])
    expect((await receiptsOf(d.id))[0].status).toBe('paid')
  })

  it('renews while it waits and prints', async () => {
    const { keepLease } = await import('services/biz/hot-path-key')
    const w = await tillWorld(app)
    const d = await onBank(w)
    const r = await dead(w, d, {})
    const stop = keepLease(Invoice, r._id, 10)
    await until(async () => new Date((await reread(r)).leaseUntil).getTime() > Date.now(), 'the lease to be renewed')
    stop()
  })

  it('a voided receipt takes no write and books no money, whoever comes back to it', async () => {
    const { setRegister } = await import('services/biz/cash-register/register.service')
    const w = await tillWorld(app)
    const d = await onBank(w)
    const r = await dead(w, d, {})
    await Invoice.updateOne({ _id: r._id }, { $set: { status: 'voided' } })

    await setRegister(r._id, { 'fiscal.state': 'printed' })

    expect((await reread(r)).register.fiscal.state).toBe('pending')
  })
})

describe('a receipt whose request died (ruling 6)', () => {
  it('a sale moved the counter by one since: that proves nothing, so nothing is booked and nothing prints', async () => {
    const w = await tillWorld(app)
    const d = await onBank(w)
    const r = await dead(w, d, { attemptedAt: new Date(), counterBefore: w.sim!.lastDocNumber })
    await w.sell(1)
    const printed = w.sim!.receipts.length

    const next = await pay(w, d.id, 24, 'bank_transfer')

    expect(next.status).toBe(409)
    expect(next.json.code).toBe('receipt_in_doubt')
    expect(next.json.receipt.number).toBe(r.invoiceNumber)
    const inv = await raw(d.id)
    expect(inv).toMatchObject({ status: 'sent', amountPaid: 0 })
    expect(inv.payments).toHaveLength(0)
    expect(inv.receiptHolds).toHaveLength(1)
    const after = await reread(r)
    expect(after.register.fiscal).toMatchObject({ state: 'unknown', inDoubt: true })
    expect(after.register.fiscalReceiptNumber).toBeUndefined()
    expect((await sessionOf(w)).totalCash).toBe(12)
    expect(w.sim!.receipts).toHaveLength(printed)
  })

  it('two documents since: the same', async () => {
    const w = await tillWorld(app)
    const d = await onBank(w)
    const r = await dead(w, d, { attemptedAt: new Date(), counterBefore: w.sim!.lastDocNumber })
    await w.sell(1)
    await w.sell(1)

    expect((await pay(w, d.id, 24, 'bank_transfer')).json.code).toBe('receipt_in_doubt')
    expect((await reread(r)).register.fiscal.inDoubt).toBe(true)
    expect((await raw(d.id)).amountPaid).toBe(0)
  })

  it('no device connected: it cannot be proved, so the same', async () => {
    const w = await tillWorld(app)
    const d = await onBank(w)
    const r = await dead(w, d, { attemptedAt: new Date(), counterBefore: w.sim!.lastDocNumber })
    forgetDevices()

    expect((await pay(w, d.id, 24, 'bank_transfer')).json.code).toBe('receipt_in_doubt')
    expect((await reread(r)).register.fiscal.inDoubt).toBe(true)
    expect((await raw(d.id)).amountPaid).toBe(0)
  })

  it('a device that does not answer the read: never printed, however much the next read says it did not', async () => {
    const w = await tillWorld(app)
    const d = await onBank(w)
    const r = await dead(w, d, { attemptedAt: new Date(), counterBefore: w.sim!.lastDocNumber })
    let reads = 0
    w.sim!.beforeCommand = cmd => {
      if (cmd === 0x71 && ++reads === 1) w.sim!.disconnected = true
    }

    await pay(w, d.id, 24, 'bank_transfer')

    w.sim!.disconnected = false
    expect(w.sim!.executed.some(c => c.cmd === 0x90)).toBe(false)
    expect((await reread(r)).register.fiscal.inDoubt).toBe(true)
  })

  it('the counter unmoved, but a receipt is open on the device: not idle, so it is not given up', async () => {
    const w = await tillWorld(app)
    const d = await onBank(w)
    const r = await dead(w, d, { attemptedAt: new Date(), counterBefore: w.sim!.lastDocNumber })
    const { getPrinter } = await import('fiscal/fiscal-device.service')
    await getPrinter(w.deviceId).openFiscalReceipt('0001', 'Иван Петров', 'ED123456-0001-0000098')

    expect((await pay(w, d.id, 24, 'bank_transfer')).json.code).toBe('receipt_in_doubt')
    expect((await reread(r)).status).toBe('paid')
    expect((await reread(r)).register.fiscal.inDoubt).toBe(true)
  })

  it('the counter unmoved and nothing open: proved, given up, and the payment goes through', async () => {
    const w = await tillWorld(app)
    const d = await onBank(w)
    const r = await dead(w, d, { attemptedAt: new Date(), counterBefore: w.sim!.lastDocNumber })

    const next = await pay(w, d.id, 24, 'bank_transfer')

    expect(next.status).toBe(200)
    expect((await reread(r)).status).toBe('voided')
    expect((await raw(d.id)).receiptHolds).toHaveLength(0)
    expect(w.sim!.receipts).toHaveLength(0)
  })

  it('it never reached the device: given up without asking it', async () => {
    const w = await tillWorld(app)
    const d = await onBank(w)
    const r = await dead(w, d, {})
    forgetDevices()

    expect((await pay(w, d.id, 24, 'bank_transfer')).status).toBe(200)
    expect((await reread(r)).status).toBe('voided')
  })

  it('a keyed retry of the same request does not book on a counter either', async () => {
    const w = await tillWorld(app)
    const d = await onBank(w)
    const key = 'dead-keyed-retry-1'
    const hash = requestHash(`invoice.payment:${d.id}`, { date: new Date().toISOString().slice(0, 10), amount: 24, method: 'cash' })
    const r = await dead(w, d, { attemptedAt: new Date(), counterBefore: w.sim!.lastDocNumber }, { key, hash })
    await w.sell(1)

    const retry = await pay(w, d.id, 24, 'cash', key)

    expect(retry.status).toBe(409)
    expect(retry.json.code).toBe('receipt_in_doubt')
    expect((await raw(d.id)).amountPaid).toBe(0)
    expect((await reread(r)).register.fiscal.inDoubt).toBe(true)
  })

  it('a keyed retry may print when the device proves it never did: the same customer, at the same counter', async () => {
    const w = await tillWorld(app)
    const d = await onBank(w)
    const key = 'dead-keyed-retry-2'
    const hash = requestHash(`invoice.payment:${d.id}`, { date: new Date().toISOString().slice(0, 10), amount: 24, method: 'cash' })
    await dead(w, d, { attemptedAt: new Date(), counterBefore: w.sim!.lastDocNumber }, { key, hash })

    expect((await pay(w, d.id, 24, 'cash', key)).status).toBe(200)
    expect(closedOnDevice(w)).toHaveLength(1)
    expect((await raw(d.id)).amountPaid).toBe(24)
  })

  it('a keyed retry on another device than it started on prints nothing (finding: receiptContext)', async () => {
    const w = await tillWorld(app)
    const d = await onBank(w)
    const key = 'dead-keyed-retry-3'
    const hash = requestHash(`invoice.payment:${d.id}`, { date: new Date().toISOString().slice(0, 10), amount: 24, method: 'cash' })
    const r = await dead(w, d, { attemptedAt: new Date(), counterBefore: w.sim!.lastDocNumber }, { key, hash, deviceNumber: 'ED654321' })

    const retry = await pay(w, d.id, 24, 'cash', key)

    expect(retry.json.code).toBe('receipt_in_doubt')
    expect(w.sim!.receipts).toHaveLength(0)
    expect((await reread(r)).register.fiscal.inDoubt).toBe(true)
  })

  it('a dead receipt on an errored, unconnected device does not lock the invoice: it is held, and a person settles it', async () => {
    const w = await tillWorld(app)
    const d = await onBank(w)
    const r = await dead(w, d, { attemptedAt: new Date(), counterBefore: w.sim!.lastDocNumber })
    forgetDevices()
    await FiscalDevice.updateOne({ _id: w.deviceId }, { $set: { status: 'error' } })

    expect((await pay(w, d.id, 24, 'bank_transfer')).json.code).toBe('receipt_in_doubt')
    expect((await w.call('POST', `/invoices/${d.id}/void`)).json.code).toBe('receipt_in_doubt')
    expect((await w.call('PUT', `/invoices/${d.id}`, { total: 36 })).json.code).toBe('receipt_in_doubt')

    expect((await settle(w, String(r._id), false)).status).toBe(200)
    expect((await pay(w, d.id, 24, 'bank_transfer')).status).toBe(200)
  })
})

describe('a person settles a receipt in doubt (ruling 6)', () => {
  async function inDoubt(w: TillWorld) {
    const d = await onBank(w)
    const r = await dead(w, d, { attemptedAt: new Date(), counterBefore: w.sim!.lastDocNumber })
    await w.sell(1)
    await pay(w, d.id, 24, 'bank_transfer')
    return { d, r }
  }

  it('it printed: the money is booked on the session, the payment recorded, and it says who said so', async () => {
    const w = await tillWorld(app)
    const { d, r } = await inDoubt(w)

    const answer = await settle(w, String(r._id), true)

    expect(answer.status).toBe(200)
    const after = await reread(r)
    expect(after.register.fiscal.state).toBe('printed')
    expect(after.register.fiscal.inDoubt).toBeFalsy()
    expect(after.register.settled).toMatchObject({ printed: true, by: w.user._id })
    expect(after.completedAt).toBeTruthy()
    const inv = await raw(d.id)
    expect(inv).toMatchObject({ status: 'paid', amountPaid: 24 })
    expect(inv.receiptHolds).toHaveLength(0)
    expect((await sessionOf(w)).totalCash).toBe(36)
    const audit: any = await AuditLog.findOne({ orgId: w.oid, action: 'settle_receipt' }).lean().exec()
    expect(audit).toBeTruthy()
    expect(String(audit.entityId)).toBe(String(r._id))
    expect(JSON.stringify(audit.changes)).toContain('printed')
  })

  it('it did not: voided with its number, nothing booked, the hold gone, and that too is on the record', async () => {
    const w = await tillWorld(app)
    const { d, r } = await inDoubt(w)

    expect((await settle(w, String(r._id), false)).status).toBe(200)

    const after = await reread(r)
    expect(after.status).toBe('voided')
    expect(after.register.settled).toMatchObject({ printed: false })
    expect(await raw(d.id)).toMatchObject({ status: 'sent', amountPaid: 0 })
    expect((await raw(d.id)).receiptHolds).toHaveLength(0)
    expect((await sessionOf(w)).totalCash).toBe(12)
    expect(await AuditLog.countDocuments({ orgId: w.oid, action: 'settle_receipt' })).toBe(1)
  })

  it('only a manager or an admin', async () => {
    const w = await tillWorld(app)
    const { r } = await inDoubt(w)
    const cashier = await w.tokenAs('member')

    const refused = await settle(w, String(r._id), true, cashier)

    expect(refused.status).toBe(403)
    expect((await reread(r)).register.fiscal.inDoubt).toBe(true)
  })

  it('settles once, and only what is in doubt', async () => {
    const w = await tillWorld(app)
    const { r } = await inDoubt(w)
    expect((await settle(w, String(r._id), true)).status).toBe(200)
    const again = await settle(w, String(r._id), false)
    expect(again.status).toBe(409)
    expect(again.json.code).toBe('receipt_not_in_doubt')
    expect((await reread(r)).status).toBe('paid')
  })

  it('a document that is not there, or of another kind, is a 404', async () => {
    const w = await tillWorld(app)
    const sale = await w.sell(1)
    expect((await settle(w, '64b000000000000000000000', true)).status).toBe(404)
    expect((await settle(w, sale.json.transaction.id, true)).status).toBe(404)
  })

  it('the document says it is in doubt, and the session\'s figures leave it out until it is settled', async () => {
    const w = await tillWorld(app)
    const { d, r } = await inDoubt(w)

    expect((await shown(w, d.id)).receiptInDoubt).toMatchObject({ id: String(r._id), number: r.invoiceNumber })
    const preview = (await w.call('GET', `/trade/pos/session/${w.sessionId}/close-preview`)).json
    expect(preview.report.counts.payments ?? 0).toBe(0)
    expect(preview.unfinishedReceipts.map((u: any) => u.number)).toEqual([r.invoiceNumber])
  })
})

describe('a session and its unfinished receipts (ruling 7)', () => {
  const close = (w: TillWorld, cash: number) => w.call('POST', `/trade/pos/session/${w.sessionId}/close`, { counted: { cash } })

  it('refuses to close over one that cannot be proved, and says which, with no Z printed', async () => {
    const w = await tillWorld(app)
    const d = await onBank(w)
    const r = await dead(w, d, { attemptedAt: new Date(), counterBefore: w.sim!.lastDocNumber })
    await w.sell(1)

    const refused = await close(w, 112)

    expect(refused.status).toBe(409)
    expect(refused.json.code).toBe('receipts_unfinished')
    expect(refused.json.receipts.map((x: any) => x.number)).toEqual([r.invoiceNumber])
    expect(refused.json.message).toContain(r.invoiceNumber)
    expect(w.sim!.reports).toHaveLength(0)
    expect((await sessionOf(w)).status).toBe('open')

    // Settled, the close goes through and the drawer agrees: nothing is posted as cash over.
    expect((await settle(w, String(r._id), true)).status).toBe(200)
    const closed = await close(w, 136)
    expect(closed.status).toBe(200)
    expect((await sessionOf(w))).toMatchObject({ status: 'closed', totalCash: 36, difference: 0 })
    expect(w.sim!.reports).toHaveLength(1)
  })

  it('finishes one it can prove, and closes', async () => {
    const w = await tillWorld(app)
    const d = await onBank(w)
    const r = await dead(w, d, { attemptedAt: new Date(), counterBefore: w.sim!.lastDocNumber })

    expect((await close(w, 100)).status).toBe(200)
    expect((await reread(r)).status).toBe('voided')
    expect((await raw(d.id)).receiptHolds).toHaveLength(0)
  })

  it('refuses over one still printing', async () => {
    const w = await tillWorld(app)
    const d = await onBank(w)
    const held = gate()
    w.sim!.beforeCommand = cmd => (cmd === CLOSE ? held.closed : undefined)
    const paying = pay(w, d.id, 24)
    await until(() => w.sim!.executed.some(c => c.cmd === PAYMENT), 'the print to reach its payment')

    const refused = await close(w, 100)

    expect(refused.status).toBe(409)
    expect(refused.json.code).toBe('receipts_unfinished')
    held.open()
    expect((await paying).status).toBe(200)
  })

  it('one that slips in under the claim: the close gives way, and no Z prints', async () => {
    const w = await tillWorld(app)
    const d = await onBank(w)
    const real = POSSession.findOneAndUpdate
    let slipped: any
    ;(POSSession as any).findOneAndUpdate = function (...args: unknown[]) {
      const query = (real as any).apply(POSSession, args)
      return {
        exec: async () => {
          const claimed = await query.exec()
          slipped = await dead(w, d, {})
          return claimed
        },
      }
    }
    let refused: any
    try {
      refused = await close(w, 100)
    } finally {
      ;(POSSession as any).findOneAndUpdate = real
    }

    expect(refused.status).toBe(409)
    expect(refused.json.code).toBe('receipts_unfinished')
    expect(refused.json.receipts.map((x: any) => x.id)).toEqual([String(slipped._id)])
    expect(w.sim!.reports).toHaveLength(0)
    expect((await sessionOf(w)).status).toBe('open')
  })

  it('one its request left printed: the close records it first, and the drawer agrees', async () => {
    const w = await tillWorld(app)
    const d = await onBank(w)
    const r = await dead(w, d, { attemptedAt: new Date(), counterBefore: w.sim!.lastDocNumber })
    await Invoice.updateOne({ _id: r._id }, { $set: { 'register.fiscal.state': 'printed' } })

    const closed = await close(w, 124)

    expect(closed.status).toBe(200)
    expect(await sessionOf(w)).toMatchObject({ status: 'closed', totalCash: 24, difference: 0 })
    expect(await raw(d.id)).toMatchObject({ status: 'paid', amountPaid: 24 })
  })

  it('a closing session takes no new receipt: it would land after the day was counted', async () => {
    const w = await tillWorld(app)
    const clerk = await clerkSession(w)
    const d = await onBank(w)
    // The clerk's receipt is queued behind a sale; the cashier's session stays open.
    const held = gate()
    w.sim!.beforeCommand = cmd => (cmd === LINE ? held.closed : undefined)
    const sale = w.sell(1)
    await until(() => w.sim!.executed.some(c => c.cmd === 0x90), 'the sale to open its receipt')
    const paying = pay(w, d.id, 24, 'cash', undefined, w.clerkToken)
    await until(async () => (await receiptsOf(d.id)).length === 1, 'the receipt to wait its turn')
    await POSSession.updateOne({ _id: clerk }, { $set: { status: 'closed' } })
    held.open()

    await sale
    const r = await paying
    expect(r.status).toBe(503)
    expect((await raw(d.id)).amountPaid).toBe(0)
    expect((await receiptsOf(d.id))[0].status).toBe('voided')
    expect(closedOnDevice(w).map(x => x.total)).toEqual([12])
  })

  it('never increments a closed session', async () => {
    const w = await tillWorld(app)
    const d = await onBank(w)
    const r = await dead(w, d, {})
    await POSSession.updateOne({ _id: w.sessionId }, { $set: { status: 'closed' } })

    await applySessionTotals(r, w.sessionId, { totalCash: 24, totalSales: 24, transactionCount: 1 })

    expect(await sessionOf(w)).toMatchObject({ totalCash: 0, transactionCount: 0 })
    expect((await reread(r)).register.sessionTotalsApplied).toBeFalsy()
  })
})

describe('which device a door follows (FR-24.50)', () => {
  it('a dead receipt\'s own device comes first: only it can say anything about that receipt', async () => {
    const w = await tillWorld(app)
    const clerk = await tillWorld(app)
    void clerk
    const d = await onBank(w)
    await dead(w, d, { attemptedAt: new Date(), counterBefore: 1 })
    const params = { orgId: w.orgId, id: d.id }
    const own = { orgId: w.orgId, deviceId: w.deviceId, deviceNumber: 'ED123456' }

    expect(await deviceFromCounter({ params, user: { id: String(w.clerk._id) }, body: {} })).toEqual(own)
    expect(await deviceFromDeadReceipt({ params, user: {}, body: {} })).toEqual(own)
  })

  it('one held for a person reaches no device, so it sends nobody anywhere', async () => {
    const w = await tillWorld(app)
    const d = await onBank(w)
    const r = await dead(w, d, { attemptedAt: new Date(), counterBefore: 1 })
    await Invoice.updateOne({ _id: r._id }, { $set: { 'register.fiscal.state': 'unknown', 'register.fiscal.inDoubt': true } })

    expect(await deviceFromDeadReceipt({ params: { orgId: w.orgId, id: d.id }, user: {}, body: {} })).toBeNull()
  })

  it('the proof of a dead receipt reads the device it was printing on, not the door\'s', async () => {
    const w = await tillWorld(app)
    const d = await onBank(w)
    const r = await dead(w, d, { attemptedAt: new Date(), counterBefore: w.sim!.lastDocNumber }, { deviceNumber: 'ED654321' })

    expect((await pay(w, d.id, 24, 'bank_transfer')).json.code).toBe('receipt_in_doubt')
    expect((await reread(r)).register.fiscal.inDoubt).toBe(true)
  })
})

void line
void clerkSale
