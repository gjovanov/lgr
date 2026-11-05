import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { mongoose } from 'db/connection'
import { AccountingAnalytic, AuditLog, Contact, Invoice, JournalEntry } from 'db/models'
import { setupTestDB, teardownTestDB } from '../setup'
import { createTestContact, createTestInvoice, createTestOrg, createTestUser } from '../helpers/factories'
import { applyBooksLeftovers, BROKEN as B, planBooksLeftovers, pointersFromOutside, referencePaths } from '../../../../scripts/lib/books-leftovers'

/**
 * The GUI export's leftovers in a books org (FR-25 §9), on made-up rows whose names hold U+FFFD. Only
 * what nothing points at is deactivated. An analytic is kept by a journal line, an opening, an entry's
 * partner, an invoice line, or an analytic under it that stays. A contact is kept by any document, by an
 * analytic that stays, and by an ЕИК.
 */

const id = () => new mongoose.Types.ObjectId()
const ids = (...rows: any[]) => rows.map(r => String(r._id)).sort()

let org: any, owner: any
const a: Record<string, any> = {}
const c: Record<string, any> = {}

async function analytic(path: string, extra: Record<string, unknown> = {}) {
  const at = path.lastIndexOf(':')
  const name = path.slice(at + 1)
  const parent: any = at > 0 ? await AccountingAnalytic.findOne({ orgId: org._id, path: path.slice(0, at) }).lean() : null
  return AccountingAnalytic.create({
    orgId: org._id, path, root: path.split(':')[0], name, nameLower: name.toLowerCase(), kind: 'other', isActive: true,
    ...(parent ? { parentId: parent._id } : {}), ...extra,
  })
}

const entry = (lines: Record<string, unknown>[], extra: Record<string, unknown> = {}) => JournalEntry.create({
  orgId: org._id, entryNumber: `JE-${id()}`, date: new Date('2026-03-01'), fiscalPeriodId: id(), description: 'ТЕСТ',
  status: 'posted', createdBy: owner._id, totalDebit: 10, totalCredit: 10,
  lines: lines.map(l => ({ accountId: id(), debit: 0, credit: 0, baseDebit: 0, baseCredit: 0, ...l })),
  ...extra,
})

beforeAll(async () => {
  await setupTestDB()
  org = await createTestOrg({ name: 'Книги', slug: 'books-leftovers-test' } as any)
  owner = await createTestUser(org._id)

  c.fine = await createTestContact(org._id, { companyName: 'ФИРМА А', taxId: '999000191' } as any)
  c.b = await createTestContact(org._id, { companyName: `Ф${B}РМА Б` } as any)
  c.v = await createTestContact(org._id, { companyName: `Ф${B}РМА В` } as any)
  c.numbered = await createTestContact(org._id, { companyName: `Ф${B}РМА Н`, taxId: '999000209' } as any)
  c.journal = await createTestContact(org._id, { companyName: `Ф${B}РМА Й` } as any)
  c.invoiced = await createTestContact(org._id, { companyName: `Ф${B}РМА И` } as any)
  c.free = await createTestContact(org._id, { companyName: `Ф${B}РМА С` } as any)
  c.person = await createTestContact(org._id, { companyName: undefined, firstName: 'ИВАН', lastName: `ПЕТР${B}В` } as any)
  c.old = await createTestContact(org._id, { companyName: `Ф${B}РМА СТАРА`, isActive: false, deactivatedAt: new Date('2026-01-01') } as any)

  a.root = await analytic('КЛИЕНТИ')
  a.fine = await analytic('КЛИЕНТИ:ФИРМА А', { contactId: c.fine._id })
  a.b = await analytic(`КЛИЕНТИ:Ф${B}РМА Б`, { contactId: c.b._id })
  a.booked = await analytic(`КЛИЕНТИ:Ф${B}РМА В`, { contactId: c.v._id })
  a.partner = await analytic(`КЛИЕНТИ:Ф${B}РМА Г`)
  a.invoiced = await analytic(`КЛИЕНТИ:Ф${B}РМА Ж`)
  a.old = await analytic(`КЛИЕНТИ:Ф${B}РМА З`, { isActive: false, deactivatedAt: new Date('2026-01-01') })
  // A root the export broke, with nothing booked under it, and one with an opening under it.
  a.emptyRoot = await analytic(`ДОСТ${B}ВЧИЦИ`)
  a.emptyD = await analytic(`ДОСТ${B}ВЧИЦИ:ФИРМА Д`)
  a.emptyE = await analytic(`ДОСТ${B}ВЧИЦИ:ФИРМА Е`)
  a.heldRoot = await analytic(`РАЗ${B}ОДИ`)
  a.opening = await analytic(`РАЗ${B}ОДИ:НАЕМ`)
  a.idle = await analytic(`РАЗ${B}ОДИ:ТОК`)

  await entry([{ debit: 10, baseDebit: 10, analyticId: a.booked._id, contactId: c.journal._id }, { credit: 10, baseCredit: 10 }], { partnerAnalyticId: a.partner._id })
  await entry([{ debit: 10, baseDebit: 10, analyticId: a.opening._id }, { credit: 10, baseCredit: 10 }], { type: 'opening' })
  const invoice = await createTestInvoice(org._id, c.invoiced._id)
  await Invoice.updateOne({ _id: invoice._id }, { $set: { 'lines.0.analyticId': a.invoiced._id } })
})

afterAll(async () => {
  await teardownTestDB()
})

describe('deactivate-books-leftovers: what the export broke, and nothing points at', () => {
  it('reads the pointers off every schema, arrays inside subdocuments included', () => {
    const at = (target: string) => referencePaths(target).map(r => `${r.model}.${r.path}`)
    expect(at('AccountingAnalytic')).toEqual(expect.arrayContaining([
      'JournalEntry.lines.analyticId', 'JournalEntry.partnerAnalyticId', 'Invoice.lines.analyticId', 'AccountingAnalytic.parentId',
    ]))
    expect(at('Contact')).toEqual(expect.arrayContaining([
      'Invoice.contactId', 'Invoice.cashSaleRef.contactId', 'JournalEntry.lines.contactId', 'AccountingAnalytic.contactId',
      'Product.customPrices.contactId', 'Product.priceTiers.contactIds',
    ]))
    // A subschema used in two places is walked in both.
    const shared = new mongoose.Schema({ contactId: { type: mongoose.Schema.Types.ObjectId, ref: 'Contact' } }, { _id: false })
    mongoose.model('LeftoverProbe', new mongoose.Schema({ one: shared, many: [shared] }))
    try {
      expect(at('Contact')).toEqual(expect.arrayContaining(['LeftoverProbe.one.contactId', 'LeftoverProbe.many.contactId']))
    } finally {
      mongoose.deleteModel('LeftoverProbe')
    }
  })

  it('plans only the broken rows that nothing keeps', async () => {
    const plan = await planBooksLeftovers(org._id)
    expect(plan.analytics.map(r => r.id).sort()).toEqual(ids(a.b, a.emptyRoot, a.emptyD, a.emptyE, a.idle))
    expect(plan.contacts.map(r => r.id).sort()).toEqual(ids(c.b, c.free, c.person))
    expect(plan.counts).toEqual({
      'analytics with U+FFFD in the path': 10,
      'left: a document points at the analytic': 4,
      'left: an analytic under it stays': 1,
      'analytics to deactivate': 5,
      'contacts with U+FFFD in the name': 7,
      'left: the contact has an ЕИК or VAT number': 1,
      'left: something else points at the contact': 3,
      'contacts to deactivate': 3,
    })
  })

  it('deactivates them under the owner, audited, and a rerun plans nothing', async () => {
    const plan = await planBooksLeftovers(org._id)
    expect(await applyBooksLeftovers(plan, owner._id, 'the test')).toEqual({ analytics: 5, contacts: 3, failed: [] })

    const off: any[] = await AccountingAnalytic.find({ orgId: org._id, isActive: false }).lean()
    expect(ids(...off)).toEqual(ids(a.b, a.emptyRoot, a.emptyD, a.emptyE, a.idle, a.old))
    expect(off.every(r => r.deactivatedAt instanceof Date)).toBe(true)
    expect(ids(...await Contact.find({ orgId: org._id, isActive: false }).lean())).toEqual(ids(c.b, c.free, c.person, c.old))

    const audits: any[] = await AuditLog.find({ orgId: org._id, action: 'deactivate' }).lean()
    expect(audits.filter(r => r.entityType === 'accounting_analytic' && r.module === 'accounting').map(r => String(r.entityId)).sort()).toEqual(plan.analytics.map(r => r.id).sort())
    expect(audits.filter(r => r.entityType === 'contact' && r.module === 'invoicing').map(r => String(r.entityId)).sort()).toEqual(plan.contacts.map(r => r.id).sort())
    expect(audits.every(r => String(r.userId) === String(owner._id) && r.changes.some((ch: any) => ch.field === 'reason' && ch.newValue === 'the test'))).toBe(true)

    const again = await planBooksLeftovers(org._id)
    expect([again.analytics, again.contacts]).toEqual([[], []])
    expect(await pointersFromOutside(plan)).toEqual([])
  })

  it('names a pointer from outside the plan that appears after the run', async () => {
    const plan = { orgId: String(org._id), analytics: [{ id: String(a.emptyD._id), path: a.emptyD.path, root: a.emptyD.root }], contacts: [], counts: {} }
    await entry([{ debit: 1, baseDebit: 1, analyticId: a.emptyD._id }, { credit: 1, baseCredit: 1 }])
    expect(await pointersFromOutside(plan)).toEqual([`analytic ${a.emptyD._id}: JournalEntry.lines.analyticId`])
  })

  it('leaves alone a row that changed between the plan and the write', async () => {
    const late = await createTestContact(org._id, { companyName: `Ф${B}РМА Л` } as any)
    const lateRoot = await analytic(`ДРУГИ ${B}`)
    const plan = await planBooksLeftovers(org._id)
    expect([plan.analytics.map(r => r.id), plan.contacts.map(r => r.id)]).toEqual([ids(lateRoot), ids(late)])

    await Contact.updateOne({ _id: late._id }, { $set: { companyName: 'ФИРМА Л' } })
    await AccountingAnalytic.updateOne({ _id: lateRoot._id }, { $set: { path: 'ДРУГИ', root: 'ДРУГИ' } })
    const result = await applyBooksLeftovers(plan, owner._id, 'the test')
    expect([result.analytics, result.contacts]).toEqual([0, 0])
    expect(result.failed.sort()).toEqual([
      `analytic ${lateRoot._id}: changed since the plan, left alone`,
      `contact ${late._id}: changed since the plan, left alone`,
    ])
    expect([(await Contact.findById(late._id).lean() as any).isActive, (await AccountingAnalytic.findById(lateRoot._id).lean() as any).isActive]).toEqual([true, true])
    expect(await AuditLog.countDocuments({ orgId: org._id, entityId: { $in: [late._id, lateRoot._id] } })).toBe(0)
  })
})
