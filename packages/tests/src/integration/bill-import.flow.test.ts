import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { createTestOrg, createTestUser, createTestWarehouse, createTestProduct, createTestStockLevel } from '../helpers/factories'
import { createDraftInvoice, convertDraftInvoice, type DraftResult } from 'invoicing-api/src/lib/bill-import'
import { getCurrentNumber } from 'services/biz/sequence.service'
import { Invoice, StockLevel, Contact } from 'db/models'

beforeAll(async () => { await setupTestDB() }, 60_000)
afterAll(async () => { await teardownTestDB() }, 60_000)
afterEach(async () => { await clearCollections() }, 30_000)

const ORG_EIK = '112500982'

function draftResult(supplier: any, customer: any, lines: any[]): DraftResult {
  const net = lines.reduce((s, l) => s + l.total, 0)
  return {
    extraction: {
      document_number: '2000122757', issue_date: '2026-03-31', currency: 'EUR', exchange_rate: 1.95583,
      supplier, customer, line_items: lines,
      net_total: net, vat_total: +(net * 0.2).toFixed(2), gross_total: +(net * 1.2).toFixed(2),
    },
    validation: { status: 'valid', checks: [] }, model: 'test', engine: 'test',
  }
}

describe('OCR invoice import (PlusMinus migration)', () => {
  it('org is ДОСТАВЧИК → outgoing sales: maps customer, preserves number, decreases stock (negative ok)', async () => {
    const org = await createTestOrg({ taxNumber: ORG_EIK } as any)
    const user = await createTestUser(org._id)
    const wh = await createTestWarehouse(org._id)
    const product = await createTestProduct(org._id, { name: 'Гайка М8' } as any)
    await createTestStockLevel(org._id, product._id, wh._id, { quantity: 10 } as any)

    const draft = draftResult(
      { name: 'РЕГАЛ ООД', company_id: ORG_EIK, vat_id: 'BG' + ORG_EIK },
      { name: 'ЕТ МАРИЦА М', company_id: '040406418', vat_id: 'BG040406418', address: 'ул. Царица Йоана 25, София' },
      [{ description: 'Гайка М8', quantity: 40, unit: 'бр', unit_price: 0.1, vat_rate: 20, total: 4 }],
    )
    const rawText = [
      'ФАКТУРА Номер: 2000122757',
      'Плащане:         По сметка',
      'Получателят е дал съгласие горепосочените лични данни да бъдат използвани от администратора на лични данни във',
      'изпълнението на чл. 114, ал. 1, т. 7 и т. 8 от ЗДДС и чл. 84, ал. 2 от ДОПК',
      '',
      'Съгласно чл.6, ал.1 от ЗСч., ЗДДС и ППЗДДС печат и подпис не са задължителни реквизити на фактурата.',
    ].join('\n')
    const { invoice, contact, direction, uncertain } = await createDraftInvoice(String(org._id), String(user._id), draft, String(wh._id), 'b1', rawText)
    expect(direction).toBe('outgoing')
    expect(uncertain).toBe(false)
    expect(invoice.reference).toBe('2000122757')
    const c: any = await Contact.findById(contact!.contactId).lean()
    expect(c.type).toBe('customer')
    expect(c.companyName).toContain('МАРИЦА')
    // ЕИК in both fields (the form's "Tax Number (EIK)" reads taxNumber) + structured address
    expect(c.taxId).toBe('040406418')
    expect(c.taxNumber).toBe('040406418')
    expect(c.addresses?.[0]?.street).toContain('Царица Йоана')
    expect(c.addresses?.[0]?.country).toBe('BG')
    // "Плащане: По сметка" → bank_transfer; legal clauses land in terms
    const drafted: any = await Invoice.findById(invoice.id).lean()
    expect(drafted.paymentMethod).toBe('bank_transfer')
    expect(drafted.terms).toContain('Получателят е дал съгласие')
    expect(drafted.terms).toContain('ДОПК')
    expect(drafted.terms).toContain('Съгласно чл.6, ал.1 от ЗСч.')
    // billingAddress = the counterparty's address, not the warehouse's
    expect(drafted.billingAddress.street).toContain('Царица Йоана')

    const res = await convertDraftInvoice(String(org._id), String(invoice.id), String(user._id))
    expect(res.ok).toBe(true)
    expect(res.invoiceNumber).toBe('INV-2000122757') // preserved original
    expect(res.direction).toBe('outgoing')

    const posted: any = await Invoice.findById(invoice.id).lean()
    expect(posted.status).toBe('sent')
    const sl: any = await StockLevel.findOne({ orgId: org._id, productId: product._id, warehouseId: wh._id }).lean()
    expect(sl.quantity).toBe(-30) // 10 - 40 dispatch (negative allowed for migration)

    const seq = await getCurrentNumber(String(org._id), 'SALES_DOC', new Date().getFullYear())
    expect(seq).toBeGreaterThanOrEqual(2000122757) // counter bumped past the migrated number
  })

  it('org is ПОЛУЧАТЕЛ → incoming bill: maps supplier, BILL-<original>, increases stock', async () => {
    const org = await createTestOrg({ taxNumber: ORG_EIK } as any)
    const user = await createTestUser(org._id)
    const wh = await createTestWarehouse(org._id)
    const product = await createTestProduct(org._id, { name: 'Болт М6' } as any)
    await createTestStockLevel(org._id, product._id, wh._id, { quantity: 5 } as any)

    const draft = draftResult(
      { name: 'Доставчик АД', company_id: '205931289', vat_id: 'BG205931289' },
      { name: 'РЕГАЛ ООД', company_id: ORG_EIK, vat_id: 'BG' + ORG_EIK },
      [{ description: 'Болт М6', quantity: 100, unit: 'бр', unit_price: 0.05, vat_rate: 20, total: 5 }],
    )
    const { invoice, contact, direction } = await createDraftInvoice(String(org._id), String(user._id), draft, String(wh._id), 'b2')
    expect(direction).toBe('incoming')
    const c: any = await Contact.findById(contact!.contactId).lean()
    expect(c.type).toBe('supplier')

    const res = await convertDraftInvoice(String(org._id), String(invoice.id), String(user._id))
    expect(res.invoiceNumber).toBe('BILL-2000122757')
    const posted: any = await Invoice.findById(invoice.id).lean()
    expect(posted.status).toBe('received')
    const sl: any = await StockLevel.findOne({ orgId: org._id, productId: product._id, warehouseId: wh._id }).lean()
    expect(sl.quantity).toBe(105) // 5 + 100 receipt
  })

  it('matched contact is enriched: taxNumber + structured address filled when missing', async () => {
    const org = await createTestOrg({ taxNumber: ORG_EIK } as any)
    const user = await createTestUser(org._id)
    const wh = await createTestWarehouse(org._id)
    // pre-existing seeded contact: taxId set, but no taxNumber / structured address
    await Contact.create({
      orgId: org._id, type: 'customer', companyName: 'ЕЛКОНТРОЛ-КОРЕКТ - ЕООД',
      taxId: '112595044', vatNumber: 'BG112595044',
      notes: 'Адрес: ул.Княз Александър Батемберг №5\nГрад: гр.ПАЗАРДЖИК', isActive: true,
    } as any)

    const draft = draftResult(
      { name: 'РЕГАЛ ООД', company_id: ORG_EIK, vat_id: 'BG' + ORG_EIK },
      { name: 'ЕЛКОНТРОЛ-КОРЕКТ - ЕООД', company_id: '112595044', vat_id: 'BG112595044', address: 'ул.Княз Александър Батемберг №5, ПАЗАРДЖИК' },
      [{ description: 'X', quantity: 1, unit: 'бр', unit_price: 10, vat_rate: 20, total: 10 }],
    )
    const { contact } = await createDraftInvoice(String(org._id), String(user._id), draft, String(wh._id), 'b4')
    expect(contact!.created).toBe(false) // matched, not duplicated
    const c: any = await Contact.findById(contact!.contactId).lean()
    expect(c.taxNumber).toBe('112595044') // enriched
    expect(c.addresses?.[0]?.street).toContain('Батемберг') // address structured
  })

  it('org matches neither party → defaults to sales + needs-review', async () => {
    const org = await createTestOrg({ taxNumber: ORG_EIK } as any)
    const user = await createTestUser(org._id)
    const wh = await createTestWarehouse(org._id)
    const draft = draftResult(
      { name: 'Some Supplier', company_id: '205931289' },
      { name: 'Some Customer', company_id: '160099721' },
      [{ description: 'X', quantity: 1, unit: 'бр', unit_price: 10, vat_rate: 20, total: 10 }],
    )
    const { invoice, direction, uncertain } = await createDraftInvoice(String(org._id), String(user._id), draft, String(wh._id), 'b3')
    expect(direction).toBe('outgoing')
    expect(uncertain).toBe(true)
    const doc: any = await Invoice.findById(invoice.id).lean()
    expect(doc.tags).toContain('needs-review')
  })
})
