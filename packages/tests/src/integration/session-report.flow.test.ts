import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import type { Elysia } from 'elysia'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { tillApp, tillWorld, forgetDevices } from '../helpers/till-world'
import { buildSessionReport, formatSessionReport } from 'services/biz/cash-register/session-report'
import { EltradeFiscalPrinter } from 'fiscal/eltrade'
import { registerPrinter } from 'fiscal/fiscal-device.service'
import { FiscalDevice, POSSession } from 'db/models'

/**
 * "Close session → print fiscal report is printing zeros everywhere" (2026-10-31). The Z-report
 * is the device's own, and a device counts only its fiscal receipts: a till printing text
 * receipts closes on zeros. So the close prints the session's report after it — LGR's figures,
 * from the session's rows by the journal entry's rules — keeps it for a reprint, and records a
 * print that failed without undoing the close.
 *
 * NOTE: no `.rejects` / `.resolves` (Bun-on-Windows deadlock, see Known Issues).
 */

let app: Elysia
beforeAll(async () => { await setupTestDB(); app = tillApp() }, 60_000)
afterAll(async () => { await teardownTestDB() }, 60_000)
afterEach(async () => { forgetDevices(); await clearCollections() })

const OPEN_NONFISCAL = 0x26
const Z_REPORT = 0x45

describe('the session report: its figures', () => {
  const line = (rate: number, net: number) => ({ taxRate: rate, lineTotal: net, taxAmount: (net * rate) / 100 })
  const session = { sessionNumber: 'POS-2026-00001', currency: 'EUR', openingBalance: 50, openedAt: '2026-10-31T06:00:00Z' }
  const rows = [
    { type: 'sale', status: 'completed', transactionNumber: 'CS-1', total: 24, lines: [line(20, 20)], payments: [{ method: 'cash', amount: 30 }], changeDue: 6, isFiscal: true, fiscal: { state: 'printed', mode: 'fiscal' }, fiscalReceiptNumber: '0001' },
    // Stornoed later: the sale still counts, its storno takes it back.
    { type: 'sale', status: 'cancelled', transactionNumber: 'CS-2', total: 12, lines: [line(20, 10)], payments: [{ method: 'card', amount: 12 }], fiscal: { state: 'printed', mode: 'text' } },
    { type: 'storno', status: 'completed', transactionNumber: 'CS-3', total: 12, lines: [line(20, 10)], payments: [{ method: 'card', amount: 12 }], isFiscal: true, fiscal: { state: 'printed', mode: 'fiscal' }, fiscalReceiptNumber: '0002' },
    // Its receipt failed: it reversed nothing.
    { type: 'storno', status: 'cancelled', transactionNumber: 'CS-4', total: 24, lines: [line(20, 20)], payments: [{ method: 'cash', amount: 24 }], fiscal: { state: 'failed' } },
  ]

  it('counts the sales, the stornos and the voided ones; VAT per rate; the money per method; what printed', () => {
    const r = buildSessionReport(session, rows, { closing: [{ method: 'cash', expected: 74, counted: 70, difference: -4 }], zReportNumber: '0042' })
    expect(r.counts).toEqual({ sales: 2, stornos: 1, voided: 1, fiscal: 2, text: 1, unprinted: 0 })
    expect(r.vat).toEqual([{ rate: 20, net: 20, vat: 4, gross: 24 }])
    expect(r.total).toBe(24)
    // The drawer keeps 30 less the 6 change; the card sale and its storno net out.
    expect(r.byMethod).toEqual({ cash: 24, card: 0, other: 0 })
    expect(r.change).toBe(6)
    expect(r.drawer).toEqual({ opening: 50, expected: 74, counted: 70, difference: -4 })
    expect(r.documents).toEqual({ first: 'CS-1', last: 'CS-4' })
    expect(r.receipts).toEqual({ first: '0001', last: '0002' })
    expect(r.zReportNumber).toBe('0042')
  })

  it('prints at the till\'s 28 characters, in the org\'s language', () => {
    const r = buildSessionReport(session, rows, { closing: [{ method: 'cash', expected: 74, counted: 70, difference: -4 }], zReportNumber: '0042' })
    const lines = formatSessionReport(r, 'bg')
    expect(lines.every((s) => s.length <= 28)).toBe(true)
    expect(lines[0]).toContain('ОТЧЕТ ЗА СЕСИЯ')
    expect(lines.some((s) => s.startsWith('Продажби') && s.endsWith('2'))).toBe(true)
    expect(lines.some((s) => s.startsWith('Разлика') && s.endsWith('-4.00'))).toBe(true)
    expect(lines.some((s) => s.startsWith('Z-отчет №') && s.endsWith('0042'))).toBe(true)
  })
})

describe('the session report at close', () => {
  const close = (w: Awaited<ReturnType<typeof tillWorld>>, cash: number, key?: string) =>
    w.call('POST', `/trade/pos/session/${w.sessionId}/close`, { counted: { cash, card: 12 } }, key)

  it('prints after the Z-report with the session\'s own figures, is kept, and reprints', async () => {
    const w = await tillWorld(app)
    expect((await w.sell(2)).status).toBe(200)
    expect((await w.sell(1, { method: 'card' })).status).toBe(200)
    const preview = await w.call('GET', `/trade/pos/session/${w.sessionId}/close-preview`)
    expect(preview.json.report).toMatchObject({ total: 36, counts: { sales: 2 } })

    const closed = await close(w, 124)
    expect(closed.status).toBe(200)
    expect(closed.json.report).toMatchObject({ total: 36, counts: { sales: 2, stornos: 0, fiscal: 2 }, byMethod: { cash: 24, card: 12 } })
    expect(closed.json.reportError).toBeUndefined()
    const cmds = w.sim!.executed.map((e) => e.cmd)
    expect(cmds.lastIndexOf(OPEN_NONFISCAL)).toBeGreaterThan(cmds.lastIndexOf(Z_REPORT))
    expect(w.sim!.nonFiscalLines.join('\n')).toContain('SESSION REPORT')

    const stored: any = await POSSession.findById(w.sessionId).lean().exec()
    expect(stored.report.total).toBe(36)
    expect(stored.reportPrintedAt).toBeTruthy()

    const printed = w.sim!.executed.filter((e) => e.cmd === OPEN_NONFISCAL).length
    expect((await w.call('POST', `/trade/pos/session/${w.sessionId}/report/print`)).status).toBe(200)
    expect(w.sim!.executed.filter((e) => e.cmd === OPEN_NONFISCAL).length).toBe(printed + 1)
    expect((await w.call('GET', `/trade/pos/session/${w.sessionId}/report`)).json.report.total).toBe(36)
  })

  it('a keyed retry of the close returns its report and prints nothing again', async () => {
    const w = await tillWorld(app)
    await w.sell(1)
    expect((await close(w, 112, 'close-report-1')).status).toBe(200)
    const printed = w.sim!.executed.filter((e) => e.cmd === OPEN_NONFISCAL).length
    const retry = await close(w, 112, 'close-report-1')
    expect(retry.status).toBe(200)
    expect(retry.json.report.counts.sales).toBe(1)
    expect(w.sim!.executed.filter((e) => e.cmd === OPEN_NONFISCAL).length).toBe(printed)
  })

  it('a report that does not print is recorded, and the session stays closed', async () => {
    const w = await tillWorld(app)
    await w.sell(1)
    const device: any = await FiscalDevice.findOne({ orgId: w.oid }).lean().exec()
    const id = String(device._id)
    const real = new EltradeFiscalPrinter(w.sim!.exchange, id)
    const jammed = Object.assign(Object.create(Object.getPrototypeOf(real)), real, {
      openNonFiscalReceipt: async () => { throw new Error('Out of paper') },
    })
    registerPrinter(id, jammed)

    const closed = await close(w, 112)
    expect(closed.status).toBe(200)
    expect(closed.json.reportError).toContain('Out of paper')
    const stored: any = await POSSession.findById(w.sessionId).lean().exec()
    expect(stored.status).toBe('closed')
    expect(stored.report.counts.sales).toBe(1)
    expect(stored.reportError).toContain('Out of paper')
    expect(stored.reportPrintedAt).toBeUndefined()
  })

  it('a till with no device keeps its report and prints nothing', async () => {
    const w = await tillWorld(app, { device: false })
    await w.sell(1)
    const closed = await close(w, 112)
    expect(closed.status).toBe(200)
    expect(closed.json.report.counts.sales).toBe(1)
    expect(closed.json.reportError).toBeUndefined()
    const stored: any = await POSSession.findById(w.sessionId).lean().exec()
    expect(stored.report.total).toBe(12)
    expect(stored.reportPrintedAt).toBeUndefined()
  })
})
