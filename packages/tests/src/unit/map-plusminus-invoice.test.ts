/**
 * `plusminusInvoiceToExtraction` against a PlusMinus `document()` response in the shape
 * `pull-plusminus-api` returns. The field names are PlusMinus's; every number, amount and party is
 * made up. What the mapper must produce from it: contact "ТЕСТ КЛИЕНТ АД", Payment Method
 * "Bank Transfer", Place of transaction "гр.Тестоград", Subtotal €69.30 / Tax €13.86 /
 * Total €83.16, six lines matching this fixture exactly.
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
import { detectNoteType, parseNoteReference } from 'services/biz/doc-import/detect'

const SUPPLIER = { name: 'Проба ООД', eik: '123456786', vatNumber: 'BG123456786', address: 'ул.Тестова 101', city: 'Тестоград' }

/** invoicem_3000704716.json, header only: a credit note in the regal-pz shape. */
const CREDIT_NOTE_PZ: PlusMinusDocument['header'] = {
  docNumber: '3000704716', doc: '-ФЕ', docDate: '20261029', partner: 'КЛИЕНТИ:ТЕСТ КУПУВАЧ - ООД',
  sum: '-24.00', vat: '-4.00', comment: 'Стоки -ФЕ 3000704701/29.10.2026 ED777002-1111-0000802',
  'ОСНИЗВ': '-ФЕ 3000704701/29.10.2026', paymentMethod: '1',
}

/** invoicem_2000732342.json, header only: a credit note in the regal-sf shape — a SEPARATE
 *  pmserver.exe install, same ОСНИЗВ shape confirmed independently. */
const CREDIT_NOTE_SF: PlusMinusDocument['header'] = {
  docNumber: '2000732342', doc: '-ФЕ', docDate: '20261029', partner: 'ПАРТНЬОРИ:ТЕСТ ЕЛЕКТРО ООД',
  sum: '-60.00', vat: '-10.00', comment: 'Стоки -ФЕ 2000732271/27.10.2026',
  'ОСНИЗВ': '-ФЕ 2000732271/27.10.2026', paymentMethod: '2',
}

const SAMPLE_INVOICE: PlusMinusDocument = {
  date: '20261026',
  num: '00000129',
  header: {
    bic: 'BNBGBGSD', iban: 'BG80BNBG96611020345678', vatPercent: '20', createdBy: 'kasa 2',
    createdOn: '20261026:133218379083300', docDate: '20261026', module: 'sales',
    placeOfIssue: 'гр.Тестоград', unp: 'ED777002-1111-0000683', vatRate: '20',
    bank: 'ТЕСТ БАНК АД', docType: '1', paymentMethod: '2', taxEventDate: '20261026', vat: '13.86',
    docNumber: '3000704649', doc: '-ФЕ', partner: 'ПАРТНЬОРИ:ТЕСТ КЛИЕНТ АД', paymentType: '2',
    sum: '83.16', comment: 'Стоки -ФП 1234/06.10.2026', type: '1',
  },
  lines: [
    { item: 'СТОКИ:БОЛТ М12Х60 - DIN 933 - A4', no: '1', name: 'БОЛТ М12Х60 - DIN 933 - A4', quantity: '100', measure: 'БР', sum: '25', price: '0.25' },
    { item: 'СТОКИ:ГАЙКА М12 - DIN 934 - A4-80', no: '2', name: 'ГАЙКА М12 - DIN 934 - A4-80', quantity: '100', measure: 'БР', sum: '5', price: '0.05' },
    { item: 'СТОКИ:ШАЙБА - М12 - DIN 125 - A4', no: '3', name: 'ШАЙБА - М12 - DIN 125 - A4', quantity: '100', measure: 'БР', sum: '2', price: '0.02' },
    { item: 'СТОКИ:БОЛТ М16Х130 - DIN 931 - А4-80', no: '4', name: 'БОЛТ М16Х130 - DIN 931 - А4-80', quantity: '20', measure: 'БР', sum: '30', price: '1.5' },
    { item: 'СТОКИ:ГАЙКА М16 - DIN 934 - A4-80', no: '5', name: 'ГАЙКА М16 - DIN 934 - A4-80', quantity: '20', measure: 'БР', sum: '4.9', price: '0.245' },
    { item: 'СТОКИ:ШАЙБА - М16 - DIN 125 - A4', no: '6', name: 'ШАЙБА - М16 - DIN 125 - A4', quantity: '20', measure: 'БР', sum: '2.4', price: '0.12' },
  ],
}

describe('plusminusInvoiceToExtraction', () => {
  const ext = plusminusInvoiceToExtraction(SAMPLE_INVOICE, SUPPLIER)

  it('preserves the legacy document number and date', () => {
    expect(ext.document_number).toBe('3000704649')
    expect(ext.issue_date).toBe('2026-10-26')
  })

  it('strips the ПАРТНЬОРИ: prefix off the counterparty name', () => {
    expect(ext.customer?.name).toBe('ТЕСТ КЛИЕНТ АД')
  })

  it('carries the org\'s own identity as supplier, so direction resolves outgoing', () => {
    expect(ext.supplier?.company_id).toBe('123456786')
    expect(ext.supplier?.name).toBe('Проба ООД')
  })

  it('copies header.sum/vat verbatim — no BGN→EUR conversion', () => {
    expect(ext.currency).toBe('EUR')
    expect(ext.exchange_rate).toBe(1)
    expect(ext.vat_total).toBe(13.86)
    expect(ext.gross_total).toBe(83.16)
  })

  it('maps every line with the exact description, quantity, unit and net price', () => {
    expect(ext.line_items).toHaveLength(6)
    expect(ext.line_items[0]).toMatchObject({
      description: 'БОЛТ М12Х60 - DIN 933 - A4', quantity: 100, unit: 'БР', unit_price: 0.25, vat_rate: 20, total: 25,
    })
    expect(ext.line_items[4]).toMatchObject({
      description: 'ГАЙКА М16 - DIN 934 - A4-80', quantity: 20, unit_price: 0.245, total: 4.9,
    })
  })
})

describe('plusminusPaymentMethod', () => {
  it('maps the three confirmed codes', () => {
    expect(plusminusPaymentMethod('1')).toBe('cash')
    expect(plusminusPaymentMethod('2')).toBe('bank_transfer')
    expect(plusminusPaymentMethod('4')).toBe('card')
  })

  it('leaves an unconfirmed or missing code unmapped rather than guessing', () => {
    expect(plusminusPaymentMethod('3')).toBeUndefined()
    expect(plusminusPaymentMethod(undefined)).toBeUndefined()
  })
})

describe('stripPartnerPrefix', () => {
  it('strips either the ПАРТНЬОРИ: or КЛИЕНТИ: prefix', () => {
    expect(stripPartnerPrefix('ПАРТНЬОРИ:ТЕСТ КЛИЕНТ АД')).toBe('ТЕСТ КЛИЕНТ АД')
    expect(stripPartnerPrefix('КЛИЕНТИ:ТЕСТ ПАРТНЬОР - ООД')).toBe('ТЕСТ ПАРТНЬОР - ООД')
  })

  it('passes a name through unchanged when there is no prefix', () => {
    expect(stripPartnerPrefix('ТЕСТ КЛИЕНТ АД')).toBe('ТЕСТ КЛИЕНТ АД')
  })
})

describe('buildSyntheticRawText', () => {
  it('carries place of transaction and payment method in the exact label format parse-text.ts expects', () => {
    const text = buildSyntheticRawText(SAMPLE_INVOICE.header)
    expect(text).toContain('Място на сделката: : гр.Тестоград')
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

  it('says nothing about a credit note for an ordinary positive-sum invoice', () => {
    const text = buildSyntheticRawText(SAMPLE_INVOICE.header)
    expect(text).not.toContain('Кредитно известие')
    expect(detectNoteType(text)).toBeNull()
  })

  describe('a negative-sum document (credit note), both orgs', () => {
    it.each([
      ['regal-pz', CREDIT_NOTE_PZ, '3000704701'],
      ['regal-sf', CREDIT_NOTE_SF, '2000732271'],
    ])('%s: detectNoteType/parseNoteReference — the SAME unchanged text-based functions the OCR path uses — read it as a credit note correcting %s', (_org, header, expectedRef) => {
      const text = buildSyntheticRawText(header)
      expect(detectNoteType(text)).toBe('credit_note')
      expect(parseNoteReference(text)).toBe(expectedRef)
    })
  })

  it('still types as a credit note when ОСНИЗВ is missing, just without a resolvable reference', () => {
    const text = buildSyntheticRawText({ sum: '-5' })
    expect(detectNoteType(text)).toBe('credit_note')
    expect(parseNoteReference(text)).toBeUndefined()
  })
})
