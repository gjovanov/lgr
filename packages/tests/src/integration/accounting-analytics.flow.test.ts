import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { Elysia } from 'elysia'
import jwt from '@elysiajs/jwt'
import { setupTestDB, teardownTestDB } from '../setup'
import { createTestAccount, createTestBankAccount, createTestContact, createTestFixedAsset, createTestOrg, createTestUser } from '../helpers/factories'
import { config } from 'config'
import { DEFAULT_ROLE_PERMISSIONS } from 'config/constants'
import { Account, AccountingAnalytic, AuditLog, JournalEntry, Org } from 'db/models'
import { mongoose } from 'db/connection'
import { lowerBg } from 'services/biz/accounting-books/registry'
import { createApiApp } from '../../../portal-api/src/api.js'

/**
 * FR-25a §3.1–3.3: the analytics of the books over HTTP, and what the chart and the bank accounts gained with them.
 * Fictional data only. Two orgs keep analytics: one of LGR's own, and one that keeps a legal entity's books, whose
 * analytics are as booked and refused any change.
 */

type Id = mongoose.Types.ObjectId

const ROLES = DEFAULT_ROLE_PERMISSIONS
const signer = new Elysia().use(jwt({ name: 'jwt', secret: config.jwt.secret }))
let app: Elysia

async function tokenFor(orgId: Id, role: keyof typeof ROLES, permissions: string[] = ROLES[role]) {
  const user = await createTestUser(orgId, { role, permissions } as any)
  return (signer as any).decorator.jwt.sign({
    id: String(user._id), orgId: String(orgId), role, email: user.email, username: user.username,
    firstName: 'Test', lastName: 'User', permissions, ownRecordsModules: [],
  }) as Promise<string>
}

async function call(method: string, path: string, token: string, body?: unknown) {
  const res = await app.handle(new Request(`http://localhost/api${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }))
  const type = res.headers.get('content-type') ?? ''
  const payload: any = type.includes('json') ? await res.json().catch(() => null) : await res.arrayBuffer()
  return { status: res.status, body: payload, headers: res.headers }
}

/** An analytic as the import writes one: its path, root, name and kind; the rest as given. */
function analytic(orgId: Id, path: string, kind: string, extra: Record<string, unknown> = {}) {
  const name = path.slice(path.lastIndexOf(':') + 1)
  return { orgId, path, root: path.split(':')[0], name, nameLower: lowerBg(name), kind, isActive: true, ...extra }
}

const world: Record<string, any> = {}

beforeAll(async () => {
  await setupTestDB()
  app = new Elysia().use(createApiApp())

  // An org of LGR's own, and one that keeps a legal entity's books.
  const native = await createTestOrg()
  const books = await createTestOrg({ taxNumber: '000000000' } as any)
  await Org.updateOne({ _id: books._id }, { $set: { 'settings.accounting.books': { mode: 'books' } } })
  const other = await createTestOrg()
  world.native = native._id
  world.books = books._id
  world.other = other._id

  world.contact = await createTestContact(native._id, { companyName: 'Клиент А ООД' } as any)
  world.otherContact = await createTestContact(other._id, { companyName: 'Чужд клиент' } as any)
  world.bank = await createTestBankAccount(native._id, { name: 'Main account' } as any)
  world.asset = await createTestFixedAsset(native._id, { code: 'FA-1', name: 'Машина' } as any)

  // ⚠ `РАЗХОДИ:УСЛУГИ АДМ` sorts between `РАЗХОДИ:УСЛУГИ` and its child by the path alone: the tree must not.
  const rows = await AccountingAnalytic.insertMany([
    analytic(native._id, 'КЛИЕНТИ', 'customer'),
    analytic(native._id, 'КЛИЕНТИ:Клиент А', 'customer', { contactId: world.contact._id }),
    analytic(native._id, 'КЛИЕНТИ:Клиент Б', 'customer', { isActive: false, deactivatedAt: new Date('2026-01-02') }),
    analytic(native._id, 'РАЗХОДИ', 'expense'),
    analytic(native._id, 'РАЗХОДИ:УСЛУГИ', 'expense'),
    analytic(native._id, 'РАЗХОДИ:УСЛУГИ АДМ', 'expense'),
    analytic(native._id, 'РАЗХОДИ:УСЛУГИ:Наем', 'expense', { params: [{ key: 'СМЕТКА', value: '602' }, { key: 'Б.код', value: '' }] }),
    analytic(native._id, 'БАНКОВИ СМЕТКИ', 'bank_account'),
    analytic(native._id, 'БАНКОВИ СМЕТКИ:XX00TEST0001', 'bank_account', { bankAccountId: world.bank._id }),
    analytic(native._id, 'ДА', 'fixed_asset'),
    analytic(native._id, 'ДА:Машина', 'fixed_asset', { fixedAssetId: world.asset._id, unit: 'бр' }),
    analytic(native._id, 'САМОСТОЯТЕЛЕН', 'other'),
    analytic(books._id, 'КЛИЕНТИ', 'customer'),
    analytic(books._id, 'КЛИЕНТИ:Клиент В', 'customer', { params: [{ key: 'БУЛСТАТ', value: '000000001' }, { key: 'ГРАД', value: 'Град' }] }),
    analytic(other._id, 'КЛИЕНТИ', 'customer'),
    analytic(other._id, 'КЛИЕНТИ:Чужд', 'customer'),
  ])
  world.byPath = (orgId: Id, path: string) => rows.find(r => String(r.orgId) === String(orgId) && r.path === path)!

  world.admin = await tokenFor(native._id, 'admin')
  world.accountant = await tokenFor(native._id, 'accountant')
  world.member = await tokenFor(native._id, 'member')
  world.warehouse = await tokenFor(native._id, 'warehouse_manager')
  world.booksAdmin = await tokenFor(books._id, 'admin')
  world.otherAdmin = await tokenFor(other._id, 'admin')
})

afterAll(async () => {
  await teardownTestDB()
})

const base = () => `/org/${world.native}/accounting/analytics`
const paths = (body: any) => (body.analytics as any[]).map(a => a.path)

describe('the list (FR-25a §3.2)', () => {
  it('is the tree by default: each root, then everything under it, a node before its children', async () => {
    const res = await call('GET', `${base()}?size=0`, world.accountant)
    expect(res.status).toBe(200)
    expect(paths(res.body)).toEqual([
      'БАНКОВИ СМЕТКИ', 'БАНКОВИ СМЕТКИ:XX00TEST0001',
      'ДА', 'ДА:Машина',
      'КЛИЕНТИ', 'КЛИЕНТИ:Клиент А', 'КЛИЕНТИ:Клиент Б',
      'РАЗХОДИ', 'РАЗХОДИ:УСЛУГИ', 'РАЗХОДИ:УСЛУГИ:Наем', 'РАЗХОДИ:УСЛУГИ АДМ',
      'САМОСТОЯТЕЛЕН',
    ])
    expect(res.body.total).toBe(12)
    expect(res.body.asBooked).toBe(false)
    // Each row knows its depth, and never carries the properties: the form reads those.
    const rent = res.body.analytics.find((a: any) => a.path === 'РАЗХОДИ:УСЛУГИ:Наем')
    expect(rent.depth).toBe(2)
    expect(rent.params).toBeUndefined()
  })

  it('names what each analytic links to', async () => {
    const res = await call('GET', `${base()}?size=0`, world.accountant)
    const row = (path: string) => res.body.analytics.find((a: any) => a.path === path)
    expect(row('КЛИЕНТИ:Клиент А')).toMatchObject({ contactId: String(world.contact._id), contactName: 'Клиент А ООД' })
    expect(row('БАНКОВИ СМЕТКИ:XX00TEST0001')).toMatchObject({ bankAccountId: String(world.bank._id), bankAccountName: 'Main account' })
    expect(row('ДА:Машина')).toMatchObject({ fixedAssetId: String(world.asset._id), fixedAssetName: 'FA-1 - Машина', unit: 'бр' })
  })

  it('filters by root, kind, contact, activity and a search on the name', async () => {
    const get = async (qs: string) => paths((await call('GET', `${base()}?size=0&${qs}`, world.accountant)).body)
    expect(await get(`root=${encodeURIComponent('КЛИЕНТИ')}`)).toEqual(['КЛИЕНТИ', 'КЛИЕНТИ:Клиент А', 'КЛИЕНТИ:Клиент Б'])
    expect(await get('kind=fixed_asset')).toEqual(['ДА', 'ДА:Машина'])
    expect(await get('hasContact=true')).toEqual(['КЛИЕНТИ:Клиент А'])
    expect(await get('hasContact=false')).not.toContain('КЛИЕНТИ:Клиент А')
    expect(await get('isActive=false')).toEqual(['КЛИЕНТИ:Клиент Б'])
    expect(await get('isActive=true')).not.toContain('КЛИЕНТИ:Клиент Б')
    // Lower case finds upper case: the search runs on `nameLower`, never on a case-folding regex.
    expect(await get(`search=${encodeURIComponent('клиент а')}`)).toEqual(['КЛИЕНТИ:Клиент А'])
    expect(await get(`search=${encodeURIComponent('УСЛУГИ')}`)).toEqual(['РАЗХОДИ:УСЛУГИ', 'РАЗХОДИ:УСЛУГИ АДМ'])
    // What points at a bank account: its form's link.
    expect(await get(`bankAccountId=${world.bank._id}`)).toEqual(['БАНКОВИ СМЕТКИ:XX00TEST0001'])
    // An id that is no id matches nothing, rather than everything.
    expect(await get('contactId=not-an-id')).toEqual([])
  })

  it('pages on the server, and sorts by a column with the tree as the tie-break', async () => {
    const page = await call('GET', `${base()}?page=1&size=5`, world.accountant)
    expect(page.body).toMatchObject({ total: 12, page: 1, size: 5, totalPages: 3 })
    expect(paths(page.body)).toEqual(['КЛИЕНТИ:Клиент А', 'КЛИЕНТИ:Клиент Б', 'РАЗХОДИ', 'РАЗХОДИ:УСЛУГИ', 'РАЗХОДИ:УСЛУГИ:Наем'])

    const byKind = await call('GET', `${base()}?size=3&sortBy=kind&sortOrder=desc`, world.accountant)
    expect(paths(byKind.body)).toEqual(['САМОСТОЯТЕЛЕН', 'ДА', 'ДА:Машина'])
  })

  it('lists the roots with their counts, the registry\'s with its word for them', async () => {
    const res = await call('GET', `${base()}/roots`, world.accountant)
    expect(res.status).toBe(200)
    expect(res.body.roots).toEqual([
      { root: 'КЛИЕНТИ', kind: 'customer', labelKey: 'customers', partner: true, count: 3 },
      { root: 'БАНКОВИ СМЕТКИ', kind: 'bank_account', labelKey: 'bankAccounts', count: 2 },
      { root: 'РАЗХОДИ', kind: 'expense', labelKey: 'expenses', count: 4 },
      { root: 'ДА', kind: 'fixed_asset', labelKey: 'fixedAssets', count: 2 },
      // A root the registry does not know comes last, as it is written.
      { root: 'САМОСТОЯТЕЛЕН', count: 1 },
    ])
  })
})

describe('one analytic', () => {
  it('has its properties in the file\'s order, and what is above it', async () => {
    const rent = world.byPath(world.native, 'РАЗХОДИ:УСЛУГИ:Наем')
    const res = await call('GET', `${base()}/${rent._id}`, world.member)
    expect(res.status).toBe(200)
    expect(res.body.asBooked).toBe(false)
    expect(res.body.analytic.params).toEqual([{ key: 'СМЕТКА', value: '602' }, { key: 'Б.код', value: '' }])
    expect(res.body.analytic.ancestors.map((a: any) => a.path)).toEqual(['РАЗХОДИ', 'РАЗХОДИ:УСЛУГИ'])
  })

  it('answers 404 for an id it does not hold, and for one that is no id', async () => {
    expect((await call('GET', `${base()}/${new mongoose.Types.ObjectId()}`, world.member)).status).toBe(404)
    expect((await call('GET', `${base()}/nope`, world.member)).status).toBe(404)
  })
})

describe('an analytic of the books is as booked (FR-25a §3)', () => {
  const booksBase = () => `/org/${world.books}/accounting/analytics`

  it('is read with its properties, and says it is as booked', async () => {
    const row = world.byPath(world.books, 'КЛИЕНТИ:Клиент В')
    const res = await call('GET', `${booksBase()}/${row._id}`, world.booksAdmin)
    expect(res.status).toBe(200)
    expect(res.body.asBooked).toBe(true)
    expect(res.body.analytic.params).toEqual([{ key: 'БУЛСТАТ', value: '000000001' }, { key: 'ГРАД', value: 'Град' }])
    expect((await call('GET', booksBase(), world.booksAdmin)).body.asBooked).toBe(true)
  })

  it('refuses any change with a stable code, and changes nothing', async () => {
    const row = world.byPath(world.books, 'КЛИЕНТИ:Клиент В')
    const put = await call('PUT', `${booksBase()}/${row._id}`, world.booksAdmin, { params: [{ key: 'X', value: 'Y' }] })
    expect(put.status).toBe(422)
    expect(put.body.code).toBe('books_as_booked')
    const del = await call('DELETE', `${booksBase()}/${row._id}`, world.booksAdmin)
    expect(del.status).toBe(422)
    expect(del.body.code).toBe('books_as_booked')
    const stored: any = await AccountingAnalytic.findById(row._id).lean()
    expect(stored.isActive).toBe(true)
    expect(stored.params).toEqual([{ key: 'БУЛСТАТ', value: '000000001' }, { key: 'ГРАД', value: 'Град' }])
  })
})

describe('an analytic of LGR\'s own', () => {
  it('links a contact, a bank account and a fixed asset of its org, and unlinks with null', async () => {
    const row = world.byPath(world.native, 'КЛИЕНТИ:Клиент Б')
    const url = `${base()}/${row._id}`
    const linked = await call('PUT', url, world.accountant, { contactId: String(world.contact._id), bankAccountId: String(world.bank._id), fixedAssetId: String(world.asset._id) })
    expect(linked.status).toBe(200)
    expect(linked.body.analytic).toMatchObject({ contactName: 'Клиент А ООД', bankAccountName: 'Main account', fixedAssetName: 'FA-1 - Машина' })

    const unlinked = await call('PUT', url, world.accountant, { contactId: null, bankAccountId: '', fixedAssetId: null })
    expect(unlinked.status).toBe(200)
    const stored: any = await AccountingAnalytic.findById(row._id).lean()
    expect(stored.contactId).toBeUndefined()
    expect(stored.bankAccountId).toBeUndefined()
    expect(stored.fixedAssetId).toBeUndefined()
  })

  it('never links what another org holds', async () => {
    const row = world.byPath(world.native, 'КЛИЕНТИ:Клиент Б')
    const res = await call('PUT', `${base()}/${row._id}`, world.accountant, { contactId: String(world.otherContact._id) })
    expect(res.status).toBe(422)
    expect(res.body.code).toBe('contact_not_found')
    const missing = await call('PUT', `${base()}/${row._id}`, world.accountant, { fixedAssetId: String(new mongoose.Types.ObjectId()) })
    expect(missing.body.code).toBe('fixed_asset_not_found')
  })

  it('keeps its properties in the order given, each named once, and records who changed them', async () => {
    const row = world.byPath(world.native, 'РАЗХОДИ:УСЛУГИ АДМ')
    const url = `${base()}/${row._id}`
    const dup = await call('PUT', url, world.accountant, { params: [{ key: 'A', value: '1' }, { key: ' A ', value: '2' }] })
    expect(dup.status).toBe(422)
    expect(dup.body.code).toBe('param_key_duplicate')
    const blank = await call('PUT', url, world.accountant, { params: [{ key: '  ', value: '1' }] })
    expect(blank.body.code).toBe('param_key_required')

    const saved = await call('PUT', url, world.accountant, { params: [{ key: ' Б ', value: '2' }, { key: 'A' }] })
    expect(saved.status).toBe(200)
    expect(saved.body.analytic.params).toEqual([{ key: 'Б', value: '2' }, { key: 'A', value: '' }])
    const audit: any = await AuditLog.findOne({ orgId: world.native, entityType: 'accounting_analytic', entityId: row._id }).lean()
    expect(audit).toBeTruthy()
    expect(audit.changes.map((c: any) => c.field)).toEqual(['params'])

    // None left is none: the field goes, as on an analytic that never had any.
    await call('PUT', url, world.accountant, { params: [] })
    expect(((await AccountingAnalytic.findById(row._id).lean()) as any).params).toBeUndefined()
  })

  it('is deactivated, never deleted, and comes back', async () => {
    const row = world.byPath(world.native, 'САМОСТОЯТЕЛЕН')
    const url = `${base()}/${row._id}`
    const off = await call('DELETE', url, world.accountant)
    expect(off.status).toBe(200)
    expect(off.body.analytic.isActive).toBe(false)
    const stored: any = await AccountingAnalytic.findById(row._id).lean()
    expect(stored.isActive).toBe(false)
    expect(stored.deactivatedAt).toBeInstanceOf(Date)
    expect(await AuditLog.countDocuments({ orgId: world.native, action: 'deactivate', entityId: row._id })).toBe(1)

    const on = await call('PUT', url, world.accountant, { isActive: true })
    expect(on.body.analytic.isActive).toBe(true)
    expect(((await AccountingAnalytic.findById(row._id).lean()) as any).deactivatedAt).toBeUndefined()
  })
})

describe('who may', () => {
  it('reads with the chart (accounting), and changes with `accounts.edit`', async () => {
    const row = world.byPath(world.native, 'КЛИЕНТИ:Клиент А')
    expect((await call('GET', base(), world.member)).status).toBe(200)
    // A member reads the accounting app and writes nothing in it.
    expect((await call('PUT', `${base()}/${row._id}`, world.member, { isActive: true })).status).toBe(403)
    expect((await call('DELETE', `${base()}/${row._id}`, world.member)).status).toBe(403)
    // A warehouse manager has no accounting at all.
    expect((await call('GET', base(), world.warehouse)).status).toBe(403)
  })

  it('never across orgs: another org\'s URL is refused, and its ids are not found here', async () => {
    expect((await call('GET', `/org/${world.other}/accounting/analytics`, world.admin)).status).toBe(403)
    expect((await call('GET', `/org/${world.other}/accounting/analytics/roots`, world.admin)).status).toBe(403)
    const theirs = world.byPath(world.other, 'КЛИЕНТИ:Чужд')
    expect((await call('GET', `/org/${world.other}/accounting/analytics/${theirs._id}`, world.admin)).status).toBe(403)
    expect((await call('PUT', `/org/${world.other}/accounting/analytics/${theirs._id}`, world.admin, { isActive: false })).status).toBe(403)
    // Their analytic's id under our org's URL: not ours, so not there.
    expect((await call('GET', `${base()}/${theirs._id}`, world.admin)).status).toBe(404)
    expect((await call('DELETE', `${base()}/${theirs._id}`, world.admin)).status).toBe(404)
    expect(((await AccountingAnalytic.findById(theirs._id).lean()) as any).isActive).toBe(true)
  })
})

describe('the bank accounts\' operations this month (FR-25a §3.3)', () => {
  it('counts the bank documents that touched each account through its analytic', async () => {
    const bankAnalytic = world.byPath(world.native, 'БАНКОВИ СМЕТКИ:XX00TEST0001')
    const account = await createTestAccount(world.native, { code: '503' } as any)
    let n = 0
    const entry = (date: string, extra: Record<string, unknown>) => ({
      orgId: world.native, entryNumber: `T-${++n}`, date: new Date(`${date}T00:00:00.000Z`), fiscalPeriodId: new mongoose.Types.ObjectId(),
      description: 'Bank', status: 'posted', createdBy: new mongoose.Types.ObjectId(), totalDebit: 1, totalCredit: 1,
      lines: [
        { accountId: account._id, debit: 1, credit: 0, baseDebit: 1, baseCredit: 0, analyticId: bankAnalytic._id },
        { accountId: account._id, debit: 0, credit: 1, baseDebit: 0, baseCredit: 1, analyticId: bankAnalytic._id },
      ],
      ...extra,
    })
    await JournalEntry.insertMany([
      entry('2026-03-02', { bankOperation: 'Плащане' }),
      entry('2026-03-31', { bankOperation: 'Превод' }),
      // Not a bank document; another month; a draft; the shadow ledger.
      entry('2026-03-05', {}),
      entry('2026-04-01', { bankOperation: 'Плащане' }),
      entry('2026-03-06', { bankOperation: 'Плащане', status: 'draft' }),
      entry('2026-03-07', { bankOperation: 'Плащане', ledger: 'shadow' }),
    ])

    const res = await call('GET', `${base()}/bank-operations?month=2026-03`, world.accountant)
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ month: '2026-03', counts: { [String(world.bank._id)]: 2 } })
    expect((await call('GET', `${base()}/bank-operations?month=2026-13`, world.accountant)).status).toBe(422)
    // An org with no analytic linked to a bank account has no counts.
    expect((await call('GET', `/org/${world.books}/accounting/analytics/bank-operations?month=2026-03`, world.booksAdmin)).body.counts).toEqual({})
  })
})

describe('the export', () => {
  it('is an Excel sheet of the filtered grid', async () => {
    const labels = encodeURIComponent(JSON.stringify({ title: 'Аналитики', columns: { path: 'Път' } }))
    const res = await call('GET', `${base()}/export?root=${encodeURIComponent('КЛИЕНТИ')}&labels=${labels}`, world.accountant)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('spreadsheetml')
    expect(res.headers.get('content-disposition')).toContain('.xlsx')
    expect((res.body as ArrayBuffer).byteLength).toBeGreaterThan(1000)
  })
})

describe('the chart\'s filters from the books (FR-25a §3.1)', () => {
  it('lists the accounts with analytics, and the quantitative ones', async () => {
    const org = await createTestOrg()
    const token = await tokenFor(org._id, 'accountant')
    await Account.insertMany([
      { orgId: org._id, code: '304', name: 'Стоки', type: 'asset', subType: 'current_asset', balanceSide: 'debit', analyticRoots: ['СТОКИ'], quantitative: true },
      { orgId: org._id, code: '411', name: 'Клиенти', type: 'asset', subType: 'current_asset', balanceSide: 'both', analyticRoots: ['КЛИЕНТИ'] },
      { orgId: org._id, code: '501', name: 'Каса', type: 'asset', subType: 'current_asset' },
    ])
    const codes = async (qs: string) =>
      ((await call('GET', `/org/${org._id}/accounting/account?size=0&sortBy=code&sortOrder=asc&${qs}`, token)).body.accounts as any[]).map(a => a.code)
    expect(await codes('')).toEqual(['304', '411', '501'])
    expect(await codes('hasAnalytics=true')).toEqual(['304', '411'])
    expect(await codes('hasAnalytics=false')).toEqual(['501'])
    expect(await codes('quantitative=true')).toEqual(['304'])
    expect(await codes('quantitative=false')).toEqual(['411', '501'])
  })
})
