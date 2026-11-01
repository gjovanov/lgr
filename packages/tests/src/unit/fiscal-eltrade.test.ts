import { describe, it, expect } from 'bun:test'
import { captureRejection, expectRejection } from '../helpers/capture-rejection'
import { EltradeSimulator, validFmReportData } from '../helpers/eltrade-simulator'
import {
  EltradeFiscalPrinter,
  decodeEltradeStatus,
  describeEltradeStatus,
  eltradeRejectionReasons,
  parseEltradeDiagnostics,
  parseDeviceAmount,
  parsePaymentNameAnswer,
  splitItemText,
  ELTRADE_CMD,
  ELTRADE_PAYMENT_SLOTS,
} from 'fiscal/eltrade'
import { DatecsFiscalPrinter } from 'fiscal/datecs'
import { TremolFiscalPrinter } from 'fiscal/tremol'
import { WebSocketFiscalPrinter } from 'fiscal/ws-fiscal-printer'
import { WsTremolFiscalPrinter } from 'fiscal/ws-tremol-printer'
import { buildIslFrame, buildIslResponseFrame, islBcc, parseIslStream, ISL } from 'fiscal/isl-frame'
import { encodeCp1251, decodeCp1251 } from 'fiscal/cp1251'
import { formatDeviceDateTime, formatDeviceIsoDateTime, parseDeviceDateTime } from 'fiscal/zoned-time'
import { mapTaxRateToVatGroup } from 'fiscal/vat-groups'
import { FiscalPaymentMethodError, toFiscalPaymentType, toVatGroup } from 'fiscal/types'
import { IslResponseCollector } from 'ui-shared/composables/fiscalIslResponse'

/**
 * Eltrade driver — protocol "ELTRADE Комуникационен протокол" v1.1.1, re-checked against v1.1.7.
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

describe('EltradeFiscalPrinter — free text inside a fiscal receipt (36h, FR-23)', () => {
  const UNP = 'ED123456-0001-0000001'

  it('prints it where the receipt stands, in Windows-1251, between the lines and the payment', async () => {
    const sim = new EltradeSimulator()
    const p = printerFor(sim)
    await p.openFiscalReceipt('0001', 'Иван', UNP)
    await p.printSaleLine('Болт', 1, 12, 'Б', undefined, 20)
    await p.printFiscalText('Фактура № INV-2026-00123')
    await p.printPayment('cash', 12)
    await p.closeFiscalReceipt()
    expect(sim.receipts).toHaveLength(1)
    expect(sim.receipts[0].texts).toEqual(['Фактура № INV-2026-00123'])
    expect(sim.receipts[0].total).toBe(12)
  })

  it('sends at most 46 characters and no control characters: the device reads those as separators', async () => {
    const sim = new EltradeSimulator()
    const p = printerFor(sim)
    await p.openFiscalReceipt('0001', 'Иван', UNP)
    await p.printFiscalText(`ред\t${'x'.repeat(60)}`)
    const sent = sim.executed.find(e => e.cmd === ELTRADE_CMD.PRINT_FISCAL_TEXT)!.data
    expect(sent.length).toBe(46)
    expect(sent).not.toContain('\t')
  })

  it('is refused with no fiscal receipt open, and a service receipt is not one', async () => {
    const sim = new EltradeSimulator()
    const p = printerFor(sim)
    const none = await captureRejection(p.printFiscalText('Фактура № 1'))
    expect(String((none as Error).message)).toContain('not allowed')

    await p.openNonFiscalReceipt('0001')
    const text = await captureRejection(p.printFiscalText('Фактура № 1'))
    expect(String((text as Error).message)).toContain('not allowed')
    expect(sim.executed.some(e => e.cmd === ELTRADE_CMD.PRINT_FISCAL_TEXT)).toBe(false)
  })

  it('is a printing command: no paper, no text', async () => {
    const sim = new EltradeSimulator()
    const p = printerFor(sim)
    await p.openFiscalReceipt('0001', 'Иван', UNP)
    sim.paper = false
    const out = await captureRejection(p.printFiscalText('Фактура № 1'))
    expect(String((out as Error).message)).toContain('out of paper')
  })
})

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

  describe('what cancelling says it did (FR-23, the second review, finding 2)', () => {
    const open = async (sim: EltradeSimulator) => {
      const p = printerFor(sim)
      await p.openFiscalReceipt('0001', 'Op', UNP)
      await p.printSaleLine('A', 1, 5, 'Б', undefined, 20)
      return p
    }

    it('voided: it saw a receipt open, and 3Ch took it', async () => {
      const sim = new EltradeSimulator()
      const p = await open(sim)
      expect(await p.cancelFiscalReceipt()).toBe('voided')
      expect(sim.receipts.at(-1)!.voided).toBe(true)
    })

    it('finished: it saw one open, 3Ch was refused, and the close went through', async () => {
      const sim = new EltradeSimulator()
      const p = await open(sim)
      await p.printPayment('cash', 2)
      expect(await p.cancelFiscalReceipt()).toBe('finished')
      expect(sim.receipts.at(-1)!.voided).toBeFalsy()
    })

    it('finished at a line too: 3Ch refused with no payment made, and a real receipt closed', async () => {
      const sim = new EltradeSimulator()
      const p = await open(sim)
      sim.refuseVoids = 1
      expect(await p.cancelFiscalReceipt()).toBe('finished')
      expect(sim.receipts.at(-1)!.voided).toBeFalsy()
    })

    it('neither: nothing is open, as after a close whose answer was lost, and 3Ch is never sent', async () => {
      const sim = new EltradeSimulator()
      const p = printerFor(sim)
      await p.openFiscalReceipt('0001', 'Op', UNP)
      await p.printSaleLine('A', 1, 5, 'Б', undefined, 20)
      await p.printPayment('cash', 6)
      await p.closeFiscalReceipt()
      const before = sim.frames

      expect(await p.cancelFiscalReceipt()).toBeUndefined()

      expect(sim.frames).toBe(before + 1)
      expect(sim.receipts.at(-1)!.voided).toBeFalsy()
    })

    it('neither: an open flag it cannot read is no sight of one, whatever 3Ch then does', async () => {
      const sim = new EltradeSimulator()
      let failStatus = false
      const p = new EltradeFiscalPrinter(async (f) => {
        if (failStatus && Buffer.from(f)[3] === 0x4A) throw new Error('Fiscal bridge disconnected')
        return sim.exchange(f)
      }, 'flaky')
      await p.openFiscalReceipt('0001', 'Op', UNP)
      await p.printSaleLine('A', 1, 5, 'Б', undefined, 20)
      failStatus = true

      expect(await p.cancelFiscalReceipt()).toBeUndefined()

      expect(sim.receipts.at(-1)!.voided).toBe(true)
    })

    it('finished, though the flag could not be read: 3Ch said it is still open, so it was, and the fallback closed it', async () => {
      const sim = new EltradeSimulator()
      let failStatus = false
      const p = new EltradeFiscalPrinter(async (f) => {
        if (failStatus && Buffer.from(f)[3] === 0x4A) throw new Error('Fiscal bridge disconnected')
        return sim.exchange(f)
      }, 'flaky')
      await p.openFiscalReceipt('0001', 'Op', UNP)
      await p.printSaleLine('A', 1, 5, 'Б', undefined, 20)
      await p.printPayment('cash', 2)
      failStatus = true

      expect(await p.cancelFiscalReceipt()).toBe('finished')
    })

    it('finished: the fallback lost its answer, so a receipt may be on the device', async () => {
      const sim = new EltradeSimulator()
      const p = await open(sim)
      await p.printPayment('cash', 2)
      sim.beforeCommand = (cmd) => { if (cmd === 0x38) sim.dropAfter = 0x38 }

      expect(await p.cancelFiscalReceipt()).toBe('finished')
    })

    it('neither: the fallback\'s close was refused, and the receipt is still open', async () => {
      const sim = new EltradeSimulator()
      const p = await open(sim)
      await p.printPayment('cash', 2)
      sim.beforeCommand = (cmd) => { if (cmd === 0x38) sim.paper = false }

      expect(await p.cancelFiscalReceipt()).toBeUndefined()
      expect(sim.receipt).not.toBeNull()
    })

    it('a storno leaves it to its caller, who has to hear what cancelling did', async () => {
      const sim = new EltradeSimulator()
      const p = printerFor(sim)
      sim.beforeCommand = (cmd) => { if (cmd === 0x35) sim.paper = false }

      await captureRejection(p.printStornoReceipt(
        '0001', 'Op', 'ED123456-0001-0000009', '0000101', new Date('2026-07-15T09:00:05Z'), UNP, 'customer_return',
        [{ name: 'A', quantity: 1, price: 6, vatGroup: 'Б', taxRate: 20 }], { type: 'cash', amount: 6 },
      ))

      expect(sim.receipt).not.toBeNull()
      expect(await p.cancelFiscalReceipt()).toBe('voided')
    })
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
    expect(sim.operators[2]).toEqual({ name: 'Мария Иванова', password: '0000' })
  })
})

// ── A report and an open receipt ──────────────────────────────────────────

/** A sale in progress on the device, as the POS leaves it between two commands. */
async function saleInProgress(sim: EltradeSimulator, paid = 0) {
  const p = printerFor(sim)
  await p.openFiscalReceipt('0001', 'Op', UNP)
  await p.printSaleLine('Болт М8', 2, 12, 'Б', undefined, 20)
  if (paid) await p.printPayment('cash', paid)
  return p
}

/**
 * A driver whose exchange runs `onFrame` before each frame reaches the device, e.g. to queue a
 * report while a given command is on the wire.
 */
function printerWatching(sim: EltradeSimulator, onFrame: (frame: Uint8Array, p: EltradeFiscalPrinter) => void) {
  const p: EltradeFiscalPrinter = new EltradeFiscalPrinter(async (frame) => {
    onFrame(frame, p)
    return sim.exchange(frame)
  }, 'watched')
  return p
}

/** The commands the device executed after `from`, the status reads left out. */
const after = (sim: EltradeSimulator, from: number) =>
  sim.executed.slice(from).map(e => e.cmd).filter(c => c !== ELTRADE_CMD.GET_STATUS)

describe('EltradeFiscalPrinter — a report while THIS driver is printing a receipt: refused', () => {
  const touchedReceipt = [ELTRADE_CMD.CANCEL_FISCAL, ELTRADE_CMD.TOTAL, ELTRADE_CMD.CLOSE_FISCAL, ELTRADE_CMD.CLOSE_NON_FISCAL]

  it('refuses the X-report during a sale, and voids nothing', async () => {
    const sim = new EltradeSimulator()
    const p = await saleInProgress(sim)
    const before = sim.executed.length
    const err = await captureRejection(p.printDailyXReport())
    expectRejection(err, /^A sale is printing on this device, so the X-report was not printed\. Wait for it to finish, then try again\.$/)
    expect(err.kind).toBe('busy')
    const after = sim.executed.slice(before).map(e => e.cmd)
    expect(after).toEqual([ELTRADE_CMD.GET_STATUS]) // the check, and nothing else
    expect(sim.receipt!.sales).toHaveLength(1)
    expect(sim.receipts).toEqual([])
  })

  it('refuses the Z-report on a part-paid receipt instead of completing it in cash', async () => {
    const sim = new EltradeSimulator()
    const p = await saleInProgress(sim, 5)
    const closure = sim.closure
    const err = await captureRejection(p.printDailyZReport())
    expectRejection(err, /A sale is printing on this device, so the Z-report was not printed/)
    expect(sim.executed.map(e => e.cmd).filter(c => touchedReceipt.includes(c as any) && c !== ELTRADE_CMD.TOTAL)).toEqual([])
    expect(sim.receipt!.payments).toEqual([{ mode: 'P', amount: 5 }]) // the 5 paid, no cash remainder added
    expect(sim.closure).toBe(closure)
    expect(sim.reports).toEqual([])

    // The sale finishes; then the day closes.
    await p.printPayment('cash', 19)
    await p.closeFiscalReceipt()
    expect((await p.printDailyZReport()).reportNumber).toBe(String(closure + 1).padStart(4, '0'))
  })

  it('refuses every report while it prints a service (text) receipt, and leaves it open', async () => {
    const sim = new EltradeSimulator()
    const p = printerFor(sim)
    await p.openNonFiscalReceipt('0001')
    const reports: [string, () => Promise<unknown>][] = [
      ['X-report', () => p.printDailyXReport()],
      ['Z-report', () => p.printDailyZReport()],
      ['fiscal-memory report', () => p.printFiscalMemoryReportByDate(new Date('2026-07-01T10:00:00Z'), new Date('2026-07-31T10:00:00Z'))],
      ['fiscal-memory report', () => p.printFiscalMemoryReportByDate(new Date('2026-07-01T10:00:00Z'), new Date('2026-07-31T10:00:00Z'), true)],
      ['fiscal-memory report', () => p.printFiscalMemoryReportByNumber(1, 2)],
      ['fiscal-memory report', () => p.printFiscalMemoryReportByNumber(1, 2, true)],
    ]
    for (const [what, run] of reports) {
      expectRejection(await captureRejection(run()), new RegExp(`^A service \\(non-fiscal\\) receipt is printing on this device, so the ${what} was not printed`))
    }
    expect(sim.nonFiscalOpen).toBe(true)
    expect(cmds(sim).filter(c => touchedReceipt.includes(c as any))).toEqual([])
    expect(sim.reports).toEqual([])
  })

  it('checks and prints in one turn of the queue: a receipt opened meanwhile waits for the report', async () => {
    const sim = new EltradeSimulator()
    let p!: EltradeFiscalPrinter
    let racer: Promise<unknown> | null = null
    p = new EltradeFiscalPrinter(async (frame) => {
      // While the report's status check is on the wire (the priming read is frame 0), another
      // caller opens a receipt with a single command — the step a sale's 90h would be.
      if (frame[3] === ELTRADE_CMD.GET_STATUS && sim.frames > 0 && !racer) {
        racer = (p as any).request(ELTRADE_CMD.OPEN_NON_FISCAL, '', { timeoutMs: 1000 })
      }
      return sim.exchange(frame)
    }, 'race')
    const x = await p.printDailyXReport()
    await racer
    expect(x.reportNumber).toBe('0012')
    expect(sim.reports).toEqual([{ cmd: ELTRADE_CMD.DAILY_REPORT, data: '2' }])
    expect(sim.nonFiscalOpen).toBe(true)
    const order = cmds(sim)
    expect(order.indexOf(ELTRADE_CMD.DAILY_REPORT)).toBeLessThan(order.indexOf(ELTRADE_CMD.OPEN_NON_FISCAL))
  })

  it('a Z queued while the sale\'s 90h is on the wire is refused, never voids the receipt being opened', async () => {
    const sim = new EltradeSimulator()
    let report: Promise<any> | null = null
    let ownedWhenSent: boolean | null = null
    const p = printerWatching(sim, (frame, p) => {
      if (frame[3] !== ELTRADE_CMD.OPEN_FISCAL || report) return
      ownedWhenSent = (p as any).receipt !== null // counted as this driver's BEFORE 90h is sent
      report = captureRejection(p.printDailyZReport())
    })
    await p.openFiscalReceipt('0001', 'Op', UNP)
    const err = await report!
    expect(ownedWhenSent).toBe(true)
    expectRejection(err, /A sale is printing on this device, so the Z-report was not printed/)
    expect(err.kind).toBe('busy')
    expect(sim.receipt).toMatchObject({ kind: 'fiscal', header: ['Op', UNP] })
    expect(sim.receipts).toEqual([])
    expect(sim.closure).toBe(12)

    // The sale goes on to its end; then the day closes.
    await p.printSaleLine('Болт М8', 2, 12, 'Б', undefined, 20)
    await p.printPayment('cash', 24)
    await p.closeFiscalReceipt()
    expect((await p.printDailyZReport()).reportNumber).toBe('0013')
    expect(sim.receipts.map(r => r.voided)).toEqual([undefined])
  })

  it('the same for 26h: a report queued behind a service receipt\'s open never closes it', async () => {
    const sim = new EltradeSimulator()
    let report: Promise<any> | null = null
    let ownedWhenSent: boolean | null = null
    const p = printerWatching(sim, (frame, p) => {
      if (frame[3] !== ELTRADE_CMD.OPEN_NON_FISCAL || report) return
      ownedWhenSent = (p as any).textReceipt === true
      report = captureRejection(p.printDailyXReport())
    })
    await p.openNonFiscalReceipt('0001')
    const err = await report!
    expect(ownedWhenSent).toBe(true)
    expectRejection(err, /A service \(non-fiscal\) receipt is printing on this device, so the X-report was not printed/)
    expect(sim.nonFiscalOpen).toBe(true)
    expect(cmds(sim)).not.toContain(ELTRADE_CMD.CLOSE_NON_FISCAL)
    await p.printNonFiscalText('ОБЩО')
    await p.closeNonFiscalReceipt()
    expect(sim.nonFiscalLines).toEqual(['ОБЩО'])
  })

  it('a service receipt during a sale (a session report reprinted) is refused, and the sale stands', async () => {
    const sim = new EltradeSimulator()
    const p = await saleInProgress(sim)
    const before = sim.executed.length
    const err = await captureRejection(p.openNonFiscalReceipt('0001'))
    expectRejection(err, /^A sale is printing on this device, so the service receipt was not printed\. Wait for it to finish, then try again\.$/)
    expect(err.kind).toBe('busy')
    expect(sim.executed.length).toBe(before) // nothing reached the device
    expect(sim.receipt).toMatchObject({ kind: 'fiscal' })
    expect((p as any).textReceipt).toBe(false)

    // The sale goes on to its end, and the service receipt prints after it.
    await p.printPayment('cash', sim.receipt!.total)
    await p.closeFiscalReceipt()
    expect(sim.receipts.map(r => r.voided)).toEqual([undefined])
    await p.openNonFiscalReceipt('0001')
    await p.printNonFiscalText('ОТЧЕТ')
    await p.closeNonFiscalReceipt()
    expect(sim.nonFiscalLines).toEqual(['ОТЧЕТ'])
  })

  it('a report queued ahead of the 27h that closes a service receipt is refused, and the close still succeeds', async () => {
    // Were the receipt let go when 27h is asked for rather than once it has run, this report
    // would close it first, and the till's own 27h would fail on a receipt that printed whole.
    const sim = new EltradeSimulator()
    let report: Promise<any> | null = null
    const p = printerWatching(sim, (frame, p) => {
      if (frame[3] === ELTRADE_CMD.PRINT_NON_FISCAL_TEXT && !report) report = captureRejection(p.printDailyXReport())
    })
    await p.openNonFiscalReceipt('0001')
    await p.printNonFiscalText('ОБЩО')
    await p.closeNonFiscalReceipt() // queued behind the report
    expectRejection(await report!, /service \(non-fiscal\) receipt is printing on this device/)
    expect(sim.nonFiscalOpen).toBe(false)
    expect(cmds(sim).filter(c => c === ELTRADE_CMD.CLOSE_NON_FISCAL)).toHaveLength(1)
    expect((await p.printDailyXReport()).reportNumber).toBe('0012') // and afterwards it prints
  })
})

describe('EltradeFiscalPrinter — a receipt nothing will finish: the report clears it, then prints', () => {
  it('a sale\'s receipt left by a driver that is gone (the bridge dropped mid-sale): the Z voids it and closes the day', async () => {
    const sim = new EltradeSimulator()
    await saleInProgress(sim) // ...and that driver is never heard from again
    const reconnected = printerFor(sim) // a reconnect registers a NEW driver
    const before = sim.executed.length
    const z = await reconnected.printDailyZReport()
    expect(z.reportNumber).toBe('0013')
    expect(sim.closure).toBe(13)
    expect(sim.receipt).toBeNull()
    expect(sim.receipts).toEqual([expect.objectContaining({ kind: 'fiscal', header: ['Op', UNP], voided: true })])
    expect(after(sim, before)).toEqual([ELTRADE_CMD.CANCEL_FISCAL, ELTRADE_CMD.DAILY_REPORT])
  })

  it('a part-paid one cannot be voided (3Ch refuses it): it is completed in cash, then the Z prints', async () => {
    const sim = new EltradeSimulator()
    await saleInProgress(sim, 5)
    const before = sim.executed.length
    const z = await printerFor(sim).printDailyZReport()
    expect(z.reportNumber).toBe('0013')
    expect(z.totalSales).toBe(24) // the completed receipt is in the day it closes
    expect(sim.receipt).toBeNull()
    expect(sim.receipts).toEqual([expect.objectContaining({ payments: [{ mode: 'P', amount: 5 }, { mode: 'P', amount: 19 }] })])
    expect(sim.receipts[0].voided).toBeUndefined()
    expect(after(sim, before)).toEqual([ELTRADE_CMD.TOTAL, ELTRADE_CMD.CLOSE_FISCAL, ELTRADE_CMD.DAILY_REPORT])
  })

  it('a service receipt left open on the device: the X closes it, then prints', async () => {
    const sim = new EltradeSimulator()
    sim.nonFiscalOpen = true // e.g. a text receipt the server stopped in the middle of
    const before = sim.executed.length
    const x = await printerFor(sim).printDailyXReport()
    expect(x.reportNumber).toBe('0012')
    expect(sim.nonFiscalOpen).toBe(false)
    expect(sim.closure).toBe(12) // an X closes nothing
    expect(sim.reports).toEqual([{ cmd: ELTRADE_CMD.DAILY_REPORT, data: '2' }])
    expect(after(sim, before)).toEqual([ELTRADE_CMD.CLOSE_NON_FISCAL, ELTRADE_CMD.DAILY_REPORT])
  })

  it('the same driver, when the void of a failed sale never reached the device', async () => {
    const sim = new EltradeSimulator()
    let gone = false
    const p = new EltradeFiscalPrinter(async (f) => {
      if (gone) throw new Error('Fiscal bridge disconnected')
      return sim.exchange(f)
    }, 'flaky')
    await p.openFiscalReceipt('0001', 'Op', UNP)
    await p.printSaleLine('Болт М8', 2, 12, 'Б', undefined, 20)
    gone = true
    // The payment fails, and so does the till's void of it (abandonReceipt → cancelFiscalReceipt).
    expect((await captureRejection(p.printPayment('cash', 24)))?.kind).toBe('unreachable')
    expect((await captureRejection(p.cancelFiscalReceipt()))?.kind).toBe('unreachable')
    expect(sim.receipt).not.toBeNull()

    gone = false
    expect((await p.printDailyZReport()).reportNumber).toBe('0013')
    expect(sim.receipts).toEqual([expect.objectContaining({ voided: true })])
  })

  it('a service receipt whose line failed, its caller stopping without closing it', async () => {
    const sim = new EltradeSimulator()
    const p = printerFor(sim)
    await p.openNonFiscalReceipt('0001')
    sim.paper = false
    expect((await captureRejection(p.printNonFiscalText('ОБЩО')))?.kind).toBe('rejected')
    sim.paper = true // a new roll; the receipt is still open
    expect(sim.nonFiscalOpen).toBe(true)
    expect((await p.printDailyXReport()).reportNumber).toBe('0012')
    expect(sim.nonFiscalOpen).toBe(false)
  })
})

describe('EltradeFiscalPrinter — what every report sends', () => {
  it('X 45h "2", Z 45h "0"; fiscal memory by date 4Fh/5Eh, by number 5Fh/49h', async () => {
    const sim = new EltradeSimulator()
    const p = printerFor(sim)
    await p.printDailyXReport()
    await p.printDailyZReport()
    // 22:30 UTC on the 31st is already 1 August in Sofia: the device's days, not the server's.
    await p.printFiscalMemoryReportByDate(new Date('2026-07-01T10:00:00Z'), new Date('2026-07-31T22:30:00Z'))
    await p.printFiscalMemoryReportByDate(new Date('2026-07-01T10:00:00Z'), new Date('2026-07-31T10:00:00Z'), true)
    await p.printFiscalMemoryReportByNumber(3, 12)
    await p.printFiscalMemoryReportByNumber(1, 9999, true)
    expect(sim.reports).toEqual([
      { cmd: ELTRADE_CMD.DAILY_REPORT, data: '2' },
      { cmd: ELTRADE_CMD.DAILY_REPORT, data: '0' },
      { cmd: ELTRADE_CMD.SHORT_FM_REPORT_BY_DATE, data: '010726,010826' },
      { cmd: ELTRADE_CMD.DETAILED_FM_REPORT_BY_DATE, data: '010726,310726' },
      { cmd: ELTRADE_CMD.SHORT_FM_REPORT_BY_NUMBER, data: '0003,0012' },
      { cmd: ELTRADE_CMD.DETAILED_FM_REPORT_BY_NUMBER, data: '0001,9999' },
    ])
  })

  it('refuses a period or a number range the device cannot take, with nothing sent', async () => {
    const sim = new EltradeSimulator()
    const p = printerFor(sim)
    const bad: [() => Promise<unknown>, RegExp][] = [
      [() => p.printFiscalMemoryReportByNumber(0, 5), /whole numbers from 1 to 9999/],
      [() => p.printFiscalMemoryReportByNumber(5, 3), /the first no greater than the last/],
      [() => p.printFiscalMemoryReportByNumber(1.5, 3), /whole numbers/],
      [() => p.printFiscalMemoryReportByNumber(1, 10000), /from 1 to 9999/],
      [() => p.printFiscalMemoryReportByNumber(Number.NaN, 3), /whole numbers/],
      [() => p.printFiscalMemoryReportByDate(new Date('2026-07-31T10:00:00Z'), new Date('2026-07-01T10:00:00Z')), /starts \(2026-07-31\) after it ends \(2026-07-01\)/],
      [() => p.printFiscalMemoryReportByDate(new Date('nonsense'), new Date('2026-07-01T10:00:00Z')), /both dates are needed/],
    ]
    for (const [run, why] of bad) {
      const err = await captureRejection(run())
      expectRejection(err, why)
      expect(err.kind).toBe('input')
    }
    expect(sim.frames).toBe(0)
  })

  it('reports why a fiscal-memory report did not print when the paper is out', async () => {
    const sim = new EltradeSimulator()
    const p = printerFor(sim)
    sim.paper = false
    const err = await captureRejection(p.printFiscalMemoryReportByNumber(1, 5))
    expectRejection(err, /out of paper/)
    expect(err.kind).toBe('rejected')
    expect(sim.reports).toEqual([])
  })
})

describe('EltradeSimulator — the report periods the protocol spells (v1.1.7)', () => {
  it('takes DDMMYY,DDMMYY and the month (MMYY) and year (YY) forms; NNNN,NNNN by number', () => {
    const ok: [number, string][] = [
      [0x4F, '010726,310726'], [0x4F, '0726'], [0x4F, '26'], [0x5E, '#*010726,310726'], [0x5E, '0726'],
      [0x5F, '0001,0012'], [0x49, '0001,0012'], [0x49, '#*0001,0012'], [0x49, ''],
    ]
    for (const [cmd, data] of ok) expect({ cmd, data, ok: validFmReportData(cmd, data) }).toEqual({ cmd, data, ok: true })
    const refused: [number, string][] = [
      [0x4F, '310226,310326'], [0x4F, '310726,010726'], [0x4F, '1326'], [0x4F, '01-07-26,31-07-26'], [0x4F, ''],
      [0x5F, '12,13'], [0x5F, '0013,0012'], [0x5F, ''], [0x49, '#'], [0x5E, '#*'],
    ]
    for (const [cmd, data] of refused) expect({ cmd, data, ok: validFmReportData(cmd, data) }).toEqual({ cmd, data, ok: false })
  })
})

describe('EltradeFiscalPrinter — operators 1–16 (66h)', () => {
  it('refuses operator 0 and 17, and an empty name, with nothing sent', async () => {
    const sim = new EltradeSimulator()
    const p = printerFor(sim)
    for (const n of [0, 17, 1.5]) {
      const err = await captureRejection(p.programOperator(n, '1234', 'Иван'))
      expectRejection(err, /numbered 1–16/)
      expect(err.kind).toBe('input')
    }
    expectRejection(await captureRejection(p.programOperator(3, '1234', ' , ')), /operator's name/)
    expect(sim.frames).toBe(0)
  })

  it('programs operator 16; the password it was given authenticates the next change', async () => {
    const sim = new EltradeSimulator()
    const p = printerFor(sim)
    await p.programOperator(16, '123456', 'Петър Петров')
    expect(sim.operators[16]).toEqual({ name: 'Петър Петров', password: '123456' })
    const err = await captureRejection(p.programOperator(16, '654321', 'Друго име'))
    expectRejection(err, /not allowed in the current state/)
    expect(err.kind).toBe('rejected')
    expect(sim.operators[16].name).toBe('Петър Петров')
    await p.programOperator(16, '123456', 'Петър Иванов')
    expect(sim.operators[16].name).toBe('Петър Иванов')
  })

  it('the simulator blocks after three wrong passwords until it is switched off and on', async () => {
    const sim = new EltradeSimulator()
    const p = printerFor(sim)
    await p.programOperator(1, '1111', 'Op')
    for (let i = 0; i < 3; i++) await captureRejection(p.programOperator(1, '2222', 'Op'))
    expect(sim.locked).toBe(true)
    expectRejection(await captureRejection(p.printDailyXReport()), /not allowed in the current state/)
    sim.powerCycle()
    expect((await p.printDailyXReport()).reportNumber).toBe('0012')
  })
})

describe('EltradeFiscalPrinter — payment type names (55h)', () => {
  it('reads all 11 slots in device order, with the LGR payment each one carries', async () => {
    const sim = new EltradeSimulator()
    const names = await printerFor(sim).readPaymentNames()
    expect(names.map(n => n.code)).toEqual(['P', 'N', 'C', 'D', 'I', 'J', 'K', 'L', 'M', 'Q', 'R'])
    expect(names.map(n => n.code)).toEqual([...ELTRADE_PAYMENT_SLOTS])
    expect(names.find(n => n.code === 'P')).toEqual({ code: 'P', name: 'В БРОЙ', type: 'cash' })
    expect(names.find(n => n.code === 'L')).toEqual({ code: 'L', name: 'КАРТА', type: 'card' })
    expect(names.find(n => n.code === 'R')).toEqual({ code: 'R', name: 'РЕЗЕРВ', type: 'cash_on_delivery' })
    expect(names.find(n => n.code === 'M')).toEqual({ code: 'M', name: 'БАНКА' })
    expect(sim.executed.filter(e => e.cmd === ELTRADE_CMD.PAYMENT_NAME).map(e => e.data)).toEqual([...ELTRADE_PAYMENT_SLOTS])
  })

  it('takes a read answered as "P\\<name>" as well as a bare name', async () => {
    const sim = new EltradeSimulator()
    sim.paymentNameAnswer = 'prefixed'
    const names = await printerFor(sim).readPaymentNames()
    expect(names.find(n => n.code === 'L')!.name).toBe('КАРТА')
    expect(parsePaymentNameAnswer('P')).toEqual({ result: 'P' })
    expect(parsePaymentNameAnswer('F')).toEqual({ result: 'F' })
    expect(parsePaymentNameAnswer('P,НАЛОЖЕН ПЛАТЕЖ')).toEqual({ result: 'P', name: 'НАЛОЖЕН ПЛАТЕЖ' })
    expect(parsePaymentNameAnswer('КАРТА ')).toEqual({ name: 'КАРТА' })
  })

  it('names the reserve slot „НАЛОЖЕН ПЛАТЕЖ" and answers with what the device then reports', async () => {
    const sim = new EltradeSimulator()
    const named = await printerFor(sim).programPaymentName('r', 'НАЛОЖЕН ПЛАТЕЖ')
    expect(named).toEqual({ code: 'R', name: 'НАЛОЖЕН ПЛАТЕЖ', type: 'cash_on_delivery', previous: 'РЕЗЕРВ' })
    expect(sim.paymentNames.R).toBe('НАЛОЖЕН ПЛАТЕЖ')
    // read, set, read back
    expect(sim.executed.filter(e => e.cmd === ELTRADE_CMD.PAYMENT_NAME).map(e => e.data)).toEqual(['R', 'R,НАЛОЖЕН ПЛАТЕЖ', 'R'])
  })

  it('refuses a slot that is not one of the 11, and a name over 20 characters, with nothing sent', async () => {
    const sim = new EltradeSimulator()
    const p = printerFor(sim)
    const errs = [
      await captureRejection(p.programPaymentName('X', 'КАРТА')),
      await captureRejection(p.programPaymentName('R', 'НАЛОЖЕН ПЛАТЕЖ С ДОСТАВКА')),
      await captureRejection(p.programPaymentName('R', '  ')),
    ]
    expectRejection(errs[0], /payment types are P, N, C, D, I, J, K, L, M, Q, R/)
    expectRejection(errs[1], /1–20 characters, got 25/)
    expectRejection(errs[2], /1–20 characters, got 0/)
    expect(errs.map(e => e.kind)).toEqual(['input', 'input', 'input'])
    expect(sim.frames).toBe(0)
  })

  it('a device that does not answer fails at the first read — no name is sent, no second wait', async () => {
    const sim = new EltradeSimulator()
    const p = printerFor(sim)
    await p.readDateTime() // connected and primed
    sim.silent = true
    const err = await captureRejection(p.programPaymentName('R', 'НАЛОЖЕН ПЛАТЕЖ'))
    expect(err.kind).toBe('timeout')
    expect(sim.paymentNames.R).toBe('РЕЗЕРВ')
    expect(sim.executed.filter(e => e.cmd === ELTRADE_CMD.PAYMENT_NAME)).toEqual([])
  })

  it('a read-back that fails after the device said P still reports the name as set', async () => {
    const sim = new EltradeSimulator()
    let sets = 0
    const run = (sim as any).run.bind(sim)
    ;(sim as any).run = (cmd: number, text: string, flags: any) => {
      if (cmd === ELTRADE_CMD.PAYMENT_NAME && text.includes(',')) sets++
      // After the name is set, the device garbles the read: a syntax error on 55h.
      if (cmd === ELTRADE_CMD.PAYMENT_NAME && sets && !text.includes(',')) { flags.syntax = true; return '' }
      return run(cmd, text, flags)
    }
    const named = await printerFor(sim).programPaymentName('R', 'НАЛОЖЕН ПЛАТЕЖ')
    expect(named).toEqual({ code: 'R', name: 'НАЛОЖЕН ПЛАТЕЖ', type: 'cash_on_delivery', previous: 'РЕЗЕРВ' })
    expect(sim.paymentNames.R).toBe('НАЛОЖЕН ПЛАТЕЖ')
  })

  it('reports the device refusing the name (answer F)', async () => {
    const sim = new EltradeSimulator()
    const run = (sim as any).run.bind(sim)
    ;(sim as any).run = (cmd: number, text: string, flags: any) => (cmd === ELTRADE_CMD.PAYMENT_NAME && text.includes(',') ? 'F' : run(cmd, text, flags))
    const err = await captureRejection(printerFor(sim).programPaymentName('R', 'НАЛОЖЕН ПЛАТЕЖ'))
    expectRejection(err, /refused "НАЛОЖЕН ПЛАТЕЖ" as the name of payment type R/)
    expect(err.kind).toBe('rejected')
    expect(sim.paymentNames.R).toBe('РЕЗЕРВ')
  })
})

describe('toFiscalPaymentType: what a receipt can carry, and no default', () => {
  it('maps the till\'s methods; a mobile payment is a card payment to a device', () => {
    expect(['cash', 'card', 'mobile', 'voucher', 'cash_on_delivery'].map(toFiscalPaymentType))
      .toEqual(['cash', 'card', 'card', 'voucher', 'cash_on_delivery'])
  })

  it('refuses everything else with a typed error, where it used to answer cash', () => {
    for (const method of ['bank_transfer', 'other', 'check', 'crypto', '', 'constructor', 'CASH']) {
      const refused = (() => {
        try {
          return toFiscalPaymentType(method)
        } catch (e) {
          return e
        }
      })()
      expect(refused).toBeInstanceOf(FiscalPaymentMethodError)
      expect((refused as FiscalPaymentMethodError).method).toBe(method)
    }
  })

  it('says it in words', () => {
    expect(new FiscalPaymentMethodError('bank_transfer').message).toContain('"bank transfer"')
  })
})

describe('cash on delivery (FiscalPaymentType "cash_on_delivery")', () => {
  it('the till maps it to its own type, never to cash', () => {
    expect(toFiscalPaymentType('cash_on_delivery')).toBe('cash_on_delivery')
    expect(toFiscalPaymentType('cash')).toBe('cash')
  })

  it('an Eltrade prints it in the reserve slot R, never tendering more than is due', async () => {
    const sim = new EltradeSimulator()
    const p = printerFor(sim)
    await p.openFiscalReceipt('0001', 'Op', UNP)
    await p.printSaleLine('Болт М8', 2, 12, 'Б', undefined, 20)
    await p.printPayment('cash_on_delivery', 24.01)
    await p.closeFiscalReceipt()
    expect(sim.receipts[0].payments).toEqual([{ mode: 'R', amount: 24 }])
  })

  it('an Eltrade storno paid back on delivery carries R too', async () => {
    const sim = new EltradeSimulator()
    await printerFor(sim).printStornoReceipt(
      '0001', 'Op', 'ED123456-0001-0000009', '0000101', new Date('2026-07-15T09:00:05Z'), UNP, 'customer_return',
      [{ name: 'Болт М8', quantity: 2, price: 12, vatGroup: 'Б', taxRate: 20 }], { type: 'cash_on_delivery', amount: 24 },
    )
    expect(sim.receipts[0].payments).toEqual([{ mode: 'R', amount: 24 }])
  })

  it('every driver without a slot refuses it before sending anything — never prints it as cash', async () => {
    const sent: unknown[] = []
    const send = async (frame: Buffer) => { sent.push(frame); return Buffer.alloc(0) }
    const datecs = new DatecsFiscalPrinter({ type: 'tcp', tcp: { ip: '127.0.0.1', port: 1 } }, 'd')
    ;(datecs as any).transport.sendCommand = async (...a: unknown[]) => { sent.push(a); return '' }
    const drivers = [
      ['Datecs', datecs],
      ['Datecs', new WebSocketFiscalPrinter(send, 'w')],
      ['Tremol', new WsTremolFiscalPrinter(send, 't')],
      ['Tremol', new TremolFiscalPrinter({ type: 'tcp', tcp: { ip: '127.0.0.1', port: 1 } } as any, 't2')],
    ] as const
    ;((drivers[3][1] as any).transport).sendCommand = async (...a: unknown[]) => { sent.push(a); return '' }
    for (const [name, driver] of drivers) {
      const pay = await captureRejection(driver.printPayment('cash_on_delivery', 10))
      expectRejection(pay, new RegExp(`LGR's ${name} driver has no payment type for cash on delivery`))
      expect(pay.name).toBe('FiscalUnsupportedError')
      const storno = await captureRejection(driver.printStornoReceipt(
        '0001', 'Op', UNP, '0000101', new Date(), UNP, 'customer_return',
        [{ name: 'A', quantity: 1, price: 10, vatGroup: 'Б' }], { type: 'cash_on_delivery', amount: 10 },
      ))
      expectRejection(storno, /no payment type for cash on delivery/)
    }
    expect(sent).toEqual([])
  })
})

describe('EltradeFiscalPrinter — how a lost transport fails', () => {
  it('a bridge that is gone is unreachable; one that gave up waiting is a timeout', async () => {
    const gone = new EltradeFiscalPrinter(async () => { throw new Error('Fiscal bridge disconnected') }, 'x')
    expect((await captureRejection(gone.readDateTime())).kind).toBe('unreachable')
    const slow = new EltradeFiscalPrinter(async () => { throw new Error('Fiscal bridge command timeout (60000ms)') }, 'x')
    expect((await captureRejection(slow.readDateTime())).kind).toBe('timeout')
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
