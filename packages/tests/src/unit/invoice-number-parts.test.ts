import { describe, it, expect } from 'bun:test'
import {
  numberPartsOf, ownNumberParts, withDerivedFields, withNumberParts, withoutDerivedFields,
} from 'db/plugins/invoice-number-parts'

/**
 * #929: the ONE parse of a document number into its head and running number, which every writer stores and the
 * numbering reads instead of scanning the org's numbers.
 *
 * The second block holds it to the scan it replaces: for every number, every prefix set and both kinds of series, "the
 * scan's pattern matches, with this value" must be exactly "the stored head passes the head pattern, with this
 * running number". The two patterns are written here as `invoice-numbering.service.ts` writes them.
 */

const none = { numberHead: '', numberSeq: null }

describe('numberPartsOf: the formats', () => {
  const cases: Array<[unknown, { numberHead: string; numberSeq: number | null }]> = [
    // A yearly series, padded to five or to seven digits.
    ['INV-2026-00012', { numberHead: 'INV-2026', numberSeq: 12 }],
    ['INV-2026-0000123', { numberHead: 'INV-2026', numberSeq: 123 }],
    // A continuous one: ten digits, no year.
    ['INV-0000000124', { numberHead: 'INV', numberSeq: 124 }],
    ['INV-3000004106', { numberHead: 'INV', numberSeq: 3000004106 }],
    // A prefix with a dash in it: cut at the LAST dash.
    ['DRF-INV-2026-00007', { numberHead: 'DRF-INV-2026', numberSeq: 7 }],
    ['DRF-CN-2026-00001', { numberHead: 'DRF-CN-2026', numberSeq: 1 }],
    // The register's, the bills', the legacy notes'.
    ['CS-2026-0000001', { numberHead: 'CS-2026', numberSeq: 1 }],
    ['BILL-2026-00012', { numberHead: 'BILL-2026', numberSeq: 12 }],
    ['CRN-2025-00050', { numberHead: 'CRN-2025', numberSeq: 50 }],
    // An imported number: `${prefix}-${reference}`, no year, no padding.
    ['INV-815', { numberHead: 'INV', numberSeq: 815 }],
    // A number whose year group could be a running number: the head keeps it, the reader decides.
    ['INV-2026', { numberHead: 'INV', numberSeq: 2026 }],
    ['INV-000', { numberHead: 'INV', numberSeq: 0 }],
    ['-5', { numberHead: '', numberSeq: 5 }],
    // No running number.
    ['~pending:7f3c2a', none],
    ['~pending:doc:65f0c0ffee0000000000abcd', none],
    ['0001234', none],
    ['INV-2026-12A', none],
    ['INV-2026-', none],
    ['INV-2026-00123\n', none],
    ['INV-+12', none],
    ['INV-1.5', none],
    ['INV-١٢٣', none],
    [`INV-${'9'.repeat(400)}`, none],
    ['', none],
    [undefined, none],
    [null, none],
    [12345, none],
  ]
  for (const [number, want] of cases) {
    it(`${JSON.stringify(number)} → ${JSON.stringify(want)}`, () => {
      expect(numberPartsOf(number)).toEqual(want)
    })
  }
})

// ── the scan it replaces, and the head reading, as the numbering service writes them ──
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
function seriesPattern(prefixes: string[], year: number | null): RegExp {
  const head = `^(?:${prefixes.map(escapeRe).join('|')})-`
  return new RegExp(year === null ? `${head}(?:\\d{4}-)?(\\d+)$` : `${head}${year}-(\\d+)$`)
}
function seriesHeadPattern(prefixes: string[], year: number | null): RegExp {
  const head = `^(?:${prefixes.map(escapeRe).join('|')})`
  return new RegExp(year === null ? `${head}(?:-\\d{4})?$` : `${head}-${year}$`)
}
/** What the scan counted a number as: the piece after the last dash as a double, 0 when it fails. */
function scanned(number: string, re: RegExp): number | null {
  if (!re.test(number)) return null
  const n = Number(number.split('-').pop())
  return Number.isFinite(n) ? n : 0
}
function stored(number: string, re: RegExp): number | null {
  const p = numberPartsOf(number)
  return p.numberSeq !== null && re.test(p.numberHead) ? p.numberSeq : null
}

describe('the head reading is the scan', () => {
  const prefixSets = [['INV', 'CRN', 'DBN'], ['FAK', 'INV'], ['DRF-INV'], ['CS'], ['A.B', 'X|Y'], ['INV-2026'], ['']]
  const years = [2026, 2025, null]
  const numbers = [
    'INV-2026-00012', 'INV-2026-0000123', 'INV-0000000124', 'INV-2025-00999', 'INV-2025-1000', 'INV-815', 'INV-2026',
    'INV-12345-00001', 'INV-123-00001', 'INV-2026-2026-00001', 'CRN-2026-00050', 'DBN-2025-00007', 'FAK-0000000300',
    'DRF-INV-2026-00007', 'DRF-INV-00007', 'XINV-2026-00001', 'INV-2026-00012A', 'INV-2026-', 'INV', 'INV-',
    '~pending:abc', '0001234', 'CS-2026-0000001', 'CS-0000000002', 'A.B-2026-00001', 'AxB-2026-00001', 'X|Y-00009',
    'INV-2026-00001-00002', '-2026-00001', '-00004', 'inv-2026-00001', 'INV-2026-00012\n', 'INV-0000',
  ]
  for (const prefixes of prefixSets) {
    for (const year of years) {
      it(`${JSON.stringify(prefixes)}, ${year === null ? 'continuous' : `yearly ${year}`}`, () => {
        const scan = seriesPattern(prefixes, year)
        const heads = seriesHeadPattern(prefixes, year)
        // Where the scan counted 0 (a conversion that failed), the stored reading counts nothing: the max is the same.
        const differ = numbers.filter(n => (scanned(n, scan) || null) !== (stored(n, heads) || null))
        expect(differ).toEqual([])
      })
    }
  }
})

describe('an update keeps the parts with the number', () => {
  it('a number set in $set, at the top level or in $setOnInsert gets its parts beside it', () => {
    const a: Record<string, any> = { $set: { invoiceNumber: 'INV-2026-00009', status: 'sent' } }
    ownNumberParts(a)
    expect(a.$set).toEqual({ invoiceNumber: 'INV-2026-00009', status: 'sent', numberHead: 'INV-2026', numberSeq: 9 })
    const b: Record<string, any> = { invoiceNumber: '~pending:k' }
    ownNumberParts(b)
    expect(b).toEqual({ invoiceNumber: '~pending:k', numberHead: '', numberSeq: null })
    const c: Record<string, any> = { $setOnInsert: { invoiceNumber: 'CS-2026-0000004' } }
    ownNumberParts(c)
    expect(c.$setOnInsert).toMatchObject({ numberHead: 'CS-2026', numberSeq: 4 })
  })

  it('a value an update names for the parts is dropped, whatever operator names it', () => {
    const u: Record<string, any> = {
      numberSeq: 1e12, $set: { numberHead: 'INV', numberSeq: 1e12, notes: 'x' }, $inc: { numberSeq: 5 }, $max: { numberSeq: 9e9 }, $unset: { numberHead: 1 },
    }
    ownNumberParts(u)
    expect(u).toEqual({ $set: { notes: 'x' }, $inc: {}, $max: {}, $unset: {} })
  })

  it('a number removed leaves no running number; a pipeline is left alone', () => {
    const u: Record<string, any> = { $unset: { invoiceNumber: 1 } }
    ownNumberParts(u)
    expect(u.$set).toEqual(none)
    const pipeline = [{ $set: { invoiceNumber: 'INV-2026-00001' } }]
    ownNumberParts(pipeline)
    expect(pipeline).toEqual([{ $set: { invoiceNumber: 'INV-2026-00001' } }])
  })
})

describe('the copiers', () => {
  it('derive for invoices only, from the number, over whatever the document carried', () => {
    expect(withNumberParts({ invoiceNumber: 'INV-0000000124', numberHead: 'DRF-INV-2026', numberSeq: 3 })).toEqual({ invoiceNumber: 'INV-0000000124', numberHead: 'INV', numberSeq: 124 })
    expect(withDerivedFields('invoices', { invoiceNumber: 'INV-2026-00001' })).toMatchObject({ numberHead: 'INV-2026', numberSeq: 1 })
    const contact = { companyName: 'A-1' }
    expect(withDerivedFields('contacts', contact)).toBe(contact)
  })

  it('leave the derived fields out of what two servers compare', () => {
    expect(withoutDerivedFields('invoices', { _id: 1, invoiceNumber: 'INV-1', numberHead: 'INV', numberSeq: 1 })).toEqual({ _id: 1, invoiceNumber: 'INV-1' })
    const doc = { _id: 1, invoiceNumber: 'INV-1' }
    expect(withoutDerivedFields('invoices', doc)).toBe(doc)
    const other = { _id: 1, numberSeq: 4 }
    expect(withoutDerivedFields('orders', other)).toBe(other)
  })
})
