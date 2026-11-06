import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import type { Elysia } from 'elysia'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { tillApp, tillWorld, forgetDevices } from '../helpers/till-world'
import { SESSION_REPORT_LABELS, buildSessionReport, formatSessionReport } from 'services/biz/cash-register/session-report'
import { toPosTransaction } from 'services/biz/cash-register/mapping'
import { posRowSign } from 'services/biz/cash-register/counting'
import { computePosTotals, roundCents } from 'config/pos-totals'
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
const CLOSE_NONFISCAL = 0x27
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
    expect(r.byMethod).toEqual({ cash: 24, card: 0, other: 0, cashOnDelivery: 0 })
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

  describe('what each kind of receipt came to', () => {
    const unprinted = { type: 'sale', status: 'completed', transactionNumber: 'CS-5', total: 6, lines: [line(20, 5)], payments: [{ method: 'cash', amount: 6 }], fiscal: { state: 'failed', mode: 'fiscal' } }
    const paid = { type: 'payment_receipt', status: 'completed', transactionNumber: 'PR-1', total: 5, lines: [line(0, 5)], payments: [{ method: 'cash', amount: 5 }], isFiscal: true, fiscal: { state: 'printed', mode: 'fiscal' } }

    it('beside its count: a storno takes back, and what is fiscal is what a Z should show', () => {
      const r = buildSessionReport(session, [...rows, unprinted, paid])
      expect(r.counts).toMatchObject({ fiscal: 3, text: 1, unprinted: 1 })
      // 24 + 5 − 12 on the device; 12 as a text receipt, which moves no counter on it; 6 printed nowhere.
      expect(r.amounts).toEqual({ fiscal: 17, text: 12, unprinted: 6 })
      expect(r.amounts!.fiscal + r.amounts!.text + r.amounts!.unprinted).toBe(r.total)
    })

    it('a row from before the state was recorded reads as the journal reads it', () => {
      const legacy = (over: Record<string, unknown>) => ({ type: 'sale', status: 'completed', total: 10, lines: [], payments: [], ...over })
      const r = buildSessionReport(session, [
        legacy({ isFiscal: true, fiscalReceiptNumber: '0001' }),
        legacy({ isFiscal: false, fiscalReceiptNumber: '0002', total: 3 }),
        legacy({ total: 4 }),
      ])
      expect(r.amounts).toEqual({ fiscal: 10, text: 3, unprinted: 4 })
    })

    it('prints beside the count, at the till\'s 28 characters', () => {
      const lines = formatSessionReport(buildSessionReport(session, [...rows, unprinted]), 'bg')
      expect(lines).toContain('Фискални бонове 2      12.00')
      expect(lines).toContain('Служебни бонове 1      12.00')
      expect(lines).toContain('Неотпечатани 1          6.00')
    })

    it('when they do not fit beside it, the amount takes a line of its own: the label is never cut', () => {
      const r = { ...buildSessionReport(session, rows), counts: { sales: 0, stornos: 0, voided: 0, fiscal: 999, text: 0, unprinted: 0 }, amounts: { fiscal: 123456.78, text: 0, unprinted: 0 } }
      const lines = formatSessionReport(r, 'bg')
      expect(lines).toContain('Фискални бонове          999')
      expect(lines).toContain('                   123456.78')
      expect(lines.every((s) => s.length <= 28)).toBe(true)
    })

    it('a report kept by a close before it had amounts prints its counts, as it did', () => {
      const { amounts: _a, ...kept } = buildSessionReport(session, rows)
      expect(formatSessionReport(kept, 'bg')).toContain('Фискални бонове            2')
    })
  })

  // Everything that can print, at the largest figures a day of a shop reaches.
  const everything = () => {
    const big = (over: Record<string, unknown>) => ({
      status: 'completed', total: 123456.78, lines: [line(20, 102880.65)], payments: [{ method: 'cash', amount: 123456.78 }], ...over,
    })
    const zReport = { fmTotal: 123456.78, turnover: [{ group: 'Б', amount: 123456.78 }] }
    return buildSessionReport({ ...session, closedAt: '2026-11-02T11:20:00Z', zReport }, [
      big({ type: 'sale', transactionNumber: 'CS-2026-00001', changeDue: 12.5, isFiscal: true, fiscal: { state: 'printed', mode: 'fiscal' }, fiscalReceiptNumber: '0000101' }),
      big({ type: 'sale', transactionNumber: 'CS-2026-00002', fiscal: { state: 'printed', mode: 'text' }, payments: [{ method: 'card', amount: 123456.78 }] }),
      big({ type: 'sale', transactionNumber: 'CS-2026-00003', fiscal: { state: 'failed' }, payments: [{ method: 'voucher', amount: 123456.78 }] }),
      big({ type: 'sale', transactionNumber: 'CS-2026-00004', fiscal: { state: 'printed', mode: 'text' }, payments: [{ method: 'cash_on_delivery', amount: 123456.78 }] }),
      big({ type: 'payment_receipt', transactionNumber: 'PR-2026-00001', isFiscal: true, fiscal: { state: 'printed', mode: 'fiscal' }, fiscalReceiptNumber: '0000102' }),
      big({ type: 'storno', transactionNumber: 'CS-2026-00005', isFiscal: true, fiscal: { state: 'printed', mode: 'fiscal' }, fiscalReceiptNumber: '0000103' }),
      big({ type: 'storno', status: 'cancelled', transactionNumber: 'CS-2026-00006', fiscal: { state: 'failed' } }),
    ], { closing: [{ method: 'cash', expected: 123456.78, counted: 123456.78, difference: -123.45 }], zReportNumber: '0042' })
  }

  for (const locale of ['en', 'bg', 'de', 'mk']) {
    it(`in ${locale}, every label prints whole, beside the longest figure it stands next to`, () => {
      const lines = formatSessionReport(everything(), locale)
      const l = SESSION_REPORT_LABELS[locale]

      expect(lines.filter((s) => s.length > 28)).toEqual([])
      for (const key of ['opened', 'closed', 'sales', 'payments', 'stornos', 'voided', 'fiscal', 'text', 'unprinted', 'vat', 'net', 'gross', 'cash', 'card', 'other', 'cod', 'change', 'opening', 'expected', 'counted', 'difference', 'documents', 'receipts', 'z', 'deviceZ', 'fmTotal', 'vatGroup']) {
        expect({ key, label: l[key], whole: lines.some((s) => s.trimStart().startsWith(`${l[key]} `) || s.trim() === l[key]) }).toEqual({ key, label: l[key], whole: true })
      }
    })
  }

  it('prints the date short, on the org\'s clock, the same in every language', () => {
    for (const locale of ['en', 'bg', 'de', 'mk']) {
      const lines = formatSessionReport(everything(), locale, 'Europe/Sofia')
      expect(lines.find((s) => s.startsWith(SESSION_REPORT_LABELS[locale].closed))?.endsWith(' 02.11.26 13:20')).toBe(true)
      expect(lines.find((s) => s.startsWith(SESSION_REPORT_LABELS[locale].opened))?.endsWith(' 31.10.26 08:00')).toBe(true)
    }
    expect(formatSessionReport(everything(), 'bg', 'UTC').some((s) => s.endsWith(' 02.11.26 11:20'))).toBe(true)
  })
})

/**
 * 2026-11-06, a field test on an A3: a session of one sale printed its VAT row's „Сума" a cent under its „ОБЩО",
 * and its „Основа" a cent off the receipt's. The VAT rows summed each line's own rounded net and VAT; the receipt,
 * the document and the journal entry round the gross once per rate (`computePosTotals`). The prices here are the
 * ones `config/pos-totals` already names, and made-up ones that miss the same way.
 */
describe('the session report: its VAT rows add up to its total, as the receipts do', () => {
  // A till document's line as the register stores it: its net rounded on its own, its VAT beside it, `lineTotal` gross.
  const docLine = (quantity: number, unitPrice: number, taxRate: number) => {
    const taxAmount = roundCents((quantity * unitPrice * taxRate) / 100)
    return { description: 'x', quantity, unitPrice, taxRate, discount: 0, taxAmount, lineTotal: roundCents(roundCents(quantity * unitPrice) + taxAmount) }
  }
  // A till sale as it is stored, totalled the receipt's way, and read as the report reads it.
  const sale = (number: string, lines: ReturnType<typeof docLine>[], over: Record<string, any> = {}) => {
    const totals = computePosTotals(lines)
    return toPosTransaction({
      _id: number, type: 'cash_sale', status: 'paid', invoiceNumber: number, currency: 'EUR', lines, ...totals,
      payments: [{ method: 'cash', amount: totals.total }],
      register: { origin: 'pos', fiscal: { state: 'printed', mode: 'text' } },
      ...over,
    })
  }
  const session = { sessionNumber: 'POS-2026-00001', currency: 'EUR', openingBalance: 0 }
  const revenue = (rows: any[]) => roundCents(rows.reduce((s, r) => s + posRowSign(r) * (r.total - r.taxTotal), 0))

  it('one valve at 17.8952 net: 17.89 + 3.58 = 21.47, as its receipt printed, where its line says 17.90 + 3.58 = 21.48', () => {
    const row = sale('CS-1', [docLine(1, 17.8952, 20)])
    expect(row.lines[0]).toMatchObject({ lineTotal: 17.9, taxAmount: 3.58 })
    const r = buildSessionReport(session, [row])
    expect(r.vat).toEqual([{ rate: 20, net: 17.89, vat: 3.58, gross: 21.47 }])
    expect(r.total).toBe(21.47)
    const printed = formatSessionReport(r, 'bg')
    expect(printed).toContain(' Сума'.padEnd(23) + '21.47')
    expect(printed).toContain('ОБЩО EUR'.padEnd(23) + '21.47')
  })

  it('two lines of one rate: 57.02 + 11.40 = 68.42, where the lines say 68.43 and 11.41', () => {
    const row = sale('CS-1', [docLine(3, 17.8952, 20), docLine(1, 3.3333, 20)])
    expect({ total: row.total, taxTotal: row.taxTotal }).toEqual({ total: 68.42, taxTotal: 11.4 })
    expect(buildSessionReport(session, [row]).vat).toEqual([{ rate: 20, net: 57.02, vat: 11.4, gross: 68.42 }])
  })

  it('two rates: each its own gross and VAT, as the device totals them, never a cent borrowed from the other', () => {
    // By their lines, 20 % comes to 68.43 with 11.41 VAT and 9 % to 1.52 with 0.12: each one cent away, in
    // opposite directions, so the totals agree and a share by the lines' proportions keeps both cents where
    // they are wrong. The receipt rounds the gross once per rate: 68.42 / 11.40 and 1.53 / 0.13.
    const row = sale('CS-1', [docLine(3, 17.8952, 20), docLine(1, 3.3333, 20), docLine(1, 0.7, 9), docLine(1, 0.7, 9)])
    expect({ total: row.total, taxTotal: row.taxTotal }).toEqual({ total: 69.95, taxTotal: 11.53 })
    const r = buildSessionReport(session, [row])
    expect(r.vat).toEqual([
      { rate: 20, net: 57.02, vat: 11.4, gross: 68.42 },
      { rate: 9, net: 1.4, vat: 0.13, gross: 1.53 },
    ])
    // What the session's journal entry books, to the cent.
    expect(roundCents(r.vat.reduce((s, v) => s + v.net, 0))).toBe(revenue([row]))
    expect(roundCents(r.vat.reduce((s, v) => s + v.gross, 0))).toBe(r.total)
  })

  it('a storno takes back what its sale gave, rate by rate', () => {
    const lines = [docLine(3, 17.8952, 20), docLine(1, 0.7, 9)]
    const rows = [
      sale('CS-2', lines, { register: { origin: 'pos', stornoState: 'full', fiscal: { state: 'printed', mode: 'text' } } }),
      sale('CS-3', lines, { type: 'cash_storno', register: { origin: 'pos', fiscal: { state: 'printed', mode: 'text' } } }),
      sale('CS-4', [docLine(1, 17.8952, 20)]),
    ]
    const r = buildSessionReport(session, rows)
    expect(r.counts).toMatchObject({ sales: 2, stornos: 1 })
    expect(r.vat).toEqual([
      { rate: 20, net: 17.89, vat: 3.58, gross: 21.47 },
      { rate: 9, net: 0, vat: 0, gross: 0 },
    ])
    expect(r.total).toBe(21.47)
    expect(roundCents(r.vat.reduce((s, v) => s + v.net, 0))).toBe(revenue(rows))
  })

  it('lines with no price to total them by share the total in their proportions, and the VAT the device\'s way', () => {
    const row = { type: 'sale', status: 'completed', total: 17.45, taxTotal: 2.45, payments: [], lines: [{ taxRate: 20, lineTotal: 10, taxAmount: 2 }, { taxRate: 9, lineTotal: 5, taxAmount: 0.45 }] }
    expect(buildSessionReport(session, [row]).vat).toEqual([
      { rate: 20, net: 10, vat: 2, gross: 12 },
      { rate: 9, net: 5, vat: 0.45, gross: 5.45 },
    ])
  })

  it('a negative line cannot be shared by: the lines\' own figures stand, as before', () => {
    const row = { type: 'sale', status: 'completed', total: 10.91, taxTotal: 1.91, payments: [], lines: [{ taxRate: 20, lineTotal: 10, taxAmount: 2 }, { taxRate: 9, lineTotal: -1, taxAmount: -0.09 }] }
    expect(buildSessionReport(session, [row]).vat).toEqual([
      { rate: 20, net: 10, vat: 2, gross: 12 },
      { rate: 9, net: -1, vat: -0.09, gross: -1.09 },
    ])
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

  it('a close says what its fiscal and its text receipts came to', async () => {
    const w = await tillWorld(app)
    expect((await w.sell(2)).status).toBe(200)
    expect((await w.sell(1, { text: true })).status).toBe(200)

    const closed = await close(w, 124)

    expect(closed.status).toBe(200)
    expect(closed.json.report.counts).toMatchObject({ fiscal: 1, text: 1, unprinted: 0 })
    expect(closed.json.report.amounts).toEqual({ fiscal: 24, text: 12, unprinted: 0 })
    expect(w.sim!.nonFiscalLines.join('\n')).toContain('Fiscal receipts 1')
    expect((await POSSession.findById(w.sessionId).lean().exec() as any).report.amounts).toEqual({ fiscal: 24, text: 12, unprinted: 0 })
  })

  describe('the Z\'s own answer', () => {
    const zOf = async (w: Awaited<ReturnType<typeof tillWorld>>) => (await POSSession.findById(w.sessionId).lean().exec() as any).zReport

    it('is kept on the session, raw and parsed, and shows on the report and its print, as the device\'s', async () => {
      const w = await tillWorld(app)
      expect((await w.sell(2)).status).toBe(200)

      const closed = await close(w, 124)

      expect(closed.status).toBe(200)
      expect(closed.json.zReportNumber).toBe('0013')
      const kept = await zOf(w)
      expect(kept.raw).toBe('0013,24.00,0.00,24.00,0.00,0.00,0.00,0.00,0.00,0.00')
      expect(kept.closure).toBe('0013')
      expect(kept.fmTotal).toBe(24)
      expect(kept.turnover.map((t: any) => [t.group, t.amount])).toEqual([['А', 0], ['Б', 24], ['В', 0], ['Г', 0], ['Д', 0], ['Е', 0], ['Ж', 0], ['З', 0]])
      // LGR's fiscal amount and the device's own figure, side by side: on a simulator, they agree.
      expect(closed.json.report.amounts.fiscal).toBe(24)
      // Only what says something: a group with nothing on it is no line on a till's paper.
      expect(closed.json.report.deviceZ).toEqual({ fmTotal: 24, turnover: [{ group: 'Б', amount: 24 }] })
      expect((await w.call('GET', `/trade/pos/session/${w.sessionId}/report`)).json.report.deviceZ).toEqual({ fmTotal: 24, turnover: [{ group: 'Б', amount: 24 }] })

      const printed = w.sim!.nonFiscalLines
      const number = printed.findIndex((s) => s.startsWith('Z-report No.'))
      expect(printed.slice(number + 1, number + 4)).toEqual([
        'On the device',
        ' FM total'.padEnd(23) + '24.00',
        ' VAT group Б'.padEnd(23) + '24.00',
      ])
    })

    it('a day of text receipts: the device says zero, and the report shows that, with no alarm', async () => {
      const w = await tillWorld(app)
      expect((await w.sell(1, { text: true })).status).toBe(200)

      const closed = await close(w, 112)

      expect(closed.json.report.amounts).toEqual({ fiscal: 0, text: 12, unprinted: 0 })
      expect(closed.json.report.deviceZ).toEqual({ fmTotal: 0, turnover: [] })
      expect(w.sim!.nonFiscalLines).toContain(' FM total'.padEnd(24) + '0.00')
    })

    it('a figure that disagrees with LGR\'s raises nothing: no unit has proven what these mean', async () => {
      const w = await tillWorld(app)
      expect((await w.sell(1)).status).toBe(200)
      w.sim!.zAnswer = '0013,6.00,0,0,0,0,0,0,0,0'

      const closed = await close(w, 112)

      expect(closed.status).toBe(200)
      expect(closed.json.reportError).toBeUndefined()
      expect(closed.json.report.amounts.fiscal).toBe(12)
      expect(closed.json.report.deviceZ.fmTotal).toBe(6)
      expect(Object.keys(closed.json.report).filter((k) => /mismatch|alarm|warn/i.test(k))).toEqual([])
    })

    it('a driver with no figures, as a Tremol: nothing is kept and nothing is shown', async () => {
      const w = await tillWorld(app)
      await w.sell(1)
      const printer = new EltradeFiscalPrinter(w.sim!.exchange, w.deviceId)
      printer.printDailyZReport = async () => ({ reportNumber: 'unknown', dateTime: new Date(), totalSales: 0, totalReturns: 0, receiptCount: 0 })
      registerPrinter(w.deviceId, printer)

      const closed = await close(w, 112)

      expect(closed.status).toBe(200)
      expect(closed.json.zReportNumber).toBeUndefined()
      expect(closed.json.report.deviceZ).toBeUndefined()
      expect(await zOf(w)).toBeUndefined()
      expect(w.sim!.nonFiscalLines.join('\n')).not.toContain('On the device')
    })

    it('a driver that reads no figures from its answer keeps the answer and shows nothing', async () => {
      const w = await tillWorld(app)
      await w.sell(1)
      const printer = new EltradeFiscalPrinter(w.sim!.exchange, w.deviceId)
      printer.printDailyZReport = async () => ({ reportNumber: '0007', dateTime: new Date(), totalSales: 12, totalReturns: 0, receiptCount: 1, raw: '0007,12.00,0,1' })
      registerPrinter(w.deviceId, printer)

      const closed = await close(w, 112)

      expect(closed.json.zReportNumber).toBe('0007')
      expect(closed.json.report.deviceZ).toBeUndefined()
      expect(await zOf(w)).toMatchObject({ raw: '0007,12.00,0,1', closure: '0007' })
      expect(w.sim!.nonFiscalLines.join('\n')).not.toContain('On the device')
    })

    it('a close without a fiscal report ran no Z, and has none to keep', async () => {
      const w = await tillWorld(app)
      await w.sell(1)

      const closed = await w.call('POST', `/trade/pos/session/${w.sessionId}/close`, { counted: { cash: 112 }, closeWithoutFiscal: true })

      expect(closed.status).toBe(200)
      expect(closed.json.report.deviceZ).toBeUndefined()
      expect(await zOf(w)).toBeUndefined()
    })
  })

  describe('a closed session with no kept report: it closed before `session.report` existed', () => {
    const forget = (w: Awaited<ReturnType<typeof tillWorld>>, fields: string[]) =>
      POSSession.updateOne({ _id: w.sessionId }, { $unset: Object.fromEntries(fields.map((f) => [f, 1])) }).exec()

    it('is rebuilt with its drawer lines, its Z and the Z\'s answer, as its close would have kept it', async () => {
      const w = await tillWorld(app)
      await w.sell(2)
      const closed = await close(w, 120)
      expect(closed.json.report.drawer).toEqual({ opening: 100, onDevice: true, expected: 124, counted: 120, difference: -4 })
      await forget(w, ['report'])

      const rebuilt = await w.call('GET', `/trade/pos/session/${w.sessionId}/report`)

      expect(rebuilt.json.report).toEqual(closed.json.report)
    })

    it('prints them too', async () => {
      const w = await tillWorld(app)
      await w.sell(2)
      await close(w, 120)
      await forget(w, ['report'])
      w.sim!.nonFiscalLines.length = 0

      expect((await w.call('POST', `/trade/pos/session/${w.sessionId}/report/print`)).status).toBe(200)

      const printed = w.sim!.nonFiscalLines
      for (const expected of [['Expected cash', '124.00'], ['Counted', '120.00'], ['Difference', '-4.00'], ['Z-report No.', '0013']]) {
        expect({ expected, on: printed.some((s) => s.startsWith(expected[0]) && s.endsWith(expected[1])) }).toEqual({ expected, on: true })
      }
    })

    it('one that has none of those shows what it has: its rows and its float', async () => {
      const w = await tillWorld(app)
      await w.sell(2)
      await close(w, 124)
      await forget(w, ['report', 'closingBreakdown', 'zReportNumber', 'zReport'])

      const { report } = (await w.call('GET', `/trade/pos/session/${w.sessionId}/report`)).json

      expect(report.counts.sales).toBe(1)
      expect(report.drawer).toEqual({ opening: 100, onDevice: true })
      expect(report.zReportNumber).toBeUndefined()
      expect(report.deviceZ).toBeUndefined()
    })

    it('a report that was kept stays as it was printed', async () => {
      const w = await tillWorld(app)
      await w.sell(2)
      await close(w, 124)
      await POSSession.updateOne({ _id: w.sessionId }, { $set: { 'report.zReportNumber': 'kept', zReportNumber: 'not this' } }).exec()

      const { report } = (await w.call('GET', `/trade/pos/session/${w.sessionId}/report`)).json

      expect(report.zReportNumber).toBe('kept')
    })
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

  it('a line that fails leaves no receipt open on the device, and the session stays closed', async () => {
    const w = await tillWorld(app)
    await w.sell(1)
    const printer = new EltradeFiscalPrinter(w.sim!.exchange, w.deviceId)
    const print = printer.printNonFiscalText.bind(printer)
    let lines = 0
    printer.printNonFiscalText = async (text: string) => {
      if (++lines === 3) throw new Error('Paper jam')
      return print(text)
    }
    registerPrinter(w.deviceId, printer)

    const closed = await close(w, 112)
    expect(closed.status).toBe(200)
    expect(closed.json.reportError).toContain('Paper jam')
    // The receipt the failed line left open is closed, or the device would refuse what comes next.
    expect(w.sim!.nonFiscalOpen).toBe(false)
    expect(w.sim!.executed.filter((e) => e.cmd === CLOSE_NONFISCAL)).toHaveLength(1)

    // The jam is cleared: the reprint finds nothing in its way.
    const reprinted = await w.call('POST', `/trade/pos/session/${w.sessionId}/report/print`)
    expect(reprinted.status).toBe(200)
    expect(w.sim!.nonFiscalLines.join('\n')).toContain('SESSION REPORT')
    expect(w.sim!.nonFiscalOpen).toBe(false)
  })

  it('a receipt that never opened is not closed: there is nothing to close', async () => {
    const w = await tillWorld(app)
    await w.sell(1)
    const printer = new EltradeFiscalPrinter(w.sim!.exchange, w.deviceId)
    printer.openNonFiscalReceipt = async () => { throw new Error('Out of paper') }
    let closes = 0
    printer.closeNonFiscalReceipt = async () => { closes++ }
    registerPrinter(w.deviceId, printer)

    const closed = await close(w, 112)
    expect(closed.json.reportError).toContain('Out of paper')
    expect(closes).toBe(0)
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
