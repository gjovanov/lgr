import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import type { Types as MongooseTypes } from 'mongoose'
import { mongoose } from 'db/connection'
import { AuditLog, Contact, DocFile, Invoice } from 'db/models'
import { setupTestDB, teardownTestDB } from '../setup'
import { createTestContact, createTestInvoice, createTestOrg, createTestUser } from '../helpers/factories'
const { Types } = mongoose
import { applyInvoiceCustomer, contactsToCreate, createContact, planInvoiceCustomers, type PrintedDocument } from '../../../../scripts/lib/invoice-customer'

/**
 * The customer repair, on made-up documents: an invoice linked to a contact other than the customer it prints
 * moves to the contact holding the printed number, or to one created from the print; what it cannot prove is
 * another company, or cannot move safely, is left alone and counted.
 */

/** A text row with cells at fixed columns, the layout `pdftotext -layout` gives the reader. */
function row(...cells: Array<[number, string]>): string {
  let out = ''
  for (const [at, text] of cells) out = out.padEnd(at, ' ') + text
  return out
}

const pdf = (number: string, name: string, eik: string) => [
  row([70, 'ФАКТУРА'], [100, 'Номер:']),
  row([102, 'Дата:']),
  row([110, number]),
  row([110, '15.09.2026']),
  row([0, 'ПОЛУЧАТЕЛ'], [17, name], [77, 'ДОСТАВЧИК'], [95, 'ТЕСТ ДОСТАВЧИК ООД']),
  row([0, 'ЕИК'], [17, eik], [77, 'ЕИК'], [95, '123456786']),
  row([0, 'ИН по ДДС'], [17, eik.length === 9 ? `BG${eik}` : ''], [77, 'ИН по ДДС'], [95, 'BG123456786']),
  row([0, 'Град'], [17, 'ТЕСТОВ ГРАД'], [77, 'Град'], [95, 'ДРУГ ГРАД']),
  row([0, 'Адрес'], [17, 'ул. Тестова 1'], [77, 'Адрес'], [95, 'ул. Друга 2']),
  row([4, 'No'], [33, 'Име'], [66, 'Мяр'], [78, 'Кол'], [92, 'Цена'], [106, 'ТО'], [117, 'Стойност']),
  row([0, '1'], [13, 'ТЕСТ ВИНТ 4.2Х16'], [66, 'БР'], [80, '1'], [92, '1.00'], [124, '1.00']),
  row([0, 'Словом : тест'], [80, 'Данъчна основа'], [120, '1.00 €']),
  row([80, 'ДДС ( 20 % )'], [120, '0.20 €']),
  row([80, 'Сума за плащане'], [120, '1.20 €']),
].join('\n')

const PRINTED = { name: 'ТЕСТ КЛИЕНТ ООД', eik: '999000191' }
const NEW = { name: 'НОВ КЛИЕНТ ООД', eik: '999000217' }

let org: any, user: any, printedOne: any, other: any, bare: any
const ids: Record<string, MongooseTypes.ObjectId> = {}

async function imported(key: string, number: string, contactId: MongooseTypes.ObjectId, customer: { name: string; eik: string }, over: Record<string, unknown> = {}) {
  const inv: any = await createTestInvoice(org._id, contactId, { invoiceNumber: `INV-${number}`, status: 'sent', ...over } as any)
  await DocFile.create({
    orgId: org._id, docType: 'invoice', docNumber: number, docDate: '2026-09-15', status: 'committed', committedTarget: 'invoice',
    committedIds: [inv._id], extractedText: pdf(number, customer.name, customer.eik), originalName: `invoicem_${number}.pdf`,
    currentPath: '/dev/null', currentChecksum: number, mimeType: 'application/pdf', size: 1, uploadedBy: user._id,
  })
  ids[key] = inv._id
}

const typed: PrintedDocument[] = [{ invoiceNumber: 'INV-2026-3000700301', customer: { name: PRINTED.name, company_id: PRINTED.eik, vat_id: `BG${PRINTED.eik}` } }]

beforeAll(async () => {
  await setupTestDB()
  org = await createTestOrg()
  user = await createTestUser(org._id)
  printedOne = await createTestContact(org._id, { companyName: PRINTED.name, taxId: PRINTED.eik } as any)
  other = await createTestContact(org._id, { companyName: 'ТЕСТ КЛИЕНТ ЕООД', taxId: '999000209', vatNumber: 'BG999000209' } as any)
  bare = await createTestContact(org._id, { companyName: 'БЕЗ НОМЕР' } as any)
  await createTestContact(org._id, { companyName: 'ДВОЙНИК 1', taxId: '999000225' } as any)
  await createTestContact(org._id, { companyName: 'ДВОЙНИК 2', taxNumber: '999000225' } as any)
  await createTestContact(org._id, { companyName: 'САМО СНАБДИТЕЛ', type: 'supplier', taxId: '999000233' } as any)

  await imported('moved', '3000700101', other._id, PRINTED)
  await imported('right', '3000700102', printedOne._id, PRINTED)
  await imported('bare', '3000700103', bare._id, PRINTED)
  await imported('till', '3000700104', other._id, PRINTED, { register: { sessionId: new Types.ObjectId() } })
  await imported('new1', '3000700105', other._id, NEW)
  await imported('new2', '3000700106', other._id, NEW, { status: 'paid' })
  await imported('twins', '3000700107', other._id, { name: 'ДВОЙНИК', eik: '999000225' })
  await imported('supplier', '3000700108', other._id, { name: 'САМО СНАБДИТЕЛ', eik: '999000233' })
  await imported('person', '3000700109', other._id, { name: 'ТЕСТОВО ЛИЦЕ', eik: '7513020014' })
  await imported('draft', '3000700110', other._id, PRINTED, { status: 'draft' })
  ids.typed = (await createTestInvoice(org._id, other._id, { invoiceNumber: typed[0].invoiceNumber, status: 'paid' } as any) as any)._id
})

afterAll(async () => {
  await teardownTestDB()
})

describe('repair-invoice-customer: an invoice back on the customer it prints', () => {
  it('plans by the printed number only, and counts the rest by reason', async () => {
    const { plans, counts } = await planInvoiceCustomers(org._id, typed)
    expect(plans.map(p => [p.invoiceNumber, p.source, 'contactId' in p.target ? 'existing' : 'create']).sort()).toEqual([
      ['INV-2026-3000700301', 'printed', 'existing'],
      ['INV-3000700101', 'pdf', 'existing'],
      ['INV-3000700105', 'pdf', 'create'],
      ['INV-3000700106', 'pdf', 'create'],
    ])
    expect(counts).toEqual({
      'committed invoice PDFs': 10,
      'documents given by --printed': 1,
      'to relink: to the contact holding the printed number': 2,
      'to relink: to a contact created from the print': 2,
      'equal: the linked contact holds the printed number': 1,
      'left: the linked contact holds no company number, so nothing says it is another company': 1,
      'left: in a till session': 1,
      'left: several contacts hold the printed number': 1,
      'left: only a deactivated or supplier-only contact holds the printed number': 1,
      'left: the printed customer has no company number': 1,
      'left: a draft': 1,
    })
    // Two invoices of one new customer create it once, with the address the print gives.
    const creates = contactsToCreate(plans)
    expect([...creates.values()]).toEqual([{
      type: 'customer', companyName: NEW.name, taxId: NEW.eik, taxNumber: NEW.eik, vatNumber: `BG${NEW.eik}`,
      addresses: [{ type: 'billing', street: 'ул. Тестова 1', city: 'ТЕСТОВ ГРАД', country: 'BG', isDefault: true }],
    }])
  })

  it('refuses to write over an invoice whose contact changed since the plan', async () => {
    const { plans } = await planInvoiceCustomers(org._id, typed)
    const moved = plans.find(p => p.invoiceNumber === 'INV-3000700101')!
    await Invoice.updateOne({ _id: ids.moved }, { $set: { contactId: bare._id } })
    expect(await applyInvoiceCustomer(org._id, moved, String(printedOne._id), user._id, 'test')).toBe(false)
    expect(String((await Invoice.findById(ids.moved).lean() as any).contactId)).toBe(String(bare._id))
    await Invoice.updateOne({ _id: ids.moved }, { $set: { contactId: other._id } })
  })

  it('moves each invoice, creates the new customer once, audits each, and then has nothing left to do', async () => {
    const { plans } = await planInvoiceCustomers(org._id, typed)
    const created = new Map<string, string>()
    for (const [number, c] of contactsToCreate(plans)) created.set(number, await createContact(org._id, c, user._id, 'test'))
    for (const p of plans) {
      const target = 'contactId' in p.target ? p.target.contactId : created.get(p.target.create.taxId!)!
      expect(await applyInvoiceCustomer(org._id, p, target, user._id, 'printed customer')).toBe(true)
    }

    const moved: any = await Invoice.findById(ids.moved).lean()
    expect(String(moved.contactId)).toBe(String(printedOne._id))
    expect(moved.billingAddress).toEqual({ street: '123 Main St', city: 'Berlin', postalCode: '10115', country: 'DE' })
    expect(String((await Invoice.findById(ids.typed).lean() as any).contactId)).toBe(String(printedOne._id))
    const newId = created.get(NEW.eik)!
    for (const k of ['new1', 'new2']) {
      const inv: any = await Invoice.findById(ids[k]).lean()
      expect(String(inv.contactId)).toBe(newId)
      expect(inv.billingAddress).toEqual({ street: 'ул. Тестова 1', city: 'ТЕСТОВ ГРАД', postalCode: '-', country: 'BG' })
    }
    const made: any = await Contact.findById(newId).lean()
    expect([made.companyName, made.taxId, made.vatNumber, made.companyNameLower]).toEqual([NEW.name, NEW.eik, `BG${NEW.eik}`, NEW.name.toLocaleLowerCase('bg')])
    // What was left alone is where it was.
    for (const k of ['till', 'twins', 'supplier', 'person', 'draft']) expect(String((await Invoice.findById(ids[k]).lean() as any).contactId)).toBe(String(other._id))

    const audit: any = await AuditLog.findOne({ orgId: org._id, entityType: 'invoice', entityId: ids.moved }).lean()
    expect(audit.changes.find((c: any) => c.field === 'contactId')).toMatchObject({ oldValue: String(other._id), newValue: String(printedOne._id) })
    expect(String(audit.userId)).toBe(String(user._id))
    expect(await AuditLog.countDocuments({ orgId: org._id, entityType: 'contact', action: 'create', entityId: new Types.ObjectId(newId) })).toBe(1)

    const again = await planInvoiceCustomers(org._id, typed)
    expect(again.plans).toEqual([])
    expect(again.counts['equal: the linked contact holds the printed number']).toBe(5)
  })

  it('refuses to create a customer someone created in the meantime', async () => {
    const { plans } = await planInvoiceCustomers(org._id)
    expect(plans).toEqual([])
    const c = { type: 'customer' as const, companyName: 'ВЕЧЕ ИМА', taxId: NEW.eik, taxNumber: NEW.eik, addresses: [] }
    let refused: unknown
    try { await createContact(org._id, c, user._id, 'test') } catch (e) { refused = e }
    expect(String(refused)).toContain('holds that number by now')
  })

  it('does not move back an invoice the store re-issued to another customer after its PDF was imported', async () => {
    const first = await createTestContact(org._id, { companyName: 'ПЪРВИ КЛИЕНТ ЕООД', taxId: '999000241' } as any)
    await imported('reissued', '3000700111', first._id, { name: 'ПЪРВИ КЛИЕНТ ЕООД', eik: '999000241' })
    const later: PrintedDocument[] = [{ invoiceNumber: 'INV-3000700111', customer: { name: PRINTED.name, company_id: PRINTED.eik, vat_id: `BG${PRINTED.eik}` } }]
    const { plans } = await planInvoiceCustomers(org._id, later)
    expect(plans.map(p => [p.invoiceNumber, p.source])).toEqual([['INV-3000700111', 'printed']])
    expect(await applyInvoiceCustomer(org._id, plans[0], String(printedOne._id), user._id, 'test')).toBe(true)

    // A run without the list reads the older PDF again, and leaves the move alone.
    const again = await planInvoiceCustomers(org._id)
    expect(again.plans).toEqual([])
    expect(again.counts['left: its customer was changed after the import, so its PDF is not the last word']).toBe(1)
    expect(String((await Invoice.findById(ids.reissued).lean() as any).contactId)).toBe(String(printedOne._id))
  })
})
