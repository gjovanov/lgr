import { describe, expect, it } from 'bun:test'
import {
  compareSalesRegister, registerNumber, registerPartnerId, salesRegisterRow, sofiaDay, sofiaPeriod,
  type DerivedSalesRow, type FiledSalesRow, type RegisterDocument,
} from 'services/biz/vat-files/sales-register'

/** FR-25 R3: an LGR document's row in the sales register (PRODAGBI). Made-up documents and partners only. */

const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`)

const invoice = (over: Partial<RegisterDocument> = {}): RegisterDocument => ({
  type: 'invoice', number: 'INV-2026-3000700001', issueDate: day('2026-09-15'), status: 'sent', currency: 'EUR',
  // Two lines of 0.33: their VAT rounded one by one sums to 0.14, the document's is round(0.66 × 20%) = 0.13.
  subtotal: 0.66, discountTotal: 0, taxTotal: 0.13, total: 0.79,
  lines: [{ taxRate: 20 }, { taxRate: 20 }],
  partner: { vatNumber: 'BG999000191', taxId: '999000191', name: 'ТЕСТ КЛИЕНТ ООД' },
  ...over,
})

const rowOf = (doc: RegisterDocument, period = '202609') => {
  const r = salesRegisterRow(doc, period)
  if (!('row' in r)) throw new Error(`refused: ${r.refused}`)
  return r.row
}

describe('the sales register row of a document', () => {
  it('carries the document\'s own base and VAT, never a sum of its lines\' rounded VAT', () => {
    const row = rowOf(invoice())
    expect(row.docTypeCode).toBe('01')
    expect(row.docNumber).toBe('3000700001')
    expect(row.docDate).toEqual(day('2026-09-15'))
    expect(row.cells).toEqual({ '02-10': 66, '02-11': 66, '02-20': 13, '02-21': 13 })
    expect(row.description).toBe('Стоки')
  })

  it('takes the base after the document\'s discount', () => {
    const row = rowOf(invoice({ subtotal: 10, discountTotal: 1, taxTotal: 1.8, total: 10.8 }))
    expect(row.cells['02-10']).toBe(900)
    expect(row.cells['02-20']).toBe(180)
  })

  it('makes a credit note\'s values negative and a debit note\'s positive', () => {
    expect(rowOf(invoice({ type: 'credit_note' }))).toMatchObject({ docTypeCode: '03', cells: { '02-10': -66, '02-11': -66, '02-20': -13, '02-21': -13 } })
    expect(rowOf(invoice({ type: 'debit_note' }))).toMatchObject({ docTypeCode: '02', cells: { '02-10': 66, '02-20': 13 } })
  })

  it('names the partner by its VAT number, else its ЕИК or ЕГН', () => {
    expect(rowOf(invoice()).partnerVat).toBe('BG999000191')
    expect(rowOf(invoice({ partner: { taxId: '123456786' } })).partnerVat).toBe('123456786')
    expect(registerPartnerId({ vatNumber: ' bg 999 000 191 ' })).toBe('BG999000191')
    expect(registerPartnerId(undefined)).toBe('')
  })

  it('dates a document by its business day in Sofia', () => {
    // 21:30 UTC on the 30th is 00:30 on the 1st in Sofia (UTC+3 in summer time).
    const late = new Date('2026-09-30T21:30:00.000Z')
    expect(sofiaDay(late)).toEqual(day('2026-10-01'))
    expect(sofiaPeriod(late)).toBe('202610')
    expect(salesRegisterRow(invoice({ issueDate: late }), '202609')).toEqual({ refused: 'outside_the_period' })
    expect(rowOf(invoice({ issueDate: late }), '202610').docDate).toEqual(day('2026-10-01'))
    // and in winter time, UTC+2
    expect(sofiaDay(new Date('2026-12-31T22:30:00.000Z'))).toEqual(day('2027-01-01'))
  })

  it('keeps a document annulled in its own period as a row with no values', () => {
    const row = rowOf(invoice({ status: 'voided', voidedAt: new Date('2026-09-20T10:00:00.000Z') }))
    expect(row.docNumber).toBe('3000700001')
    expect(row.cells).toEqual({})
  })

  it('does not guess at a document annulled in a later period', () => {
    expect(salesRegisterRow(invoice({ status: 'voided', voidedAt: new Date('2026-10-02T10:00:00.000Z') }), '202609')).toEqual({ refused: 'voided_in_a_later_period' })
    expect(salesRegisterRow(invoice({ status: 'voided' }), '202609')).toEqual({ refused: 'voided_in_a_later_period' })
  })

  it('says why a document has no row', () => {
    expect(salesRegisterRow(invoice({ type: 'cash_sale' }), '202609')).toEqual({ refused: 'not_a_register_document', detail: 'cash_sale' })
    expect(salesRegisterRow(invoice({ type: 'proforma' }), '202609')).toEqual({ refused: 'not_a_register_document', detail: 'proforma' })
    expect(salesRegisterRow(invoice({ status: 'draft' }), '202609')).toEqual({ refused: 'not_issued', detail: 'draft' })
    expect(salesRegisterRow(invoice({ number: 'DRF-INV-00042' }), '202609')).toEqual({ refused: 'number_not_ten_digits' })
    expect(salesRegisterRow(invoice({ currency: 'BGN' }), '202609')).toEqual({ refused: 'currency_not_eur', detail: 'BGN' })
  })

  it('derives 20% only, the one rate proven on the filed months', () => {
    expect(salesRegisterRow(invoice({ lines: [{ taxRate: 9 }] }), '202609')).toEqual({ refused: 'rate_not_derived', detail: '9' })
    expect(salesRegisterRow(invoice({ lines: [{ taxRate: 20 }, { taxRate: 0 }] }), '202609')).toEqual({ refused: 'rate_not_derived', detail: '0,20' })
    expect(salesRegisterRow(invoice({ lines: [] }), '202609')).toEqual({ refused: 'rate_not_derived', detail: 'no lines' })
  })

  it('calls a document of services alone Услуги', () => {
    expect(rowOf(invoice({ lines: [{ taxRate: 20, service: true }] })).description).toBe('Услуги')
    expect(rowOf(invoice({ lines: [{ taxRate: 20, service: true }, { taxRate: 20 }] })).description).toBe('Стоки')
  })

  it('reads the ten digits off any display prefix', () => {
    expect(registerNumber('INV-3000700001')).toBe('3000700001')
    expect(registerNumber('3000700001')).toBe('3000700001')
    expect(registerNumber('INV-2026-00042')).toBeNull()
  })
})

describe('the derived register against the filed one', () => {
  const owners = [{ branch: 'PZ', docSeries: ['3000'] }, { branch: 'SF', docSeries: ['2000'] }]
  const derived = (doc: RegisterDocument, origin: DerivedSalesRow['origin'] = 'imported'): DerivedSalesRow => ({ row: rowOf(doc), branch: 'PZ', origin })
  const filed = (over: Partial<FiledSalesRow> = {}): FiledSalesRow => ({
    docTypeCode: '01', docNumber: '3000700001', docDate: day('2026-09-15'), partnerVat: 'BG999000191',
    cells: { '02-10': 66, '02-11': 66, '02-20': 13, '02-21': 13 }, ...over,
  })

  it('counts a row equal when type, number, date, partner and cells all are', () => {
    const r = compareSalesRegister([derived(invoice())], [filed()], owners)
    expect(r.counts).toEqual({ 'PZ imported: equal': 1 })
    expect(r.details).toEqual([])
  })

  it('says what differs, and by how many cents', () => {
    // The same document stored with the lines' VAT (0.14) instead of the printed one.
    const r = compareSalesRegister([derived(invoice({ taxTotal: 0.14, total: 0.80 }))], [filed()], owners)
    expect(r.counts).toEqual({ 'PZ imported: differs in vat': 1 })
    expect(r.details[0].deltas).toEqual({ base: 0, vat: 1 })
    const partner = compareSalesRegister([derived(invoice({ partner: { taxId: '999000191' } }))], [filed()], owners)
    expect(partner.counts).toEqual({ 'PZ imported: differs in partner': 1 })
  })

  it('matches a filed number written with leading zeros', () => {
    const r = compareSalesRegister([derived(invoice({ number: 'INV-0000000123' }))], [filed({ docNumber: '123' })], owners)
    expect(r.counts).toEqual({ 'PZ imported: equal': 1 })
  })

  it('matches one number once, preferring the imported document, and counts the other apart', () => {
    const r = compareSalesRegister([derived(invoice(), 'native'), derived(invoice(), 'imported')], [filed()], owners)
    expect(r.counts).toEqual({ 'PZ imported: equal': 1, 'PZ native: another LGR document carries the same number': 1 })
  })

  it('tells a branch\'s rows LGR does not hold from the rows no branch explains', () => {
    const r = compareSalesRegister([derived(invoice(), 'native')], [
      filed({ docNumber: '2000100001' }),
      filed({ docNumber: '0000012345' }),
      filed({ docTypeCode: '09', docNumber: '12' }),
      filed({ docTypeCode: '81', docNumber: '' }),
    ], owners)
    expect(r.counts).toEqual({
      'PZ native: in LGR, not filed': 1,
      "filed 01, SF's series: not in LGR": 1,
      "filed 01, no branch's series": 1,
      "filed 09, no branch's series (a 2-character number)": 1,
      "filed 81, no branch's series (a 0-character number)": 1,
    })
  })
})
