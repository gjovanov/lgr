import { describe, it, expect } from 'bun:test'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { VatFileError, parseDeklar, type VatRow } from 'services/biz/vat-files/codec'
import {
  annulledCells, buildVies, deklarCells, isVatPeriod, numberRows, periodBounds, vatCurrency, viesRequired, viesRows, withRowTotals,
} from 'services/biz/vat-files/rules'
import {
  VAT_FILE_NAMES, compareFiledMonth, compareFiles, generateMonthFiles, readFiledMonth, type VatFile,
} from 'services/biz/vat-files/month'

/** FR-25 §7.1, ППЗДДС Приложение № 12. Made-up rows. The filed months meet the same rules in the gate. */

const row = (cells: VatRow['cells'], overrides: Partial<VatRow> = {}): VatRow => ({
  rowNo: 1, docTypeCode: '01', docNumber: '1', docDate: new Date(Date.UTC(2026, 4, 4)),
  partnerVat: 'BG111111111', partnerName: 'ТЕСТ', description: '', code: '', cells, ...overrides,
})

const FIXTURES = join(import.meta.dir, '..', 'fixtures', 'vat-files')
const monthFiles = (period: string): VatFile[] => {
  const dir = join(FIXTURES, period, '999999999')
  return readdirSync(dir).map(name => ({ name, bytes: new Uint8Array(readFileSync(join(dir, name))) }))
}

describe('a sales row', () => {
  it('02-10 sums the bases, 02-20 the VAT', () => {
    const cells = withRowTotals({ '02-11': 100, '02-12': 200, '02-13': 300, '02-14': 400, '02-15': 500, '02-16': 600, '02-26': 700, '02-21': 20, '02-22': 40, '02-23': 3, '02-24': 27 })
    expect(cells['02-10']).toBe(2800)
    expect(cells['02-20']).toBe(90)
  })

  it('02-17, 02-18, 02-19 and 02-25 stay outside 02-10', () => {
    expect(withRowTotals({ '02-17': 100, '02-18': 200, '02-19': 300, '02-25': 400 })['02-10']).toBeUndefined()
    expect(withRowTotals({ '02-11': 1, '02-19': 300 })['02-10']).toBe(1)
  })

  it('does not believe the totals it is handed', () => {
    expect(withRowTotals({ '02-10': 999, '02-20': 999, '02-11': 100, '02-21': 20 })).toEqual({ '02-11': 100, '02-21': 20, '02-10': 100, '02-20': 20 })
  })

  it('a blank row stays blank: a total of zero is no cell at all', () => {
    expect(withRowTotals({})).toEqual({})
  })
})

describe('row numbers', () => {
  const day = (d: number) => new Date(Date.UTC(2026, 4, d))

  it('run 1..n by date, whatever came first', () => {
    const numbered = numberRows([row({}, { docNumber: 'c', docDate: day(9), rowNo: 1 }), row({}, { docNumber: 'a', docDate: day(1), rowNo: 2 }), row({}, { docNumber: 'b', docDate: day(5), rowNo: 3 })])
    expect(numbered.map(r => [r.rowNo, r.docNumber])).toEqual([[1, 'a'], [2, 'b'], [3, 'c']])
  })

  it('within a day a row keeps its place', () => {
    const numbered = numberRows([row({}, { docNumber: 'second', rowNo: 7 }), row({}, { docNumber: 'first', rowNo: 3 })])
    expect(numbered.map(r => r.docNumber)).toEqual(['first', 'second'])
  })

  it('close the gaps', () => {
    expect(numberRows([row({}, { rowNo: 4 }), row({}, { rowNo: 90 })]).map(r => r.rowNo)).toEqual([1, 2])
  })
})

describe('an annulled document', () => {
  const original = { '02-10': 100, '02-20': 20, '02-11': 100, '02-21': 20 }

  it('in its own period is blank', () => {
    expect(annulledCells(original, '202605', '202605')).toEqual({})
  })

  it('in a later period carries the original values with the opposite sign', () => {
    expect(annulledCells(original, '202605', '202606')).toEqual({ '02-10': -100, '02-20': -20, '02-11': -100, '02-21': -20 })
  })
})

describe('DEKLAR from the registers', () => {
  const sales = [row({ '02-10': 1000, '02-20': 200, '02-11': 1000, '02-21': 200 })]

  it('sums each column into its cell', () => {
    const cells = deklarCells(
      [row({ '02-10': 100, '02-20': 20, '02-11': 100, '02-21': 20 }), row({ '02-10': 50, '02-20': 10, '02-11': 50, '02-21': 10 })],
      [row({ '03-31': 40, '03-41': 8 })],
    )
    expect(cells).toMatchObject({ '01-01': 150, '01-20': 30, '01-11': 150, '01-21': 30, '01-31': 40, '01-41': 8 })
  })

  it('01-12 = Σ(02-12 + 02-26)', () => {
    expect(deklarCells([row({ '02-12': 100, '02-26': 40 })], [])['01-12']).toBe(140)
  })

  it('01-18 = Σ(02-18 + 02-25)', () => {
    expect(deklarCells([row({ '02-18': 100, '02-25': 40 })], [])['01-18']).toBe(140)
  })

  it('01-30 = Σ(03-30 + 03-44)', () => {
    expect(deklarCells([], [row({ '03-30': 100, '03-44': 40 })])['01-30']).toBe(140)
  })

  it('leaves sales types 11, 12, 13 and 04 out of the totals', () => {
    for (const docTypeCode of ['11', '12', '13', '04']) {
      expect(deklarCells([row({ '02-10': 100, '02-20': 20 }, { docTypeCode })], [])).toEqual({})
    }
    for (const docTypeCode of ['01', '02', '03', '09', '81']) {
      expect(deklarCells([row({ '02-10': 100 }, { docTypeCode })], [])['01-01']).toBe(100)
    }
  })

  it('leaves purchase types 11, 12, 13, 94 and 05 out of the totals', () => {
    for (const docTypeCode of ['11', '12', '13', '94', '05']) {
      expect(deklarCells([], [row({ '03-31': 100, '03-41': 20, '03-30': 7 }, { docTypeCode })])).toEqual({})
    }
  })

  it('01-43 lists no exclusion: an annual correction counts whatever its document', () => {
    expect(deklarCells([], [row({ '03-43': 100 }, { docTypeCode: '94' })])['01-43']).toBe(100)
  })

  it('01-40 = 41 + 42 × 33 + 43', () => {
    const cells = deklarCells([], [row({ '03-41': 1000, '03-42': 500 }), row({ '03-43': 25 })], { '01-33': 80 })
    expect(cells['01-40']).toBe(1000 + 400 + 25)
    expect(cells['01-33']).toBe(80)
  })

  it('01-40 rounds half up, on a value and on its reversal alike', () => {
    expect(deklarCells([], [row({ '03-42': 150 })], { '01-33': 33 })['01-40']).toBe(50) // 49.5
    expect(deklarCells([], [row({ '03-42': -150 })], { '01-33': 33 })['01-40']).toBe(-50)
  })

  it('a partial credit with no coefficient credits nothing', () => {
    expect(deklarCells([], [row({ '03-42': 500 })])['01-40']).toBeUndefined()
  })

  it('payable is output less credit, and paid in full by default', () => {
    const cells = deklarCells(sales, [row({ '03-41': 150 })])
    expect(cells).toMatchObject({ '01-40': 150, '01-50': 50, '01-71': 50 })
    expect(cells['01-60']).toBeUndefined()
  })

  it('refundable is credit less output, and there is nothing to pay', () => {
    const cells = deklarCells(sales, [row({ '03-41': 350 })])
    expect(cells['01-60']).toBe(150)
    expect(cells['01-50']).toBeUndefined()
    expect(cells['01-71']).toBeUndefined()
  })

  it('tax set off under чл. 92 leaves the rest to be paid', () => {
    expect(deklarCells(sales, [], { '01-70': 150 })).toMatchObject({ '01-50': 200, '01-70': 150, '01-71': 50 })
  })

  it('output equal to credit: a nil result, with neither cell', () => {
    const cells = deklarCells(sales, [row({ '03-41': 200 })])
    expect(cells['01-50']).toBeUndefined()
    expect(cells['01-60']).toBeUndefined()
  })

  it('carries what a person declares for a refund', () => {
    expect(deklarCells(sales, [row({ '03-41': 350 })], { '01-81': 150 })['01-81']).toBe(150)
  })

  it('no documents: no cells, a nil return', () => {
    expect(deklarCells([], [])).toEqual({})
  })
})

describe('VIES', () => {
  const eu = (cells: VatRow['cells'], partnerVat = 'DE000000000') => row(cells, { partnerVat })
  const declarant = { id: '0000000000', name: 'ИВАН ПРИМЕРОВ', city: 'София', postcode: '1000', address: 'ул. Примерна 1', kind: 'A' }
  const company = { vatId: 'BG999999999', name: 'ПРИМЕРНА ЕООД', address: 'София' }

  it('is called for by ВОД, triangular supplies and чл. 21(2) services', () => {
    expect(viesRequired([eu({ '02-15': 100 })])).toBe(true)
    expect(viesRequired([eu({ '02-25': 100 })])).toBe(true)
    expect(viesRequired([eu({ '02-17': 100 })])).toBe(true)
  })

  it('is not called for by a ВОП, or by anything else', () => {
    expect(viesRequired([eu({ '02-12': 100, '02-22': 20 })])).toBe(false)
    expect(viesRequired([row({ '02-11': 100 })])).toBe(false)
    expect(viesRequired([])).toBe(false)
  })

  it('has one row per recipient, summing that recipient, in the register\'s order', () => {
    const rows = viesRows([
      eu({ '02-15': 100 }, 'FR000000000'),
      eu({ '02-15': 50 }, 'DE000000000'),
      row({ '02-11': 999 }),
      eu({ '02-15': 25, '02-17': 10 }, 'FR000000000'),
      eu({ '02-25': 7 }, 'DE000000000'),
    ])
    expect(rows).toEqual([
      { rowNo: 1, partnerVat: 'FR000000000', goods: 125, triangular: 0, services: 10 },
      { rowNo: 2, partnerVat: 'DE000000000', goods: 50, triangular: 7, services: 0 },
    ])
  })

  it('a credit note takes off its recipient', () => {
    expect(viesRows([eu({ '02-15': 100 }), eu({ '02-15': -30 })])[0].goods).toBe(70)
  })

  it('TTR: the base of everything, then of the goods alone', () => {
    const vies = buildVies('202605', [eu({ '02-15': 100, '02-17': 20 }), eu({ '02-25': 3 }, 'FR000000000')], declarant, company)
    expect(vies.total).toBe(123)
    expect(vies.goods).toBe(100)
  })
})

describe('the period', () => {
  it('is a month', () => {
    expect(isVatPeriod('202605')).toBe(true)
    for (const bad of ['202613', '202600', '20265', '2026-05', '', '../x']) expect(isVatPeriod(bad)).toBe(false)
  })

  it('has its first and last day', () => {
    expect(periodBounds('202402').to.toISOString()).toBe('2024-02-29T00:00:00.000Z')
    expect(periodBounds('202612').from.toISOString()).toBe('2026-12-01T00:00:00.000Z')
    expect(periodBounds('202612').to.toISOString()).toBe('2026-12-31T00:00:00.000Z')
  })

  it('is in leva up to 2025 and in euro from 2026', () => {
    expect(vatCurrency('202512')).toBe('BGN')
    expect(vatCurrency('202601')).toBe('EUR')
  })
})

describe('a whole month, against the golden files', () => {
  it('regenerates every file byte for byte, from the rows and who filed', () => {
    const compared = compareFiledMonth(monthFiles('202605'))
    expect(compared.map(c => [c.name.toUpperCase(), c.differing])).toEqual(expect.arrayContaining([['DEKLAR.TXT', 0], ['PRODAGBI.TXT', 0], ['POKUPKI.TXT', 0], ['VIES.TXT', 0]]))
    expect(compared).toHaveLength(4)
  })

  it('a nil return regenerates too: no rows, and no VIES', () => {
    const compared = compareFiledMonth(monthFiles('202606'))
    expect(compared.map(c => c.differing)).toEqual([0, 0, 0])
    const month = readFiledMonth(monthFiles('202606'))
    expect(generateMonthFiles(month).map(f => [f.name, f.bytes.length])).toEqual([[VAT_FILE_NAMES.deklar, 592], [VAT_FILE_NAMES.prodagbi, 0], [VAT_FILE_NAMES.pokupki, 0]])
  })

  it('reads no total, so regenerating arrives at them by itself', () => {
    const month = readFiledMonth(monthFiles('202605'))
    expect(Object.keys(month.declared)).toEqual([])
    expect(JSON.stringify(month)).not.toContain('01-50')
  })

  it('hand-worked totals: type 12 and type 11 stay out, 02-19 stays out of 01-01', () => {
    const month = readFiledMonth(monthFiles('202605'))
    const deklar = parseDeklar(generateMonthFiles(month)[0].bytes)
    expect(deklar.cells).toEqual({
      '01-01': 155000, '01-20': 25300, '01-11': 105000, '01-21': 21000, '01-12': 20000, '01-22': 4000, '01-23': 300,
      '01-15': 30000, '01-19': 7000, '01-30': 1500, '01-31': 65000, '01-41': 13000, '01-40': 13000, '01-50': 12300, '01-71': 12300,
    })
    expect(deklar.salesRows).toBe(9) // counted in the register, excluded from the totals
    expect(deklar.purchaseRows).toBe(6)
  })

  it('a month with intra-EU supplies and no declarant is refused, not filed without one', () => {
    const { vies: _vies, ...month } = readFiledMonth(monthFiles('202605'))
    let error: unknown
    try { generateMonthFiles(month) } catch (e) { error = e }
    expect(error).toBeInstanceOf(VatFileError)
  })
})

describe('the comparison can fail: it does not echo what it read', () => {
  const months = (period: string) => monthFiles(period).map(f => ({ name: f.name, bytes: f.bytes.slice() }))
  const named = (files: VatFile[], name: string) => files.find(f => f.name === name)!
  const differs = (files: VatFile[]) => compareFiledMonth(files).filter(c => c.differing).map(c => [c.name, c.only ?? c.differing])
  const SALES_AT = (record: number, end: number) => record * 426 + end - 1
  const DIGIT = 0x35

  it('a total changed in DEKLAR alone is not believed', () => {
    const files = months('202605')
    named(files, 'DEKLAR.txt').bytes[499 - 3] = DIGIT // 01-50's last whole digit
    expect(differs(files)).toEqual([['DEKLAR.txt', 1]])
  })

  it('a row total changed alone is not believed', () => {
    const files = months('202605')
    named(files, 'PRODAGBI.txt').bytes[SALES_AT(0, 197) - 3] = DIGIT // 02-20 of the first row
    expect(differs(files)).toEqual([['PRODAGBI.txt', 1]])
  })

  it('a value changed in a register moves the return with it', () => {
    const files = months('202605')
    named(files, 'PRODAGBI.txt').bytes[SALES_AT(0, 227) - 3] = DIGIT // 02-21 of the first row
    expect(differs(files)).toEqual(expect.arrayContaining([['DEKLAR.txt', 1], ['PRODAGBI.txt', 1]]))
  })

  it('a VIES total changed alone is not believed', () => {
    const files = months('202605')
    named(files, 'VIES.txt').bytes[15 + 2 + 373 + 2 + 368 + 2 + 14 - 3] = 0x34
    expect(differs(files)).toEqual([['VIES.txt', 1]])
  })

  it('a month that calls for VIES and has none says so, and one that has one it need not says so', () => {
    expect(differs(months('202605').filter(f => f.name !== 'VIES.txt'))).toEqual([['VIES.txt', 'regenerated']])
    const stray = [...months('202606'), named(months('202605'), 'VIES.txt')]
    expect(differs(stray)).toEqual([['VIES.txt', 'filed']])
  })

  it('reports counts, never what differs', () => {
    const files = months('202605')
    named(files, 'POKUPKI.txt').bytes[SALES_AT(0, 300)] = DIGIT
    const report = JSON.stringify(compareFiles(files, monthFiles('202605')))
    expect(report).not.toContain('ДОСТАВЧИК')
    expect(report).not.toContain('500.00')
  })
})
