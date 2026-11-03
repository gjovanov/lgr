import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { AuditLog, Contact, Org, VatRegisterEntry } from 'db/models'
import { compareSalesRegisterOf } from 'services/biz/vat-files/sales-register.service'
import { setupTestDB, teardownTestDB } from '../setup'
import { createTestContact, createTestInvoice, createTestOrg, createTestUser } from '../helpers/factories'
import { applyContactVatFromRegister, planContactVatFromRegister, type ViesCheck } from '../../../../scripts/lib/contact-vat'

/**
 * The contact VAT repair, on made-up documents: a contact the filed register names by `BG` and its own ЕИК,
 * holding no VAT number or a malformed one, gets the number VIES confirms. Everything else is left and
 * counted: another number, another company, a number VIES refuses.
 */

const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`)
const PERIOD = '202609'
const line = { description: 'ТЕСТ', quantity: 1, unit: 'pcs', unitPrice: 1, discount: 0, taxRate: 20, taxAmount: 0.2, lineTotal: 1.2 }
const money = { subtotal: 1, discountTotal: 0, taxTotal: 0.2, total: 1.2, totalBase: 1.2, amountDue: 1.2 }
const asked: string[] = []
const vies: ViesCheck = async vat => { asked.push(vat); return vat === 'BG999000225' ? 'invalid' : 'valid' }

let books: any, pz: any, user: any
const contacts: Record<string, any> = {}

beforeAll(async () => {
  await setupTestDB()
  books = await createTestOrg({ name: 'Книги', slug: 'books-vat-test' } as any)
  pz = await createTestOrg({ name: 'Магазин А', slug: 'store-vat-test' } as any)
  user = await createTestUser(pz._id)
  await Org.updateOne({ _id: books._id }, { $set: { 'settings.accounting.books': { mode: 'books', branches: [{ orgId: pz._id, code: 'PZ', label: 'Магазин А', docSeries: ['3000'] }] } } })

  contacts.none = await createTestContact(pz._id, { companyName: 'БЕЗ НОМЕР ЕООД', taxId: '999000191' } as any)
  contacts.typo = await createTestContact(pz._id, { companyName: 'С ГРЕШКА ЕТ', taxId: '999000209', vatNumber: 'BG999000209Е' } as any)
  contacts.other = await createTestContact(pz._id, { companyName: 'ДРУГ НОМЕР ООД', taxId: '999000217', vatNumber: 'BG111111111' } as any)
  contacts.refused = await createTestContact(pz._id, { companyName: 'НЕРЕГИСТРИРАНА ЕООД', taxId: '999000225' } as any)
  contacts.elsewhere = await createTestContact(pz._id, { companyName: 'ДРУГА ФИРМА ЕООД', taxId: '999000233' } as any)

  const rows: [string, any, string][] = [
    ['3000700001', contacts.none, 'BG999000191'],
    ['3000700002', contacts.none, 'BG999000191'],
    ['3000700003', contacts.typo, 'BG999000209'],
    ['3000700004', contacts.other, 'BG999000217'],
    ['3000700005', contacts.refused, 'BG999000225'],
    ['3000700006', contacts.elsewhere, 'BG123456786'],
  ]
  for (const [i, [number, contact, partnerVat]] of rows.entries()) {
    await createTestInvoice(pz._id, contact._id, { invoiceNumber: `INV-${number}`, status: 'sent', issueDate: day('2026-09-10'), lines: [line], ...money, tags: ['ocr-import'] } as any)
    await VatRegisterEntry.create({
      orgId: books._id, period: PERIOD, side: 'sales', ledger: 'books', rowNo: i + 1, frozen: true, docTypeCode: '01', docNumber: number,
      docDate: day('2026-09-10'), partnerVat, cells: { '02-10': 100, '02-11': 100, '02-20': 20, '02-21': 20 },
    })
  }
})

afterAll(async () => {
  await teardownTestDB()
})

describe('repair-contact-vat: a contact gets the VAT number the books and VIES agree on', () => {
  it('plans only a missing or malformed number, by the contact\'s own ЕИК, once VIES confirms it', async () => {
    const { plans, counts } = await planContactVatFromRegister(books._id, [PERIOD], vies)
    expect(plans.map(p => [p.name, p.before, p.vatNumber, p.rows]).sort()).toEqual([
      ['БЕЗ НОМЕР ЕООД', null, 'BG999000191', 2],
      ['С ГРЕШКА ЕТ', 'BG999000209Е', 'BG999000209', 1],
    ])
    expect(counts).toEqual({
      'filed rows whose partner differs': 6,
      'to set: the VAT number VIES confirms': 2,
      'to set: another row of a contact already planned': 1,
      'left: the contact holds another VAT number': 1,
      'left: VIES says the number the books filed is not valid': 1,
      'left: the books name another number than the contact\'s own ЕИК': 1,
    })
    // One question a number, and none about a number it would not set.
    expect([...asked].sort()).toEqual(['BG999000191', 'BG999000209', 'BG999000225'])
  })

  it('refuses to write over a contact whose VAT number changed since the plan', async () => {
    const { plans } = await planContactVatFromRegister(books._id, [PERIOD], vies)
    const typo = plans.find(p => p.before)!
    await Contact.updateOne({ _id: contacts.typo._id }, { $set: { vatNumber: 'BG999000209X' } })
    expect(await applyContactVatFromRegister(typo, user._id, 'test')).toBe(false)
    await Contact.updateOne({ _id: contacts.typo._id }, { $set: { vatNumber: 'BG999000209Е' } })
  })

  it('writes each number, audits it, and the register then finds those rows equal', async () => {
    const { plans } = await planContactVatFromRegister(books._id, [PERIOD], vies)
    for (const p of plans) expect(await applyContactVatFromRegister(p, user._id, 'from the register')).toBe(true)

    const none: any = await Contact.findById(contacts.none._id).lean()
    expect([none.vatNumber, none.vatNumberLower]).toEqual(['BG999000191', 'bg999000191'])
    expect((await Contact.findById(contacts.typo._id).lean() as any).vatNumber).toBe('BG999000209')
    expect((await Contact.findById(contacts.other._id).lean() as any).vatNumber).toBe('BG111111111')
    expect((await Contact.findById(contacts.refused._id).lean() as any).vatNumber).toBeUndefined()

    const audit: any = await AuditLog.findOne({ orgId: pz._id, entityType: 'contact', entityId: contacts.typo._id }).lean()
    expect(audit.changes.find((c: any) => c.field === 'vatNumber')).toMatchObject({ oldValue: 'BG999000209Е', newValue: 'BG999000209' })

    const gate = await compareSalesRegisterOf(books._id, PERIOD)
    expect(gate.counts['PZ imported: equal']).toBe(3)
    expect(gate.counts['PZ imported: differs in partner']).toBe(3)
    expect((await planContactVatFromRegister(books._id, [PERIOD], vies)).plans).toEqual([])
  })
})
