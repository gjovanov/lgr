import { describe, it, expect } from 'bun:test'
import { isValidEik, isValidIban, validateExtraction } from '../src/validate.js'
import type { InvoiceExtraction } from '../src/schema.js'

describe('ocr-server validation', () => {
  it('validates Bulgarian ЕИК checksums', () => {
    expect(isValidEik('112500982')).toBe(true) // РЕГАЛ ООД
    expect(isValidEik('040406418')).toBe(true) // ЕТ МАРИЦА М
    expect(isValidEik('205931289')).toBe(true)
    expect(isValidEik('112500983')).toBe(false) // wrong check digit
    expect(isValidEik('12345')).toBe(false)
    expect(isValidEik('')).toBe(false)
    expect(isValidEik(null)).toBe(false)
  })

  it('validates IBAN mod-97', () => {
    expect(isValidIban('BG33PRCB92301047123918')).toBe(true)
    expect(isValidIban('BG00PRCB92301047123918')).toBe(false)
    expect(isValidIban('not-an-iban')).toBe(false)
  })

  it('flags per-line arithmetic and reconciles identity checks (fixture 2000122757)', () => {
    const inv: InvoiceExtraction = {
      document_number: '2000122757',
      issue_date: '2026-03-31',
      currency: 'EUR',
      exchange_rate: 1.95583,
      supplier: { name: 'РЕГАЛ ООД', company_id: '112500982', vat_id: 'BG112500982', iban: 'BG33PRCB92301047123918', address: null },
      customer: { name: 'ЕТ МАРИЦА М', company_id: '040406418', vat_id: 'BG040406418', iban: null, address: null },
      line_items: [
        { description: 'Диск Inox 125х1', quantity: 25, unit: 'БР', unit_price: 0.8845, vat_rate: 20, total: 22.11 }, // ok
        { description: 'Болт М8х25', quantity: 1000, unit: 'БР', unit_price: 0.0312, vat_rate: 20, total: 31.24 }, // 31.20 ≠ 31.24 → fail
      ],
      net_total: 53.35,
      vat_total: 10.67,
      gross_total: 64.02,
    }
    const v = validateExtraction(inv)
    expect(v.status).toBe('needs_review')
    expect(v.checks.find(c => c.check === 'line_1_arithmetic')?.status).toBe('pass')
    expect(v.checks.find(c => c.check === 'line_2_arithmetic')?.status).toBe('fail')
    expect(v.checks.find(c => c.check === 'supplier_eik')?.status).toBe('pass')
    expect(v.checks.find(c => c.check === 'supplier_iban')?.status).toBe('pass')
    expect(v.checks.find(c => c.check === 'customer_eik')?.status).toBe('pass')
    expect(v.checks.find(c => c.check === 'totals_net_vat_gross')?.status).toBe('pass')
  })

  it('marks a clean invoice valid', () => {
    const inv: InvoiceExtraction = {
      document_number: 'X', issue_date: '2026-01-01', currency: 'BGN',
      supplier: { name: 'S', company_id: '112500982', vat_id: 'BG112500982', address: null, iban: null },
      customer: { name: 'C', address: null, company_id: null, vat_id: null, iban: null },
      line_items: [{ description: 'Item', quantity: 2, unit: 'бр', unit_price: 5, vat_rate: 20, total: 10 }],
      net_total: 10, vat_total: 2, gross_total: 12,
    }
    expect(validateExtraction(inv).status).toBe('valid')
  })

  it('does not fail a goods receipt for having no declared net', () => {
    // A стокова разписка prints quantities and values, never a net/VAT/gross block. Under the
    // invoice checks lines_sum_net could only ever FAIL — a STRUCTURAL failure, which sent every
    // one of them to the escalation model to arrive at the same answer twice as slowly.
    const receipt: any = {
      document_number: '3000016313',
      issue_date: '2026-08-28',
      line_items: [
        { description: 'ТЕСТ БОЛТ', quantity: 100, unit_price: 0.5, total: 50 },
        { description: 'ТЕСТ ГАЙКА', quantity: -20, unit_price: 0.25, total: -5 },
      ],
    }
    const v = validateExtraction(receipt, 'goods_receipt')
    expect(v.status).toBe('valid')
    expect(v.checks.some((c) => c.check === 'lines_sum_net')).toBe(false)
    expect(v.checks.find((c) => c.check === 'line_quantities')!.status).toBe('pass')

    // a receipt that lost its quantities is still caught
    const empty = validateExtraction({ ...receipt, line_items: [{ description: 'X', quantity: null }] } as any, 'goods_receipt')
    expect(empty.status).toBe('needs_review')
  })
})
