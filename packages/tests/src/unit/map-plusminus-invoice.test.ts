/**
 * `plusminusInvoiceToExtraction` against a REAL PlusMinus `document()` response
 * (invoice `3000101649`, pulled live 2026-10-26 by `pull-plusminus-api`). The expected values
 * are not invented — they are what that exact invoice shows in LGR today, already correctly
 * imported via the OCR path (hand-verified in-browser at
 * `/invoicing/invoices/6ae096a6f14bfd267359a314/edit` while designing this mapper): contact
 * "БИОВЕТ - АД", Payment Method "Bank Transfer", Place of transaction "гр.Пазарджик",
 * Subtotal €301.53 / Tax €60.31 / Total €361.84, six lines matching this fixture exactly.
 */
import { describe, it, expect } from 'bun:test'
import {
  plusminusInvoiceToExtraction,
  plusminusPaymentMethod,
  stripPartnerPrefix,
  buildSyntheticRawText,
  INVOICE_TERMS_BOILERPLATE,
  type PlusMinusDocument,
} from 'services/biz/doc-import/map-plusminus-invoice'

const SUPPLIER = { name: 'Регал ООД', eik: '112500982', vatNumber: 'BG112500982', address: 'Пловдивска 110', city: 'Пазарджик' }

const SAMPLE_INVOICE: PlusMinusDocument = {
  date: '20261026',
  num: '00000129',
  header: {
    bic: 'UBBSBGSF', iban: 'BG04UBBS80021080268040', vatPercent: '20', createdBy: 'kasa 2',
    createdOn: '20261026:133218379083300', docDate: '20261026', module: 'sales',
    placeOfIssue: 'гр.Пазарджик', unp: 'ED338085-1111-0085683', vatRate: '20',
    bank: 'ОББ АД', docType: '1', paymentMethod: '2', taxEventDate: '20261026', vat: '60.31',
    docNumber: '3000101649', doc: '-ФЕ', partner: 'ПАРТНЬОРИ:БИОВЕТ АД', paymentType: '2',
    sum: '361.84', comment: 'Стоки -ФП 7374/06.10.2026', type: '1',
  },
  lines: [
    { item: 'СТОКИ:БОЛТ М12Х60 - DIN 933 - A4', no: '1', name: 'БОЛТ М12Х60 - DIN 933 - A4', quantity: '200', measure: 'БР', sum: '120', price: '0.6' },
    { item: 'СТОКИ:ГАЙКА М12 - DIN 934 - A4-80', no: '2', name: 'ГАЙКА М12 - DIN 934 - A4-80', quantity: '200', measure: 'БР', sum: '34', price: '0.17' },
    { item: 'СТОКИ:ШАЙБА - М12 - DIN 125 - A4', no: '3', name: 'ШАЙБА - М12 - DIN 125 - A4', quantity: '200', measure: 'БР', sum: '14', price: '0.07' },
    { item: 'СТОКИ:БОЛТ М16Х130 - DIN 931 - А4-80', no: '4', name: 'БОЛТ М16Х130 - DIN 931 - А4-80', quantity: '30', measure: 'БР', sum: '119.4', price: '3.98' },
    { item: 'СТОКИ:ГАЙКА М16 - DIN 934 - A4-80', no: '5', name: 'ГАЙКА М16 - DIN 934 - A4-80', quantity: '30', measure: 'БР', sum: '10.14', price: '0.338' },
    { item: 'СТОКИ:ШАЙБА - М16 - DIN 125 - A4', no: '6', name: 'ШАЙБА - М16 - DIN 125 - A4', quantity: '30', measure: 'БР', sum: '3.99', price: '0.133' },
  ],
}

describe('plusminusInvoiceToExtraction', () => {
  const ext = plusminusInvoiceToExtraction(SAMPLE_INVOICE, SUPPLIER)

  it('preserves the legacy document number and date', () => {
    expect(ext.document_number).toBe('3000101649')
    expect(ext.issue_date).toBe('2026-10-26')
  })

  it('strips the ПАРТНЬОРИ: prefix off the counterparty name', () => {
    expect(ext.customer?.name).toBe('БИОВЕТ АД')
  })

  it('carries the org\'s own identity as supplier, so direction resolves outgoing', () => {
    expect(ext.supplier?.company_id).toBe('112500982')
    expect(ext.supplier?.name).toBe('Регал ООД')
  })

  it('copies header.sum/vat verbatim — no BGN→EUR conversion — matching the already-imported invoice exactly', () => {
    expect(ext.currency).toBe('EUR')
    expect(ext.exchange_rate).toBe(1)
    expect(ext.vat_total).toBe(60.31)
    expect(ext.gross_total).toBe(361.84)
  })

  it('maps every line with the exact description, quantity, unit and net price', () => {
    expect(ext.line_items).toHaveLength(6)
    expect(ext.line_items[0]).toMatchObject({
      description: 'БОЛТ М12Х60 - DIN 933 - A4', quantity: 200, unit: 'БР', unit_price: 0.6, vat_rate: 20, total: 120,
    })
    expect(ext.line_items[4]).toMatchObject({
      description: 'ГАЙКА М16 - DIN 934 - A4-80', quantity: 30, unit_price: 0.338, total: 10.14,
    })
  })
})

describe('plusminusPaymentMethod', () => {
  it('maps the two confirmed codes', () => {
    expect(plusminusPaymentMethod('1')).toBe('cash')
    expect(plusminusPaymentMethod('2')).toBe('bank_transfer')
  })

  it('leaves an unconfirmed or missing code unmapped rather than guessing', () => {
    expect(plusminusPaymentMethod('3')).toBeUndefined()
    expect(plusminusPaymentMethod(undefined)).toBeUndefined()
  })
})

describe('stripPartnerPrefix', () => {
  it('strips either the ПАРТНЬОРИ: or КЛИЕНТИ: prefix', () => {
    expect(stripPartnerPrefix('ПАРТНЬОРИ:БИОВЕТ АД')).toBe('БИОВЕТ АД')
    expect(stripPartnerPrefix('КЛИЕНТИ:ВАДИС - ООД')).toBe('ВАДИС - ООД')
  })

  it('passes a name through unchanged when there is no prefix', () => {
    expect(stripPartnerPrefix('БИОВЕТ АД')).toBe('БИОВЕТ АД')
  })
})

describe('buildSyntheticRawText', () => {
  it('carries place of transaction and payment method in the exact label format parse-text.ts expects', () => {
    const text = buildSyntheticRawText(SAMPLE_INVOICE.header)
    expect(text).toContain('Място на сделката: : гр.Пазарджик')
    expect(text).toContain('Плащане: bank_transfer')
  })

  it('always carries the invariant legal boilerplate, verbatim', () => {
    const text = buildSyntheticRawText(SAMPLE_INVOICE.header)
    for (const clause of INVOICE_TERMS_BOILERPLATE) expect(text).toContain(clause)
  })

  it('omits a label entirely rather than printing an empty value', () => {
    const text = buildSyntheticRawText({})
    expect(text).not.toContain('Място на сделката')
    expect(text).not.toContain('Плащане:')
  })
})
