import { describe, it, expect } from 'bun:test'
import { captureRejection, expectRejection } from '../helpers/capture-rejection'
import { EltradeSimulator } from '../helpers/eltrade-simulator'
import {
  EltradeFiscalPrinter,
  decodeEltradeStatus,
  describeEltradeStatus,
  eltradeRejectionReasons,
  parseEltradeDiagnostics,
  parseDeviceAmount,
  splitItemText,
  ELTRADE_CMD,
} from 'fiscal/eltrade'
import { buildIslFrame, buildIslResponseFrame, islBcc, parseIslStream, ISL } from 'fiscal/isl-frame'
import { encodeCp1251, decodeCp1251 } from 'fiscal/cp1251'
import { formatDeviceDateTime, formatDeviceIsoDateTime, parseDeviceDateTime } from 'fiscal/zoned-time'
import { mapTaxRateToVatGroup } from 'fiscal/vat-groups'
import { toVatGroup } from 'fiscal/types'
import { IslResponseCollector } from 'ui-shared/composables/fiscalIslResponse'

/**
 * Eltrade driver — protocol "ELTRADE Комуникационен протокол" v1.1.1.
 *
 * No Eltrade is attached to CI (or to the dev box this was written on), so the driver is
 * exercised against `EltradeSimulator`, which implements the protocol document — frame
 * validation, receipt state machine, status bits and the SEQ-replay rule — and takes the
 * strict reading wherever the document is loose. What the simulator cannot prove is
 * listed at the end of this file.
 */

const OK = Uint8Array.from([0x80, 0x80, 0x80, 0x80, 0x80, 0x80])

function printerFor(sim: EltradeSimulator, seq?: number) {
  const printer = new EltradeFiscalPrinter(sim.exchange, 'test-eltrade')
  // Pin the random start SEQ where a test needs to know it.
  if (seq !== undefined) (printer as any).seq = seq
  return printer
}

const UNP = 'ED123456-0001-0000001'
const cmds = (sim: EltradeSimulator) => sim.executed.map(e => e.cmd)

// ── Framing ────────────────────────────────────────────────────────────────

describe('ISL framing', () => {
  it('encodes the checksum exactly as the protocol example (1AE3h → 31 3A 3E 33)', () => {
    // 26 × FFh + FDh = 1AE3h
    const bytes = [...Array(26).fill(0xFF), 0xFD]
    expect(bytes.reduce((a, b) => a + b, 0)).toBe(0x1AE3)
    expect(islBcc(bytes, 0, bytes.length - 1)).toEqual([0x31, 0x3A, 0x3E, 0x33])
  })

  it('builds a host frame byte for byte: LEN = 20h + 4 + data, CMD without offset', () => {
    const frame = buildIslFrame(0x21, 0x4A, encodeCp1251('X'))
    // 01 LEN=25 SEQ=21 CMD=4A 'X'=58 05 | sum 25+21+4A+58+05 = EDh → 30 30 3E 3D | 03
    expect(Array.from(frame)).toEqual([0x01, 0x25, 0x21, 0x4A, 0x58, 0x05, 0x30, 0x30, 0x3E, 0x3D, 0x03])
  })

  it('refuses data the device would reject for length', () => {
    expect(() => buildIslFrame(0x21, 0x2A, new Uint8Array(214))).toThrow(/too long/)
  })

  it('splits a line full of SYN, a stale answer and the real one; drops a bad checksum', () => {
    const stale = buildIslResponseFrame(0x30, 0x31, new Uint8Array(0), OK)
    const good = buildIslResponseFrame(0x31, 0x4A, encodeCp1251('OK'), OK)
    const corrupt = Uint8Array.from(good)
    corrupt[5] ^= 0x01
    const parsed = parseIslStream(Uint8Array.from([ISL.SYN, ISL.SYN, ...stale, ISL.SYN, ...corrupt, ...good]))
    expect(parsed.syn).toBe(3)
    expect(parsed.invalid).toBe(1)
    expect(parsed.frames.map(f => f.seq)).toEqual([0x30, 0x31])
    expect(decodeCp1251(parsed.frames[1].data)).toBe('OK')
    expect(parseIslStream(Uint8Array.of(ISL.NAK)).nak).toBe(true)
  })
})

describe('Windows-1251', () => {
  it('encodes the VAT group letters and the symbols a receipt uses as single bytes', () => {
    expect(Array.from(encodeCp1251('АБВГ'))).toEqual([0xC0, 0xC1, 0xC2, 0xC3])
    expect(Array.from(encodeCp1251('№€«»'))).toEqual([0xB9, 0x88, 0xAB, 0xBB])
    expect(decodeCp1251(encodeCp1251('Болт DIN 933 М8Х25 — ZN'))).toBe('Болт DIN 933 М8Х25 — ZN')
  })

  it('degrades what the code page lacks to a base letter or "?", never to two bytes', () => {
    expect(decodeCp1251(encodeCp1251('Café'))).toBe('Cafe')
    expect(encodeCp1251('😀').length).toBe(1)
  })
})

// ── Status ─────────────────────────────────────────────────────────────────

describe('Eltrade status bits', () => {
  it('decodes the documented bits', () => {
    const s = decodeEltradeStatus(Uint8Array.from([0x80 | 0x01, 0x80 | 0x42, 0x80 | 0x29, 0x80, 0x80 | 0x06, 0x80 | 0x18]))
    expect(s.syntaxError).toBe(true)
    expect(s.notAllowed).toBe(true)
    expect(s.terminalDown).toBe(true)
    expect(s.noPaper).toBe(true)
    expect(s.fiscalReceiptOpen).toBe(true)
    expect(s.nonFiscalReceiptOpen).toBe(true)
    expect(s.serialSet && s.eikSet).toBe(true)
    expect(s.fiscalized && s.taxRatesSet).toBe(true)
  })

  it('treats the general-error and NRA-link bits as warnings, not as a failed command (ErpNet.FP #166)', () => {
    const s = decodeEltradeStatus(Uint8Array.from([0x80 | 0x20, 0x80 | 0x40, 0x80, 0x80, 0x80, 0x80]))
    expect(eltradeRejectionReasons(s, true)).toEqual([])
    expect(describeEltradeStatus(s).warnings.join()).toContain('NRA link')
  })

  it('no paper rejects a printing command only', () => {
    const s = decodeEltradeStatus(Uint8Array.from([0x80, 0x80, 0x81, 0x80, 0x80, 0x80]))
    expect(eltradeRejectionReasons(s, true)).toEqual(['out of paper'])
    expect(eltradeRejectionReasons(s, false)).toEqual([])
  })
})

describe('answer parsing', () => {
  it('finds serial and fiscal memory by shape, whatever the field count', () => {
    const seven = parseEltradeDiagnostics('ELTRADE A3 KL,BG,1.02 13Nov19 1015,21A4,00001000,ED123456,44123456')
    expect(seven).toMatchObject({ model: 'ELTRADE A3 KL', serialNumber: 'ED123456', fiscalMemoryNumber: '44123456', firmwareVersion: '1.02 13Nov19 1015' })
    const six = parseEltradeDiagnostics('FP1000KL,1.02 13Nov19 1015,FFFF,00000000,ED654321,44654321')
    expect(six).toMatchObject({ serialNumber: 'ED654321', fiscalMemoryNumber: '44654321' })
  })

  it('reads amounts with a decimal point as written and bare integers as cents', () => {
    expect(parseDeviceAmount('12.50')).toBe(12.5)
    expect(parseDeviceAmount('+1250')).toBe(12.5)
    expect(parseDeviceAmount('-000000200')).toBe(-2)
    expect(parseDeviceAmount('abc')).toBeNull()
  })

  it('splits a long product name over the two 30-character sale lines at a word', () => {
    const [a, b] = splitItemText('БОЛТ DIN 933 М8Х25 8.8 ПОЦИНКОВАН С ШАЙБА И ГАЙКА')
    expect(a.length).toBeLessThanOrEqual(30)
    expect(b!.length).toBeLessThanOrEqual(30)
    expect(`${a} ${b}`).toBe('БОЛТ DIN 933 М8Х25 8.8 ПОЦИНКОВАН С ШАЙБА И ГАЙКА')
    expect(splitItemText('Tab\there')).toEqual(['Tab here', undefined])
  })
})

// ── The time zone the device lives in ─────────────────────────────────────

describe('device clock (Europe/Sofia, not the server UTC)', () => {
  it('formats summer and winter time with the right offset', () => {
    expect(formatDeviceDateTime(new Date('2026-07-15T09:00:00Z'))).toBe('15-07-26 12:00:00')
    expect(formatDeviceDateTime(new Date('2026-01-15T09:00:00Z'))).toBe('15-01-26 11:00:00')
    // 22:30 UTC is already tomorrow in Sofia — the UTC date would be a day "in the past"
    expect(formatDeviceDateTime(new Date('2026-07-15T22:30:00Z'))).toBe('16-07-26 01:30:00')
    expect(formatDeviceIsoDateTime(new Date('2026-07-15T09:00:05Z'))).toBe('2026-07-15T12:00:05')
  })

  it('parses a device reading back to the same instant', () => {
    expect(parseDeviceDateTime('16-07-26 01:30:00')!.toISOString()).toBe('2026-07-15T22:30:00.000Z')
    expect(parseDeviceDateTime('15.01.26 11:00:00')!.toISOString()).toBe('2026-01-15T09:00:00.000Z')
    expect(parseDeviceDateTime('garbage')).toBeNull()
  })
})

// ── VAT groups (Н-18 чл. 27) ──────────────────────────────────────────────

describe('Н-18 VAT groups', () => {
  it('maps 20 % to Б for goods AND services, 9 % to Г and 0 % to А', () => {
    expect(mapTaxRateToVatGroup(20)).toBe('Б')
    expect(mapTaxRateToVatGroup(20, true)).toBe('Б')
    expect(mapTaxRateToVatGroup(9)).toBe('Г')
    expect(mapTaxRateToVatGroup(0)).toBe('А')
    expect(toVatGroup(20)).toBe('Б')
  })
})

// ── The driver against the device ─────────────────────────────────────────

describe('EltradeFiscalPrinter — non-fiscal (service) receipt', () => {
  it('opens, prints Cyrillic lines and closes', async () => {
    const sim = new EltradeSimulator()
    const p = printerFor(sim)
    await p.openNonFiscalReceipt('0001')
    await p.printNonFiscalText('ОБЩО:        24.00 EUR')
    await p.printNonFiscalText('x'.repeat(60))
    await p.closeNonFiscalReceipt()
    expect(sim.nonFiscalOpen).toBe(false)
    expect(sim.nonFiscalLines[0]).toBe('ОБЩО:        24.00 EUR')
    // what the driver SENT — the device would cut at 46 itself, but must not be relied on
    expect(sim.executed.filter(e => e.cmd === ELTRADE_CMD.PRINT_NON_FISCAL_TEXT)[1].data.length).toBe(46)
  })

  it('closes a non-fiscal receipt an interrupted sale left open before opening a new one', async () => {
    const sim = new EltradeSimulator()
    sim.nonFiscalOpen = true
    const p = printerFor(sim)
    await p.openNonFiscalReceipt('0001')
    expect(cmds(sim).filter(c => c === ELTRADE_CMD.CLOSE_NON_FISCAL)).toHaveLength(1)
    expect(sim.nonFiscalOpen).toBe(true)
  })
})

describe('EltradeFiscalPrinter — fiscal receipt', () => {
  it('opens with 90h <operator>,<УНП>, sells in group Б, pays and returns the receipt number', async () => {
    const sim = new EltradeSimulator()
    const p = printerFor(sim)
    await p.openFiscalReceipt('0001', 'Иван, Петров', UNP)
    await p.printSaleLine('Болт М8', 2, 12, 'Б', undefined, 20)
    await p.printPayment('cash', 24)
    const res = await p.closeFiscalReceipt()

    const receipt = sim.receipts[0]
    // a comma in the name would split the 90h fields — it is replaced
    expect(receipt.header.slice(0, 2)).toEqual(['Иван Петров', UNP])
    expect(receipt.sales[0]).toMatchObject({ text: 'Болт М8', group: 'Б', price: 12, quantity: 2, amount: 24 })
    expect(receipt.payments).toEqual([{ mode: 'P', amount: 24 }])
    expect(res.fiscalReceiptNumber).toBe('0000101')
  })

  it('sends a discount as a negative percentage (a positive one is a surcharge)', async () => {
    const sim = new EltradeSimulator()
    const p = printerFor(sim)
    await p.openFiscalReceipt('0001', 'Op', UNP)
    await p.printSaleLine('Гайка', 1, 10, 'Б', 10, 20)
    expect(sim.receipt!.sales[0]).toMatchObject({ percent: -10, amount: 9 })
  })

  it('pays by card with code L, never tendering more than the device total', async () => {
    const sim = new EltradeSimulator()
    const p = printerFor(sim)
    await p.openFiscalReceipt('0001', 'Op', UNP)
    await p.printSaleLine('A', 3, 0.33, 'Б', undefined, 20) // device total 0.99
    await p.printPayment('card', 1.0) // LGR computed 1.00 — a card cannot be over-tendered
    await p.closeFiscalReceipt()
    expect(sim.receipts[0].payments).toEqual([{ mode: 'L', amount: 0.99 }])
  })

  it('reads the device subtotal in either number format', async () => {
    const sim = new EltradeSimulator()
    sim.amountFormat = 'cents'
    const p = printerFor(sim)
    await p.openFiscalReceipt('0001', 'Op', UNP)
    await p.printSaleLine('A', 1, 10.5, 'Б', undefined, 20)
    await p.printPayment('card', 10.5)
    await p.closeFiscalReceipt()
    expect(sim.receipts[0].payments).toEqual([{ mode: 'L', amount: 10.5 }])
  })

  it('settles a rounding shortfall in cash instead of leaving the receipt open', async () => {
    const sim = new EltradeSimulator()
    const p = printerFor(sim)
    await p.openFiscalReceipt('0001', 'Op', UNP)
    await p.printSaleLine('A', 1, 10.01, 'Б', undefined, 20)
    await p.printPayment('cash', 10.0) // LGR total one cent below the device's
    await p.closeFiscalReceipt()
    expect(sim.receipt).toBeNull()
    expect(sim.receipts[0].payments).toEqual([{ mode: 'P', amount: 10 }, { mode: 'P', amount: 0.01 }])
  })

  it('skips further tenders once the device reports the receipt paid', async () => {
    const sim = new EltradeSimulator()
    const p = printerFor(sim)
    await p.openFiscalReceipt('0001', 'Op', UNP)
    await p.printSaleLine('A', 1, 5, 'Б', undefined, 20)
    await p.printPayment('cash', 5)
    await p.printPayment('card', 0.01)
    await p.closeFiscalReceipt()
    expect(sim.receipts[0].payments).toEqual([{ mode: 'P', amount: 5 }])
  })

  it('voids a fiscal receipt an interrupted sale left open (3Ch) before opening the next', async () => {
    const sim = new EltradeSimulator()
    sim.receipt = { kind: 'fiscal', header: [], sales: [], payments: [], total: 5, paid: 0 }
    const p = printerFor(sim)
    await p.openFiscalReceipt('0001', 'Op', UNP)
    expect(sim.receipts[0].voided).toBe(true)
    expect(sim.receipt).not.toBeNull()
  })

  it('cancelFiscalReceipt voids before payment, and completes after it (3Ch refuses then)', async () => {
    const sim = new EltradeSimulator()
    const p = printerFor(sim)
    await p.openFiscalReceipt('0001', 'Op', UNP)
    await p.printSaleLine('A', 1, 5, 'Б', undefined, 20)
    await p.cancelFiscalReceipt()
    expect(sim.receipt).toBeNull()
    expect(sim.receipts.at(-1)!.voided).toBe(true)

    await p.openFiscalReceipt('0001', 'Op', 'ED123456-0001-0000002')
    await p.printSaleLine('A', 1, 5, 'Б', undefined, 20)
    await p.printPayment('cash', 2)
    await p.cancelFiscalReceipt()
    expect(sim.receipt).toBeNull()
    expect(sim.receipts.at(-1)!.payments).toEqual([{ mode: 'P', amount: 2 }, { mode: 'P', amount: 3 }])
  })

  it('refuses a malformed УНП before talking to the device', async () => {
    const sim = new EltradeSimulator()
    const err = await captureRejection(printerFor(sim).openFiscalReceipt('0001', 'Op', '12345678-1-1'))
    expectRejection(err, /Invalid УНП/)
    expect(sim.frames).toBe(0)
  })

  it('explains a rejected УНП that names another device', async () => {
    const sim = new EltradeSimulator()
    const err = await captureRejection(printerFor(sim).openFiscalReceipt('0001', 'Op', 'ED999999-0001-0000001'))
    expectRejection(err, /set the device number in LGR to ED123456/)
  })

  it('reports why a printing command was not executed', async () => {
    const sim = new EltradeSimulator()
    sim.paper = false
    const err = await captureRejection(printerFor(sim).openFiscalReceipt('0001', 'Op', UNP))
    expectRejection(err, /out of paper/)
  })

  it('keeps working on a device with the general-error and NRA-link bits raised', async () => {
    const sim = new EltradeSimulator()
    sim.terminalDown = true
    const p = printerFor(sim)
    await p.openFiscalReceipt('0001', 'Op', UNP)
    await p.printSaleLine('A', 1, 5, 'Б', undefined, 20)
    await p.printPayment('cash', 5)
    await p.closeFiscalReceipt()
    expect(sim.receipts).toHaveLength(1)
    const status = await p.getStatus()
    expect(status.connected).toBe(true)
    expect(status.warnings!.join()).toContain('NRA link')
  })
})

describe('EltradeFiscalPrinter — VAT group checked against the device programming', () => {
  it('registers 9 % in Г', async () => {
    const sim = new EltradeSimulator()
    const p = printerFor(sim)
    await p.openFiscalReceipt('0001', 'Op', UNP)
    await p.printSaleLine('Книга', 1, 10.9, 'Г', undefined, 9)
    expect(sim.receipt!.sales[0].group).toBe('Г')
  })

  it('refuses a rate no group is programmed with, instead of booking the wrong VAT', async () => {
    const sim = new EltradeSimulator()
    const p = printerFor(sim)
    await p.openFiscalReceipt('0001', 'Op', UNP)
    const err = await captureRejection(p.printSaleLine('X', 1, 1, 'Г', undefined, 10))
    expectRejection(err, /No VAT group on the Eltrade is programmed at 10%/)
    expect(sim.receipt!.sales).toHaveLength(0)
  })
})

describe('EltradeFiscalPrinter — line discipline', () => {
  it('resends the SAME frame after a NAK', async () => {
    const sim = new EltradeSimulator()
    const p = printerFor(sim)
    await p.readDateTime()
    sim.nakNext = 1
    const before = sim.frames
    await p.readDateTime()
    expect(sim.frames - before).toBe(2)
  })

  it('never registers a sale twice when its answer is lost on the line (same-SEQ replay)', async () => {
    const sim = new EltradeSimulator()
    const p = printerFor(sim)
    await p.openFiscalReceipt('0001', 'Op', UNP)
    sim.loseNextAnswers = 1 // the device executes 31h, the answer never arrives
    await p.printSaleLine('A', 1, 5, 'Б') // no taxRate → no rate read in front of the sale
    expect(sim.receipt!.sales).toHaveLength(1)
    expect(sim.receipt!.total).toBe(5)
    expect(cmds(sim).filter(c => c === ELTRADE_CMD.SALE)).toHaveLength(1)
  })

  it('moves to a fresh SEQ when a new session collides with the last SEQ the device saw', async () => {
    const sim = new EltradeSimulator()
    // The device's last frame (previous session) was a sale under SEQ 21h …
    sim.lastSeq = 0x21
    sim.lastAnswer = buildIslResponseFrame(0x21, ELTRADE_CMD.SALE, new Uint8Array(0), OK)
    // … and this session happens to start there.
    const p = printerFor(sim, 0x00)
    await p.readDateTime()
    expect(cmds(sim)).toContain(ELTRADE_CMD.GET_STATUS) // the priming read got through after reseq
    expect(cmds(sim)).toContain(ELTRADE_CMD.GET_DATE_TIME)
  })

  it('skips a stale answer to an earlier command and SYN padding', async () => {
    const sim = new EltradeSimulator()
    const p = printerFor(sim, 0x00) // SEQs 21h, 22h, … — never the stale one's 70h
    await p.readDateTime()
    sim.synPrefix = 5
    sim.prependOnce = buildIslResponseFrame(0x70, ELTRADE_CMD.SALE, new Uint8Array(0), OK)
    const d = await p.readDateTime()
    expect(d.toISOString()).toBe('2026-07-15T09:00:00.000Z')
  })

  it('gives up with the "main menu" hint when the device never answers', async () => {
    const sim = new EltradeSimulator()
    sim.silent = true
    const err = await captureRejection(printerFor(sim).readDateTime())
    expectRejection(err, /no response from the device \(timeout\)/)
    expect(String(err.message)).toContain('main menu')
  })

  it('serializes concurrent callers so frames never interleave', async () => {
    const sim = new EltradeSimulator()
    let inFlight = 0
    let maxInFlight = 0
    const inner = sim.exchange
    const p = new EltradeFiscalPrinter(async (f) => {
      inFlight++
      maxInFlight = Math.max(maxInFlight, inFlight)
      await new Promise(r => setTimeout(r, 2))
      try { return await inner(f) } finally { inFlight-- }
    }, 'x')
    await Promise.all([p.readDateTime(), p.getStatus(), p.syncDateTime(new Date('2026-07-15T09:00:01Z'))])
    expect(maxInFlight).toBe(1)
    expect(sim.frames).toBeGreaterThan(5)
  })
})

describe('EltradeFiscalPrinter — storno', () => {
  it('opens 90h with S, the fiscal memory, reason, original number and Sofia time; lines stay positive', async () => {
    const sim = new EltradeSimulator()
    const p = printerFor(sim)
    const res = await p.printStornoReceipt(
      '0001', 'Op', 'ED123456-0001-0000009', '0000101', new Date('2026-07-15T09:00:05Z'), UNP,
      'customer_return',
      [{ name: 'Болт М8', quantity: 2, price: 12, vatGroup: 'Б', taxRate: 20 }],
      { type: 'cash', amount: 24 },
    )
    const r = sim.receipts[0]
    expect(r.kind).toBe('storno')
    // The ORIGINAL sale's УНП, not the new one
    expect(r.header).toEqual(['Op', UNP, 'S', '44123456', 'R', '0000101', '2026-07-15T12:00:05'])
    expect(r.sales[0]).toMatchObject({ quantity: 2, price: 12, amount: 24 })
    expect(res.fiscalReceiptNumber).toBe('0000101')
  })
})

describe('EltradeFiscalPrinter — reports, clock, status, operators', () => {
  it('Z-report returns the closure number; X-report does not close the day', async () => {
    const sim = new EltradeSimulator()
    const p = printerFor(sim)
    const x = await p.printDailyXReport()
    expect(x.reportNumber).toBe('0012')
    const z = await p.printDailyZReport()
    expect(z.reportNumber).toBe('0013')
    expect(sim.reports.map(r => r.data)).toEqual(['2', '0'])
  })

  it('fiscal-memory reports send both dates / zero-padded numbers', async () => {
    const sim = new EltradeSimulator()
    const p = printerFor(sim)
    await p.printFiscalMemoryReportByDate(new Date('2026-07-01T10:00:00Z'), new Date('2026-07-31T10:00:00Z'), true)
    await p.printFiscalMemoryReportByNumber(3, 12)
    expect(sim.reports).toEqual([
      { cmd: ELTRADE_CMD.DETAILED_FM_REPORT_BY_DATE, data: '010726,310726' },
      { cmd: ELTRADE_CMD.SHORT_FM_REPORT_BY_NUMBER, data: '0003,0012' },
    ])
  })

  it('sets the clock in Sofia time, skips tiny drift and refuses a big step back', async () => {
    const sim = new EltradeSimulator()
    const p = printerFor(sim)
    await p.syncDateTime(new Date('2026-07-15T09:00:02Z')) // 2 s — left alone
    expect(cmds(sim)).not.toContain(ELTRADE_CMD.SET_DATE_TIME)
    await p.syncDateTime(new Date('2026-07-15T09:10:00Z'))
    expect(sim.executed.find(e => e.cmd === ELTRADE_CMD.SET_DATE_TIME)!.data).toBe('15-07-26 12:10:00')
    const err = await captureRejection(p.syncDateTime(new Date('2026-07-15T08:00:00Z')))
    expectRejection(err, /Refusing to move the Eltrade clock back/)
  })

  it('getStatus reports identity, fiscal state and the last document', async () => {
    const sim = new EltradeSimulator()
    sim.fiscalized = false
    const s = await printerFor(sim).getStatus()
    expect(s).toMatchObject({
      connected: true, serialNumber: 'ED123456', fiscalMemoryNumber: '44123456',
      model: 'ELTRADE A3 KL', fiscalized: false, lastReceiptNumber: 100, paperPresent: true,
    })
  })

  it('programs an operator, refusing a malformed password up front (3 wrong ones lock the device)', async () => {
    const sim = new EltradeSimulator()
    const p = printerFor(sim)
    expectRejection(await captureRejection(p.programOperator(1, 'abc', 'X')), /4–8 digits/)
    await p.programOperator(2, '0000', 'Мария, Иванова')
    expect(sim.operators[2]).toBe('Мария Иванова')
  })
})

// ── The browser relay's half ──────────────────────────────────────────────

describe('IslResponseCollector (Web Serial relay)', () => {
  const answer = (seq: number) => buildIslResponseFrame(seq, 0x4A, encodeCp1251('OK'), OK)

  it('waits through SYN and chunk boundaries, stops at the answer carrying its SEQ', () => {
    const c = new IslResponseCollector(0x22)
    const a = answer(0x22)
    expect(c.push(Uint8Array.of(ISL.SYN, ISL.SYN))).toBe('more')
    expect(c.push(a.subarray(0, 7))).toBe('more')
    expect(c.push(a.subarray(7))).toBe('frame')
    expect(Array.from(c.bytes())).toEqual(Array.from(a))
  })

  it('drops a stale answer to an earlier command instead of returning it', () => {
    const c = new IslResponseCollector(0x22)
    expect(c.push(answer(0x21))).toBe('more')
    expect(c.push(answer(0x22))).toBe('frame')
    expect(c.bytes()[2]).toBe(0x22)
  })

  it('returns a bare NAK at once', () => {
    const c = new IslResponseCollector(0x22)
    expect(c.push(Uint8Array.of(ISL.NAK))).toBe('nak')
    expect(Array.from(c.bytes())).toEqual([ISL.NAK])
  })
})

/*
 * Not provable here, only on the device (see the field checklist in the Eltrade notes):
 *  - the exact 5Ah field layout of an A3 KL (parsed by shape, so either layout works);
 *  - whether 33h/35h amounts come with a decimal point (both are handled);
 *  - the printed width of a 2Ah line on 58 mm paper (the POS formats non-fiscal text to 28);
 *  - that OperName in 90h is free text (ErpNet.FP sends a name; so do we).
 */
