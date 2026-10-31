import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import type { Elysia } from 'elysia'
import ExcelJS from 'exceljs'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { tillApp, tillWorld, forgetDevices, type TillWorld } from '../helpers/till-world'
import { createTestAccount } from '../helpers/factories'
import { FiscalDevice, Invoice, Journal, JournalEntry, POSSession, Sequence } from 'db/models'
import { createPOSSessionJournalEntry } from 'services/biz/auto-journal.service'
import { loadPosRows } from 'services/biz/cash-register/pos-union'
import { buildSessionReport, formatSessionReport } from 'services/biz/cash-register/session-report'
import { formatNonFiscalLines } from 'invoicing-api/src/lib/cash-register-till'
import { generateTable182 } from 'reporting/excel/supto.excel'

/**
 * Cash on delivery at the till (owner, 2026-10-31): a FISCAL receipt, paid in the Eltrade's reserve
 * slot R, which the device page names „НАЛОЖЕН ПЛАТЕЖ".
 *
 * The courier collects it, so it is never in the drawer: its own bucket on the session, expected at
 * the close and never counted, out of expected cash, on its own line in the session report, and
 * "POS Other" on the receivable account in the session's journal entry. A device with no slot for
 * it refuses the sale before anything is written, where the driver used to refuse the payment with
 * the receipt already open.
 *
 * NOTE: no `.rejects` / `.resolves` (Bun-on-Windows deadlock, see Known Issues).
 */

let app: Elysia
beforeAll(async () => { await setupTestDB(); app = tillApp() }, 60_000)
afterAll(async () => { await teardownTestDB() }, 60_000)
afterEach(async () => { forgetDevices(); await clearCollections() })

const COD = { method: 'cash_on_delivery' }

const sessionOf = (w: TillWorld) => POSSession.findById(w.sessionId).lean().exec() as Promise<any>
const preview = (w: TillWorld) => w.call('GET', `/trade/pos/session/${w.sessionId}/close-preview`)

/** Everything a refused request must leave as it was. */
async function footprint(w: TillWorld) {
  const session = await sessionOf(w)
  return {
    documents: await Invoice.countDocuments({ orgId: w.oid }),
    counters: (await Sequence.find({ orgId: w.oid }).lean().exec() as any[]).map(s => `${s.prefix}:${s.year}:${s.lastNumber}`).sort(),
    totals: [session.totalSales, session.totalCash, session.totalCard, session.totalOther, session.totalCashOnDelivery, session.transactionCount],
    device: w.sim!.executed.length,
    frames: w.sim!.frames,
  }
}

describe('a sale at the till', () => {
  it('prints a fiscal receipt paid in slot R, with no change', async () => {
    const w = await tillWorld(app)
    const r = await w.sell(2, COD)

    expect(r.status).toBe(200)
    expect(r.json.receiptError).toBeUndefined()
    expect(w.sim!.receipts).toHaveLength(1)
    expect(w.sim!.receipts[0]).toMatchObject({ kind: 'fiscal', total: 24, paid: 24, payments: [{ mode: 'R', amount: 24 }] })

    const doc: any = await Invoice.findById(r.json.transaction.id).lean().exec()
    expect(doc.paymentMethod).toBe('cash_on_delivery')
    expect(doc.payments).toHaveLength(1)
    expect(doc.payments[0]).toMatchObject({ method: 'cash_on_delivery', amount: 24 })
    expect(doc.register).toMatchObject({ isFiscal: true, changeDue: 0, fiscal: { state: 'printed', mode: 'fiscal' } })
    expect(doc.register.unp).toMatch(/^ED123456-0001-/)
  })

  it('on a text receipt, under its own name', async () => {
    const w = await tillWorld(app)
    const r = await w.sell(1, { ...COD, nonFiscal: true })
    expect(r.status).toBe(200)
    expect(w.sim!.receipts).toHaveLength(0)
    expect(w.sim!.nonFiscalLines.join('\n')).toContain('ON DELIVERY:')
  })

  it('names it in every language a text receipt prints', () => {
    const body = { lines: [], subtotal: 10, taxTotal: 2, total: 12, payments: [{ method: 'cash_on_delivery', amount: 12 }], changeDue: 0 }
    const line = (locale: string) => formatNonFiscalLines(body, 'CS-1', 'Op', locale, 'EUR').find(l => l.endsWith('12.00 EUR') && !/TOTAL|ОБЩО|GESAMT|ВКУПНО/.test(l))
    expect(line('en')).toContain('ON DELIVERY:')
    expect(line('bg')).toContain('НАЛОЖЕН ПЛАТЕЖ:')
    expect(line('de')).toContain('NACHNAHME:')
    expect(line('mk')).toContain('ПРИ ДОСТАВА:')
    for (const locale of ['en', 'bg', 'de', 'mk']) expect(line(locale)!.length).toBeLessThanOrEqual(28)
  })

  it('with no device (an org that turned the rule off) it is recorded the same: nothing could print it as anything else', async () => {
    const w = await tillWorld(app, { device: false })
    const r = await w.sell(1, COD)
    expect(r.status).toBe(200)
    expect((await sessionOf(w)).totalCashOnDelivery).toBe(12)
  })
})

describe('a tender is exactly the total', () => {
  const body = (w: TillWorld, payments: any[]) => w.call('POST', `/trade/pos/session/${w.sessionId}/transaction`, { ...w.saleBody(2), payments })

  it('short of it, over it, or beside another payment: refused, with nothing written', async () => {
    const w = await tillWorld(app)
    const before = await footprint(w)
    for (const payments of [
      [{ ...COD, amount: 23.99 }], // would book a cent as cash taken
      [{ ...COD, amount: 30 }], // would give change out of a drawer that took nothing
      [{ ...COD, amount: 14 }, { method: 'cash', amount: 10 }], // the device would be paid in two slots
    ]) {
      const r = await body(w, payments)
      expect({ status: r.status, code: r.json.code }).toEqual({ status: 422, code: 'cod_amount_mismatch' })
    }
    expect(await footprint(w)).toEqual(before)
  })

  it('a card sale tendered within the till\'s tolerance is not this rule\'s business', async () => {
    const w = await tillWorld(app)
    expect((await body(w, [{ method: 'card', amount: 23.99 }])).status).toBe(200)
  })
})

describe('the session', () => {
  it('keeps it in its own bucket: not in the drawer, not in "other", and out of expected cash', async () => {
    const w = await tillWorld(app)
    await w.sell(2, COD)

    const s = await sessionOf(w)
    expect(s).toMatchObject({ totalCashOnDelivery: 24, totalCash: 0, totalCard: 0, totalOther: 0, totalSales: 24, transactionCount: 1 })
    const p = await preview(w)
    // 100 is the opening float: a courier's money is not expected in the drawer.
    expect(p.json.expected).toEqual({ cash: 100, card: 0, other: 0, cashOnDelivery: 24 })
    expect(p.json.report.byMethod).toEqual({ cash: 0, card: 0, other: 0, cashOnDelivery: 24 })
  })

  it('a cash sale beside it counts as it always did', async () => {
    const w = await tillWorld(app)
    await w.sell(2, COD)
    await w.sell(1, { tendered: 20 })
    const p = await preview(w)
    expect(p.json.expected).toEqual({ cash: 112, card: 0, other: 0, cashOnDelivery: 24 })
  })

  it('the close: a line of what is expected and never counted; the cash lines are untouched', async () => {
    const w = await tillWorld(app)
    await w.sell(2, COD)
    const closed = await w.call('POST', `/trade/pos/session/${w.sessionId}/close`, { counted: { cash: 100 } })

    expect(closed.status).toBe(200)
    const stored = await sessionOf(w)
    const lines = stored.closingBreakdown.map(({ _id, ...l }: any) => l)
    expect(lines).toEqual([
      { method: 'cash', expected: 100, counted: 100, difference: 0 },
      { method: 'card', expected: 0, counted: 0, difference: 0 },
      { method: 'other', expected: 0, counted: 0, difference: 0 },
      { method: 'cash_on_delivery', expected: 24 },
    ])
    expect(stored).toMatchObject({ expectedBalance: 100, closingBalance: 100, difference: 0 })
  })

  it('a close the client sends a counted figure for ignores it: there is nothing to count', async () => {
    const w = await tillWorld(app)
    await w.sell(2, COD)
    const closed = await w.call('POST', `/trade/pos/session/${w.sessionId}/close`, { counted: { cash: 100, cashOnDelivery: 24 } })
    expect(closed.status).toBe(200)
    const line = (await sessionOf(w)).closingBreakdown.find((l: any) => l.method === 'cash_on_delivery')
    expect(line.counted).toBeUndefined()
    expect(line.difference).toBeUndefined()
  })

  it('a session that took none closes on the three lines it always did', async () => {
    const w = await tillWorld(app)
    await w.sell(1)
    await w.call('POST', `/trade/pos/session/${w.sessionId}/close`, { counted: { cash: 112 } })
    expect((await sessionOf(w)).closingBreakdown.map((l: any) => l.method)).toEqual(['cash', 'card', 'other'])
  })

  it('the session report has it on its own line, on paper and on screen', async () => {
    const w = await tillWorld(app)
    await w.sell(2, COD)
    await w.sell(1, { method: 'card' })
    const closed = await w.call('POST', `/trade/pos/session/${w.sessionId}/close`, { counted: { cash: 100, card: 12 } })

    expect(closed.json.report.byMethod).toEqual({ cash: 0, card: 12, other: 0, cashOnDelivery: 24 })
    expect(closed.json.report.total).toBe(36)
    const printed = w.sim!.nonFiscalLines
    expect(printed.some(l => l.startsWith('Cash on delivery') && l.endsWith('24.00'))).toBe(true)
    // The drawer's own line does not move: the expected cash is the float.
    expect(printed.some(l => l.startsWith('Expected cash') && l.endsWith('100.00'))).toBe(true)
  })

  it('prints the line in the org\'s language, within the receipt\'s width', () => {
    const report = buildSessionReport({ sessionNumber: 'POS-1', currency: 'EUR', openingBalance: 0 }, [
      { type: 'sale', status: 'completed', total: 1234.56, lines: [], payments: [{ method: 'cash_on_delivery', amount: 1234.56 }] },
    ])
    expect(report.byMethod).toEqual({ cash: 0, card: 0, other: 0, cashOnDelivery: 1234.56 })
    const line = (locale: string) => formatSessionReport(report, locale).find(l => l.endsWith('1234.56') && !/TOTAL|ОБЩО|GESAMT|ВКУПНО/.test(l))
    expect(line('bg')).toStartWith('Наложен платеж')
    expect(line('mk')).toStartWith('При достава')
    expect(line('de')).toStartWith('Nachnahme')
    for (const locale of ['en', 'bg', 'de', 'mk']) expect(line(locale)!.length).toBeLessThanOrEqual(28)
  })

  it('a report with none prints no such line', async () => {
    const w = await tillWorld(app)
    await w.sell(1)
    const closed = await w.call('POST', `/trade/pos/session/${w.sessionId}/close`, { counted: { cash: 112 } })
    expect(closed.json.report.byMethod.cashOnDelivery).toBe(0)
    expect(w.sim!.nonFiscalLines.some(l => l.startsWith('Cash on delivery'))).toBe(false)
  })
})

describe('the session journal entry', () => {
  async function entryOf(w: TillWorld) {
    const receivable = await createTestAccount(w.oid, { name: 'Receivable', type: 'asset' })
    const revenue = await createTestAccount(w.oid, { name: 'Revenue', type: 'revenue', subType: 'operating_revenue' } as any)
    const journal = await Journal.create({ orgId: w.oid, name: 'Sales', code: `S${Date.now() % 100000}`, type: 'sale' })
    const session = await sessionOf(w)
    const rows = await loadPosRows({ orgId: w.orgId, sessionId: w.sessionId })
    const made = await createPOSSessionJournalEntry(
      w.orgId,
      { ...session, id: String(session._id) },
      rows,
      { receivableAccountId: String(receivable._id), revenueAccountId: String(revenue._id) },
      { id: String(journal._id), code: journal.code, name: journal.name } as any,
      false,
    )
    // A session whose money nets to nothing posts no entry at all.
    if (!made) return []
    const entry: any = await JournalEntry.findById(made.journalEntry.id).lean().exec()
    return entry.lines.map((l: any) => ({ text: String(l.description).split(':')[0], debit: l.debit, credit: l.credit }))
  }

  it('posts it as "POS Other" on the receivable account, and never as cash', async () => {
    const w = await tillWorld(app)
    await w.sell(2, COD)
    const lines = await entryOf(w)
    expect(lines.find((l: any) => l.text === 'POS Other')).toEqual({ text: 'POS Other', debit: 24, credit: 0 })
    expect(lines.some((l: any) => l.text === 'POS Cash')).toBe(false)
  })

  it('a storno takes it back out the same way: the session owes nothing, and nothing touched cash', async () => {
    const w = await tillWorld(app)
    const sale = (await w.sell(2, COD)).json.transaction
    expect((await w.storno(sale.id)).status).toBe(200)
    const lines = await entryOf(w)
    expect(lines.some((l: any) => l.text === 'POS Cash')).toBe(false)
    expect(lines.some((l: any) => l.text === 'POS Other')).toBe(false)
  })
})

describe('a storno', () => {
  it('prints in slot R and takes the money out of the session\'s bucket, never out of the drawer', async () => {
    const w = await tillWorld(app)
    const sale = (await w.sell(2, COD)).json.transaction

    const r = await w.storno(sale.id)

    expect(r.status).toBe(200)
    expect(w.sim!.receipts.at(-1)).toMatchObject({ kind: 'storno', payments: [{ mode: 'R', amount: 24 }] })
    const s = await sessionOf(w)
    expect(s).toMatchObject({ totalCashOnDelivery: 0, totalCash: 0, totalReturns: 24 })
    expect((await preview(w)).json.expected).toEqual({ cash: 100, card: 0, other: 0, cashOnDelivery: 0 })
    const report = (await preview(w)).json.report
    expect(report.byMethod).toEqual({ cash: 0, card: 0, other: 0, cashOnDelivery: 0 })
    expect(report.counts).toMatchObject({ sales: 1, stornos: 1 })

    const storno: any = await Invoice.findById(r.json.transaction.id).lean().exec()
    expect(storno.paymentMethod).toBe('cash_on_delivery')
  })

  it('through the journal, the same', async () => {
    const w = await tillWorld(app)
    const sale = (await w.sell(1, COD)).json.transaction
    const r = await w.call('POST', `/cash-register/documents/${sale.id}/storno`, { reason: 'customer_return', sessionId: w.sessionId })
    expect(r.status).toBe(200)
    expect(w.sim!.receipts.at(-1)).toMatchObject({ kind: 'storno', payments: [{ mode: 'R', amount: 12 }] })
  })

  it('accepts cash on delivery as the refund of a cash sale, the whole of it', async () => {
    const w = await tillWorld(app)
    const sale = (await w.sell(1)).json.transaction
    const refused = await w.storno(sale.id, undefined, { payments: [{ ...COD, amount: 5 }] })
    expect({ status: refused.status, code: refused.json.code }).toEqual({ status: 422, code: 'cod_amount_mismatch' })

    const r = await w.storno(sale.id, undefined, { payments: [{ ...COD, amount: 12 }] })
    expect(r.status).toBe(200)
    expect(w.sim!.receipts.at(-1)).toMatchObject({ kind: 'storno', payments: [{ mode: 'R', amount: 12 }] })
  })

  it('a COD sale refunded in cash leaves the drawer, and the courier still owes the sale', async () => {
    const w = await tillWorld(app)
    const sale = (await w.sell(1, COD)).json.transaction
    const r = await w.storno(sale.id, undefined, { payments: [{ method: 'cash', amount: 12 }] })
    expect(r.status).toBe(200)
    expect(w.sim!.receipts.at(-1)).toMatchObject({ kind: 'storno', payments: [{ mode: 'P', amount: 12 }] })
    expect(await sessionOf(w)).toMatchObject({ totalCashOnDelivery: 12, totalCash: -12 })
  })
})

describe('a device with no slot for it', () => {
  const REFUSED = { status: 422, code: 'cod_not_supported' }

  it('refuses the sale before anything is written: no document, no number, no УНП, nothing on the device', async () => {
    const w = await tillWorld(app, { manufacturer: 'tremol' })
    const before = await footprint(w)

    const r = await w.sell(2, COD)

    expect({ status: r.status, code: r.json.code }).toEqual(REFUSED)
    expect(r.json.message).toContain('cash-on-delivery')
    expect(await footprint(w)).toEqual(before)
    expect(w.sim!.receipts).toHaveLength(0)
  })

  it('refuses it on a text receipt too: the rule is the device\'s, and a retry with the switch off would fail anyway', async () => {
    const w = await tillWorld(app, { manufacturer: 'tremol' })
    const before = await footprint(w)
    const r = await w.sell(1, { ...COD, nonFiscal: true })
    expect({ status: r.status, code: r.json.code }).toEqual(REFUSED)
    expect(await footprint(w)).toEqual(before)
  })

  it('says why by the device\'s driver, and the next sale in cash takes the first number', async () => {
    const w = await tillWorld(app, { manufacturer: 'tremol' })
    const refused = await w.sell(1, COD)
    expect(refused.json.message).toContain('Tremol')
    const sold = await w.sell(1)
    expect(sold.status).toBe(200)
    expect(sold.json.transaction.transactionNumber).toMatch(/0*1$/)
  })

  it('a back-office sale joined to the session asks for a receipt: refused the same way, up front', async () => {
    const w = await tillWorld(app, { manufacturer: 'tremol' })
    const before = await footprint(w)
    for (const receipt of ['fiscal', 'text']) {
      const r = await w.cashierBackOfficeSale(1, { paymentMethod: 'cash_on_delivery', receipt })
      expect({ status: r.status, code: r.json.code }).toEqual(REFUSED)
    }
    expect(await footprint(w)).toEqual(before)
  })

  it('a joined sale that asks for no receipt prints nothing, so nothing refuses it', async () => {
    const w = await tillWorld(app, { manufacturer: 'tremol' })
    const r = await w.cashierBackOfficeSale(1, { paymentMethod: 'cash_on_delivery' })
    expect(r.status).toBe(200)
    expect((await sessionOf(w)).totalCashOnDelivery).toBe(12)
  })

  it('a storno that would print it is refused before the sale is claimed; a refund in cash goes through', async () => {
    const w = await tillWorld(app)
    const sale = (await w.sell(1, COD)).json.transaction
    await FiscalDevice.updateOne({ _id: w.deviceId }, { $set: { manufacturer: 'tremol' } }).exec()
    const before = await footprint(w)

    const refused = await w.storno(sale.id)

    expect({ status: refused.status, code: refused.json.code }).toEqual(REFUSED)
    expect(await footprint(w)).toEqual(before)
    const doc: any = await Invoice.findById(sale.id).lean().exec()
    expect(doc.register.stornoState).toBe('none')
    expect(doc.register.stornoedBy ?? []).toHaveLength(0)

    expect((await w.storno(sale.id, undefined, { payments: [{ method: 'cash', amount: 12 }] })).status).toBe(200)
  })

  it('a keyed retry of a sale that happened is answered from it, never refused', async () => {
    const w = await tillWorld(app)
    const sold = await w.sell(1, COD, 'cod-retry')
    expect(sold.status).toBe(200)
    await FiscalDevice.updateOne({ _id: w.deviceId }, { $set: { manufacturer: 'tremol' } }).exec()
    const retry = await w.sell(1, COD, 'cod-retry')
    expect(retry.status).toBe(200)
    expect(retry.json.transaction.id).toBe(sold.json.transaction.id)
    expect(w.sim!.receipts).toHaveLength(1)
  })
})

describe('a back-office sale joined to the session', () => {
  it('prints in slot R on a receipt it asked for, and counts in the same bucket', async () => {
    const w = await tillWorld(app)
    const r = await w.cashierBackOfficeSale(1, { paymentMethod: 'cash_on_delivery', receipt: 'fiscal' })

    expect(r.status).toBe(200)
    expect(w.sim!.receipts[0]).toMatchObject({ kind: 'fiscal', payments: [{ mode: 'R', amount: 12 }] })
    const s = await sessionOf(w)
    expect(s).toMatchObject({ totalCashOnDelivery: 12, totalCash: 0 })
    expect((await preview(w)).json.expected.cash).toBe(100)
  })
})

describe('the journal and SUPTO', () => {
  it('the journal filters by it and names it in words', async () => {
    const w = await tillWorld(app)
    const cod = (await w.sell(1, COD)).json.transaction
    await w.sell(1)

    const { json } = await w.call('GET', '/cash-register/documents?paymentMethod=cash_on_delivery')
    expect(json.rows.map((r: any) => r.id)).toEqual([cod.id])
    expect(json.rows[0].paymentLabel).toBe('cash on delivery')
    expect(json.rows[0].payments[0].method).toBe('cash_on_delivery')
  })

  it('SUPTO 18.2 prints the payment\'s name, not its key; every other method as it always did', async () => {
    const buffer = await generateTable182([
      { transactionNumber: 'CS-1', total: 12, payments: [{ method: 'cash_on_delivery', amount: 12 }] },
      { transactionNumber: 'CS-2', total: 12, payments: [{ method: 'cash', amount: 12 }] },
      { transactionNumber: 'CS-3', total: 12, payments: [{ method: 'card', amount: 12 }] },
    ])
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load(buffer as any)
    const cells: string[] = []
    wb.worksheets[0].eachRow((row, i) => { if (i > 1) cells.push(String(row.getCell(5).value)) })
    expect(cells).toEqual(['Наложен платеж', 'cash', 'card'])
  })
})
