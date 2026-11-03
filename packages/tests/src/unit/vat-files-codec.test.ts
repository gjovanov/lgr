import { describe, it, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { encodeCp1251 } from 'fiscal/cp1251'
import {
  DEKLAR_LAYOUT, REGISTER_LAYOUT, VIES_LAYOUT, layoutWidth,
} from 'services/biz/vat-files/layouts'
import {
  VatFileError, emitDeklar, emitRecord, emitRegister, emitVies, formatDocDate, formatMoney, parseDeklar, parseDocDate,
  parseMoney, parseRegister, parseVies, type VatRow,
} from 'services/biz/vat-files/codec'

/**
 * FR-25 §7.1, §7.2: the NRA's files, byte for byte. The golden files under `fixtures/vat-files` are made
 * up (every partner, number and amount) and were written by a separate fixed-width script, so a bug
 * here cannot also be in them. Real files never enter this repo: `scripts/compare-vat-files.ts` meets
 * those on the private folder.
 */

const GOLDEN = join(import.meta.dir, '..', 'fixtures', 'vat-files', '202605', '999999999')
const golden = (name: string) => new Uint8Array(readFileSync(join(GOLDEN, name)))

const row = (overrides: Partial<VatRow> = {}): VatRow => ({
  rowNo: 1, docTypeCode: '01', docNumber: '1', docDate: new Date(Date.UTC(2026, 4, 4)),
  partnerVat: '', partnerName: '', description: '', code: '', cells: {}, ...overrides,
})
const failure = (fn: () => unknown): VatFileError => {
  try { fn() } catch (e) { return e as VatFileError }
  throw new Error('expected a refusal')
}

describe('the layouts', () => {
  it('add up to the widths in the annex', () => {
    expect(layoutWidth(DEKLAR_LAYOUT)).toBe(590)
    expect(layoutWidth(REGISTER_LAYOUT.sales)).toBe(424)
    expect(layoutWidth(REGISTER_LAYOUT.purchase)).toBe(274)
    expect(layoutWidth(VIES_LAYOUT.VHR)).toBe(15)
    expect(layoutWidth(VIES_LAYOUT.VDR)).toBe(373)
    expect(layoutWidth(VIES_LAYOUT.VTR)).toBe(368)
    expect(layoutWidth(VIES_LAYOUT.TTR)).toBe(27)
    expect(layoutWidth(VIES_LAYOUT.VIR)).toBe(66)
  })
})

describe('amounts are integer cents', () => {
  it('reads and writes without a float in between', () => {
    expect(parseMoney('1234.56')).toBe(123456)
    expect(parseMoney('-0.07')).toBe(-7)
    expect(parseMoney('19.99')).toBe(1999) // 19.99 * 100 is 1998.9999999999998 as a float
    expect(parseMoney('12')).toBe(1200)
    expect(parseMoney('12.5')).toBe(1250)
    expect(formatMoney(123456)).toBe('1234.56')
    expect(formatMoney(-7)).toBe('-0.07')
    expect(formatMoney(5)).toBe('0.05')
  })

  it('refuses what is not an amount in two decimals, and does not print a value doing it', () => {
    for (const bad of ['12.345', '1,50', '1e5', 'abc', '--1', '12.']) {
      const e = failure(() => parseMoney(bad, '02-10', 3))
      expect(e).toBeInstanceOf(VatFileError)
      expect(e.message).toBe('02-10 in record 3 is not an amount')
    }
    expect(failure(() => formatMoney(12.5)).message).not.toContain('12.5')
  })
})

describe('dates', () => {
  it('are the calendar day at UTC midnight, there and back', () => {
    const day = parseDocDate('29/02/2024')
    expect(day.toISOString()).toBe('2024-02-29T00:00:00.000Z')
    expect(formatDocDate(day)).toBe('29/02/2024')
  })

  it('refuses a day the calendar does not have', () => {
    for (const bad of ['31/02/2026', '00/01/2026', '2026-01-01', '1/1/2026', '']) expect(failure(() => parseDocDate(bad))).toBeInstanceOf(VatFileError)
  })
})

describe('a record', () => {
  const layout = [
    { code: 'T', width: 6, kind: 'text' as const },
    { code: 'C', width: 3, kind: 'count' as const },
    { code: 'M', width: 8, kind: 'money' as const },
  ]

  it('aligns text left and numbers right, and a zero amount is blank', () => {
    expect(emitRecord({ T: 'ab', C: 7, M: 1250 }, layout)).toBe('ab      7   12.50')
    expect(emitRecord({ T: 'ab', C: 7, M: 0 }, layout)).toBe('ab      7        ')
    expect(emitRecord({ T: 'ab', C: 7 }, layout)).toBe('ab      7        ')
  })

  it('prints a zero count, because a row count is a required field', () => {
    expect(emitRecord({ T: '', C: 0 }, layout)).toBe('        0        ')
  })

  it('prints a zero amount only where the layout says: VIES does', () => {
    expect(emitRecord({ 'TTR-1': 'TTR', 'TTR-2': 0, 'TTR-3': 0 }, VIES_LAYOUT.TTR)).toBe('TTR        0.00        0.00')
  })

  it('refuses a value that does not fit, rather than truncating', () => {
    const e = failure(() => emitRecord({ T: 'too long' }, layout, 4))
    expect(e.message).toBe('T in record 4 does not fit its 6 characters')
    expect(e.field).toBe('T')
    expect(e.record).toBe(4)
    expect(failure(() => emitRecord({ M: 123456789 }, layout)).field).toBe('M')
    expect(failure(() => emitRecord({ C: 1000 }, layout)).field).toBe('C')
  })

  it('refuses a character outside Windows-1251, rather than degrading it', () => {
    for (const bad of ['é', 'ß', '€uro漢', '😀']) {
      const e = failure(() => emitRecord({ T: bad }, layout, 2))
      expect(e.message).toBe('T in record 2 has a character Windows-1251 cannot carry')
    }
    // These the code page has.
    expect(emitRecord({ T: '€ №–' }, layout).slice(0, 6)).toBe('€ №–  ')
  })

  it('refuses a control character, which would split the record', () => {
    expect(failure(() => emitRecord({ T: 'a\r\nb' }, layout))).toBeInstanceOf(VatFileError)
    expect(failure(() => emitRecord({ T: 'a\tb' }, layout))).toBeInstanceOf(VatFileError)
  })
})

describe('the golden files, parsed and emitted again', () => {
  const same = (a: Uint8Array, b: Uint8Array) => expect(Buffer.compare(a, b)).toBe(0)

  it('PRODAGBI', () => {
    const bytes = golden('PRODAGBI.txt')
    const register = parseRegister('sales', bytes)
    expect(register.vatId).toBe('BG999999999')
    expect(register.period).toBe('202605')
    expect(register.rows).toHaveLength(9)
    expect(register.rows[0].cells).toEqual({ '02-10': 10000, '02-20': 2000, '02-11': 10000, '02-21': 2000 })
    expect(register.rows[1].cells['02-10']).toBe(-5000)
    expect(register.rows[6].cells).toEqual({}) // annulled in its own period: blank
    same(emitRegister('sales', register), bytes)
  })

  it('keeps text as filed: an inner double space, a dash outside А-я', () => {
    const rows = parseRegister('sales', golden('PRODAGBI.txt')).rows
    expect(rows[3].partnerName).toBe('BEISPIEL  GMBH')
    expect(rows[8].description).toBe('Стоки – каса')
    expect(rows[8].partnerVat).toBe('999999999999999')
  })

  it('POKUPKI', () => {
    const bytes = golden('POKUPKI.txt')
    const register = parseRegister('purchase', bytes)
    expect(register.rows).toHaveLength(6)
    expect(register.rows[0].cells).toEqual({ '03-31': 50000, '03-41': 10000 })
    same(emitRegister('purchase', register), bytes)
  })

  it('DEKLAR', () => {
    const bytes = golden('DEKLAR.txt')
    const declaration = parseDeklar(bytes)
    expect(declaration).toMatchObject({ vatId: 'BG999999999', name: 'ПРИМЕРНА ТЪРГОВИЯ ЕООД', period: '202605', filer: 'ИВАН ПРИМЕРОВ', salesRows: 9, purchaseRows: 6 })
    expect(declaration.cells['01-50']).toBe(12300)
    same(emitDeklar(declaration), bytes)
  })

  it('VIES', () => {
    const bytes = golden('VIES.txt')
    const vies = parseVies(bytes)
    expect(vies.period).toBe('202605')
    expect(vies.declarant).toMatchObject({ name: 'ИВАН ПЕТРОВ ПРИМЕРОВ', postcode: '1000', kind: 'A' })
    expect(vies.company.vatId).toBe('BG999999999')
    expect(vies.total).toBe(30000)
    expect(vies.rows).toEqual([{ rowNo: 1, partnerVat: 'DE000000000', goods: 30000, triangular: 0, services: 0 }])
    same(emitVies(vies), bytes)
  })

  it('VIES with call-off stock: the sections after the recipients', () => {
    const vies = {
      ...parseVies(golden('VIES.txt')),
      callOff: [{ rowNo: 1, recipientVat: 'DE000000000', operation: 1, taxPeriod: '05/2026' }, { rowNo: 2, recipientVat: 'FR000000000', operation: 3, replacedVat: 'DE000000000' }],
    }
    const emitted = emitVies(vies)
    expect(parseVies(emitted).callOff).toEqual(vies.callOff)
    const records = new TextDecoder('windows-1251').decode(emitted).split('\r\n')
    expect(records[5]).toBe('CHR    2')
    expect(records[6].length).toBe(layoutWidth(VIES_LAYOUT.COS))
  })
})

describe('a file', () => {
  it('a register with no documents has no records, and no bytes', () => {
    const empty = emitRegister('sales', { vatId: 'BG999999999', period: '202606', rows: [] })
    expect(empty.length).toBe(0)
    expect(parseRegister('sales', empty).rows).toEqual([])
  })

  it('ends every record with CRLF, the last one too', () => {
    const bytes = emitRegister('purchase', { vatId: 'BG999999999', period: '202605', rows: [row({ cells: { '03-31': 100 } }), row({ rowNo: 2, cells: { '03-31': 200 } })] })
    expect(bytes.length).toBe(2 * (274 + 2))
    expect([...bytes.slice(-2)]).toEqual([0x0D, 0x0A])
    expect([...bytes.slice(274, 276)]).toEqual([0x0D, 0x0A])
  })

  it('refuses a record of another length, or a last record with no CRLF', () => {
    const bytes = golden('POKUPKI.txt')
    expect(failure(() => parseRegister('purchase', bytes.slice(0, -2))).message).toContain('CRLF')
    expect(failure(() => parseRegister('sales', bytes)).message).toBe('Record 1 is 274 characters, its layout 424')
  })

  it('refuses a byte the code page does not define', () => {
    const bytes = golden('POKUPKI.txt')
    bytes[20] = 0x98
    expect(failure(() => parseRegister('purchase', bytes)).message).toContain('does not define')
  })

  it('refuses a register that names two companies or periods', () => {
    const a = emitRegister('sales', { vatId: 'BG999999999', period: '202605', rows: [row()] })
    const b = emitRegister('sales', { vatId: 'BG999999999', period: '202606', rows: [row()] })
    const both = new Uint8Array([...a, ...b])
    expect(failure(() => parseRegister('sales', both)).message).toBe('Record 2 names another company or period than the first')
  })

  it('refuses DEKLAR with anything but one record', () => {
    const one = golden('DEKLAR.txt')
    expect(failure(() => parseDeklar(new Uint8Array([...one, ...one]))).message).toContain('holds 2 records')
  })

  it('refuses a VIES whose header counts other rows than it has', () => {
    const vies = parseVies(golden('VIES.txt'))
    const text = new TextDecoder('windows-1251').decode(emitVies(vies)).replace('VHR05/2026    1', 'VHR05/2026    2')
    expect(failure(() => parseVies(encodeCp1251(text))).message).toContain('VHR counts')
  })
})

describe('emission refuses what the NRA would', () => {
  const emit = (cells: VatRow['cells']) => emitRegister('sales', { vatId: 'BG999999999', period: '202605', rows: [row({ cells })] })

  it('a record that mixes signs', () => {
    expect(failure(() => emit({ '02-10': 100, '02-20': -20 })).message).toBe('Record 1 mixes positive and negative values')
  })

  it('accepts one sign, either way', () => {
    expect(emit({ '02-10': -100, '02-20': -20 }).length).toBe(426)
  })

  it('a cell the register has no column for, which would otherwise vanish', () => {
    expect(failure(() => emit({ '03-31': 100 })).message).toBe('Record 1 has a cell its register does not: 03-31')
  })

  it('names the field and the record, never the value', () => {
    const e = failure(() => emitRegister('sales', { vatId: 'BG999999999', period: '202605', rows: [row(), row({ rowNo: 2, partnerName: 'Я'.repeat(51) })] }))
    expect(e.message).toBe('02-08 in record 2 does not fit its 50 characters')
  })
})

describe('the one codec', () => {
  it('fiscal and services read the same table', async () => {
    const fromFiscal = await import('fiscal/cp1251')
    const fromConfig = await import('config/cp1251')
    expect(fromFiscal.encodeCp1251).toBe(fromConfig.encodeCp1251)
  })
})
