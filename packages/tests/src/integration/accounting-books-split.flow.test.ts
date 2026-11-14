import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'bun:test'
import { join } from 'node:path'
import { Elysia } from 'elysia'
import jwt from '@elysiajs/jwt'
import { clearCollections, setupTestDB, teardownTestDB, testDbUri } from '../setup'
import { createTestOrg, createTestUser } from '../helpers/factories'
import { captureRejection } from '../helpers/capture-rejection'
import { config } from 'config'
import { DEFAULT_ROLE_PERMISSIONS } from 'config/constants'
import { Account, AccountingAnalytic, Contact, FiscalPeriod, FiscalYear, JournalEntry, Org } from 'db/models'
import {
  BooksImportError,
  finishImport,
  importAnalytics,
  importChart,
  importJournalMonth,
  importOpening,
} from 'services/biz/accounting-books/import.service'
import { BooksLinkError, linkBooks } from 'services/biz/accounting-books/link-books.service'
import { analyticTrialBalance, mainBook, trialBalance } from 'services/biz/accounting-books/books-ledger'
import { getBalanceSheet } from 'services/biz/accounting.service'
import {
  compareAnalyticTrialBalance,
  compareMainBook,
  compareTrialBalance,
  sumAnalyticTrialBalances,
  sumMainBooks,
  sumTrialBalances,
} from 'services/biz/accounting-books/compare'
import { parseAnalyticsFile, type AnalyticItem } from 'services/biz/accounting-books/plusminus-exports'
import type { ImportDocument, JournalBody, OpeningBody } from 'services/biz/accounting-books/import.types'
import { createApiApp } from '../../../portal-api/src/api.js'

/**
 * FR-25 R7: one legal entity's books split over its two store orgs. The home keeps everything no
 * store's series names (the opening, purchases, the bank, operations with no document, the till and a
 * store outside LGR); a store keeps the sales documents of its own series. Both are sent the same
 * files. Fictional data only.
 *
 * What must hold: each entry lands in exactly one org, the shares add up to what one books org holding
 * everything reads (balances included, across a year's opening), a re-import is unchanged per org, and
 * a store gets a Contact only for a partner its own entries name.
 */

const EIK = '000000000'
const SERIES_A = '00001'
const SERIES_B = '00002'
const SERIES_W = '00009'

const CHART = [
  ['101', 'Основен капитал'], ['304', 'Стоки'], ['401', 'Доставчици'], ['411', 'Клиенти'], ['4531', 'ДДС за покупките'],
  ['4532', 'ДДС за продажбите'], ['4539', 'ДДС за внасяне'], ['501', 'Каса'], ['503', 'Разплащателна сметка'], ['702', 'Приходи от стоки'],
].map(([code, name]) => ({ code, name }))

const GOODS = 'СТОКИ:БОЛТОВЕ'
const CUST_A = 'КЛИЕНТИ:Клиент А'
const CUST_B = 'КЛИЕНТИ:Клиент Б'
const CUST_C = 'КЛИЕНТИ:Клиент В'
const CUST_D = 'КЛИЕНТИ:Клиент Г'
const SUPPLIER = 'ДОСТАВЧИЦИ:Доставчик А'
const TILL = 'КЛИЕНТИ:ОБОРОТ ОТ КАСОВИ ПРОДАЖБИ'
const BANK = 'БАНКОВИ СМЕТКИ:XX00BANK0000000000000001'

/**
 * The analytics files as `pull-books` writes them (`ap_<ROOT>_<ЕИК>.json`), every root in one: a group row,
 * then the items with their ПАРАМЕТРИ. Read by the books' own parser, as the importer sends them: no property
 * is ever typed into the database by hand here.
 */
const AP_ROWS = [
  { ap: 'СТОКИ', params: {}, group: 'true' },
  { ap: GOODS, params: { 'МЯРКА': 'бр' } },
  { ap: 'КЛИЕНТИ', params: {}, group: 'true' },
  { ap: CUST_A, params: { 'БУЛСТАТ': '000000011', 'ИНДДС': '', 'АДРЕС': 'ул. Първа 1', 'ГРАД': 'гр. Пример', 'МОЛ': 'Лице А' } },
  { ap: CUST_B, params: { 'БУЛСТАТ': '000000022', 'ИНДДС': 'BG000000022', 'АДРЕС': 'ул. Втора 2', 'ГРАД': 'Друго', 'МОЛ': 'Лице Б' } },
  { ap: CUST_C, params: { 'БУЛСТАТ': '000000033' } },
  { ap: CUST_D, params: { 'БУЛСТАТ': '000000055' } },
  { ap: TILL, params: {} },
  { ap: 'ДОСТАВЧИЦИ', params: {}, group: 'true' },
  { ap: SUPPLIER, params: { 'БУЛСТАТ': '000000044', 'ГРАД': 'Трето' } },
  { ap: 'БАНКОВИ СМЕТКИ', params: {}, group: 'true' },
  { ap: BANK, params: {} },
]
const apFile = () => new TextEncoder().encode(JSON.stringify(AP_ROWS))
const ITEMS: AnalyticItem[] = parseAnalyticsFile(apFile())

const saleA: ImportDocument = { date: '2025-03-03', docType: '-ФЕ', docNumber: `${SERIES_A}00101`, vatKind: '1', total: 120, ops: [
  { d: '702', k: '304', ak: GOODS, qty: 10, amount: 60.1234 },
  { d: '411', k: '702', ad: CUST_A, amount: 100 },
  { d: '411', k: '4532', ad: CUST_A, amount: 20 },
] }
const saleB: ImportDocument = { date: '2025-03-04', docType: '-ФЕ', docNumber: `${SERIES_B}00101`, vatKind: '1', total: 240, ops: [
  { d: '702', k: '304', ak: GOODS, qty: 20, amount: 120.5 },
  { d: '411', k: '702', ad: CUST_B, amount: 200 },
  { d: '411', k: '4532', ad: CUST_B, amount: 40 },
] }
const purchase: ImportDocument = { date: '2025-03-05', docType: '+ФЕ', docNumber: '77', vatKind: '1', total: 120, ops: [
  { d: '304', k: '401', ad: GOODS, ak: SUPPLIER, qty: 30, amount: 100 },
  { d: '4531', k: '401', ak: SUPPLIER, amount: 20 },
] }
// Customer B pays store B's invoice through the bank: the bank document is still the home's.
const bank: ImportDocument = { date: '2025-03-12', docType: '+ББ', docNumber: '901', comment: `-ФЕ ${SERIES_B}00101`, ops: [
  { d: '503', k: '411', ad: BANK, ak: CUST_B, amount: 240, comment: `-ФЕ ${SERIES_B}00101` },
] }
const noDocument: ImportDocument = { date: '2025-03-31', ops: [{ d: '4532', k: '4539', amount: 60 }] }
const outside: ImportDocument = { date: '2025-03-20', docType: '-ФЕ', docNumber: `${SERIES_W}00001`, total: 12, ops: [
  { d: '501', k: '702', amount: 10 }, { d: '501', k: '4532', amount: 2 },
] }
const till: ImportDocument = { date: '2025-03-31', docType: 'КП', docNumber: '1', vatKind: '3', total: 60, ops: [
  { d: '411', k: '702', ad: TILL, amount: 50 }, { d: '411', k: '4532', ad: TILL, amount: 10 }, { d: '501', k: '411', ak: TILL, amount: 60 },
] }
const MARCH = [saleA, saleB, purchase, bank, noDocument, outside, till]

const COVERAGE_2025 = { from: '2025-01-01', to: '2025-12-31' }
const COVERAGE_2026 = { from: '2026-01-01', to: '2026-12-31' }

const OPENING_2025: Omit<OpeningBody, 'eik'> = {
  year: 2025,
  accounts: [{ code: '101', debit: 0, credit: 1000 }, { code: '304', debit: 700, credit: 0 }, { code: '411', debit: 300, credit: 0 }],
  analytics: [{ code: '304', path: GOODS, debit: 700, credit: 0, quantity: 70 }, { code: '411', path: CUST_C, debit: 300, credit: 0 }],
}

interface Group {
  home: string
  store: string
  /** A books org of its own that imports the same files: what the two shares must add up to. */
  whole: string
  by: { id: string }
}

let seq = 0
let group: Group

async function makeGroup(): Promise<Group> {
  const n = ++seq
  const home = await createTestOrg({ slug: `store-a-${n}`, name: 'Магазин А', taxNumber: EIK } as any)
  const store = await createTestOrg({ slug: `store-b-${n}`, name: 'Магазин Б', taxNumber: EIK } as any)
  const whole = await createTestOrg({ slug: `books-${n}`, name: 'Книги', taxNumber: EIK } as any)
  await linkBooks({
    booksSlug: home.slug,
    split: true,
    branches: [{ slug: home.slug, code: 'A', docSeries: [SERIES_A] }, { slug: store.slug, code: 'B', docSeries: [SERIES_B] }],
    externalBranches: [{ code: 'W', docSeries: [SERIES_W] }],
  }, { dryRun: false })
  // The books org of its own names the same stores, as the one the split leaves does.
  await Org.updateOne({ _id: whole._id }, { $set: { 'settings.accounting.books': { mode: 'books', branches: [
    { orgId: home._id, code: 'A', label: 'Магазин А', docSeries: [SERIES_A] },
    { orgId: store._id, code: 'B', label: 'Магазин Б', docSeries: [SERIES_B] },
  ] } } })
  const user = await createTestUser(home._id as any)
  return { home: String(home._id), store: String(store._id), whole: String(whole._id), by: { id: String(user._id) } }
}

const execute = { eik: EIK, dryRun: false }
const orgsOf = () => [group.home, group.store, group.whole]

const journal = (orgId: string, month: string, documents: ImportDocument[], over: Partial<JournalBody> = {}) =>
  importJournalMonth(orgId, { ...execute, month, coverage: month < '2026' ? COVERAGE_2025 : COVERAGE_2026, documents, ...over }, group.by)

async function chartAndAnalytics(orgs = orgsOf()): Promise<void> {
  for (const orgId of orgs) {
    await importChart(orgId, { ...execute, accounts: CHART }, group.by)
    await importAnalytics(orgId, { ...execute, items: ITEMS }, group.by)
  }
}

const signer = new Elysia().use(jwt({ name: 'jwt', secret: config.jwt.secret }))

/** A signed-in admin of `orgId`, as the books' service account signs in to each org of the split. */
async function tokenFor(orgId: string): Promise<string> {
  const user = await createTestUser(orgId as any, { role: 'admin' } as any)
  return (signer as any).decorator.jwt.sign({
    id: String(user._id), orgId, role: 'admin', email: user.email, username: user.username,
    firstName: 'Test', lastName: 'User', permissions: DEFAULT_ROLE_PERMISSIONS.admin, ownRecordsModules: [],
  })
}

const entries = (orgId: string, filter: Record<string, unknown> = {}) => JournalEntry.find({ orgId, ...filter }).lean() as Promise<any[]>
const keysOf = async (orgId: string) => (await entries(orgId, { type: { $ne: 'opening' } })).map(e => e.importKey).sort()
const contactNames = async (orgId: string) => (await Contact.find({ orgId }, { companyName: 1 }).lean()).map((c: any) => c.companyName).sort()

beforeAll(async () => {
  await setupTestDB()
}, 120_000)

afterAll(async () => {
  await teardownTestDB()
}, 60_000)

beforeEach(async () => {
  await clearCollections()
  group = await makeGroup()
})

describe('each entry lands in exactly one org of the group', () => {
  beforeEach(async () => {
    await chartAndAnalytics()
  })

  it('a store keeps its series\' sales; the home keeps the rest, a store outside LGR and the till included', async () => {
    const home = await journal(group.home, '2025-03', MARCH)
    const store = await journal(group.store, '2025-03', MARCH)

    expect(home).toMatchObject({ entries: 6, documents: 5, new: 6, balanced: 6, split: { role: 'home', fileEntries: 7 } })
    expect(store).toMatchObject({ entries: 1, documents: 1, operations: 3, new: 1, balanced: 1, split: { role: 'member', fileEntries: 7 } })
    // The shares add up to the file, and no entry is held twice.
    expect(home.entries + store.entries).toBe(home.split!.fileEntries)

    const storeEntries = await entries(group.store)
    expect(storeEntries.map(e => [e.docType, e.docNumber])).toEqual([['-ФЕ', saleB.docNumber]])
    expect(String(storeEntries[0].branchOrgId)).toBe(group.store)
    expect(storeEntries[0].lines.every((l: any) => String(l.branchOrgId) === group.store)).toBe(true)

    const homeEntries = await entries(group.home)
    expect(homeEntries.map(e => e.docNumber ?? 'none').sort()).toEqual(['1', '77', '901', `${SERIES_A}00101`, `${SERIES_W}00001`, 'none'].sort())
    // The home's own sales carry the home as their store, as everything else of it does.
    expect(homeEntries.every(e => String(e.branchOrgId) === group.home)).toBe(true)

    // The books org of its own holds all seven, keyed exactly as the shares are.
    await journal(group.whole, '2025-03', MARCH)
    expect(await keysOf(group.whole)).toEqual([...await keysOf(group.home), ...await keysOf(group.store)].sort())
  })

  it('a dry rerun is unchanged in every org: `unchanged` equals `entries`', async () => {
    for (const orgId of [group.home, group.store]) await journal(orgId, '2025-03', MARCH)
    for (const orgId of [group.home, group.store]) {
      const rerun = await journal(orgId, '2025-03', MARCH, { dryRun: true })
      expect(rerun.unchanged).toBe(rerun.entries)
      expect(rerun).toMatchObject({ new: 0, changed: 0, gone: 0 })
    }
  })

  it('a document renumbered into another store\'s series is gone from one org and new in the other', async () => {
    for (const orgId of [group.home, group.store]) await journal(orgId, '2025-03', MARCH)
    const renumbered = { ...saleB, docNumber: `${SERIES_A}00102` }
    const month = MARCH.map(d => (d === saleB ? renumbered : d))

    const store = await journal(group.store, '2025-03', month)
    const home = await journal(group.home, '2025-03', month)
    expect(store).toMatchObject({ entries: 0, gone: 1, new: 0 })
    expect(home).toMatchObject({ entries: 7, new: 1, gone: 0, unchanged: 6 })
    expect(await entries(group.store)).toEqual([])
    expect((await entries(group.home, { docNumber: renumbered.docNumber })).length).toBe(1)
  })

  it('numbers each org\'s entries in a series of its own', async () => {
    for (const orgId of [group.home, group.store]) await journal(orgId, '2025-03', MARCH)
    const numbers = async (orgId: string) => (await entries(orgId)).map(e => e.entryNumber).sort()
    expect((await numbers(group.store))).toEqual(['PM-2025-000001'])
    expect((await numbers(group.home))[0]).toBe('PM-2025-000001')
    expect(new Set(await numbers(group.home)).size).toBe(6)
  })

  it('every org holds the whole chart and the whole tree', async () => {
    const chart = async (orgId: string) => (await Account.find({ orgId }, { code: 1 }).lean()).map((a: any) => a.code).sort()
    const tree = async (orgId: string) => (await AccountingAnalytic.find({ orgId }, { path: 1 }).lean()).map((a: any) => a.path).sort()
    expect(await chart(group.store)).toEqual(await chart(group.home))
    expect((await chart(group.home)).length).toBe(CHART.length)
    expect(await tree(group.store)).toEqual(await tree(group.home))
  })
})

describe('a store\'s contacts', () => {
  it('are made only for partners its own entries name, from what the analytic keeps', async () => {
    const answer = await importAnalytics(group.store, { ...execute, items: ITEMS }, group.by)
    // Nothing is made at analytics time in a store: the partners wait for an entry that names them.
    expect(answer.contacts).toEqual({ created: 0, linked: 0, withoutIdentifier: 1, deferred: 6 })
    expect(await Contact.countDocuments({ orgId: group.store })).toBe(0)

    await importChart(group.store, { ...execute, accounts: CHART }, group.by)
    const month = await journal(group.store, '2025-03', MARCH)
    expect(month.split!.contacts).toEqual({ created: 1, linked: 0 })
    // Customer B only: not store A's customer, not the supplier, not a customer with an opening only.
    expect(await contactNames(group.store)).toEqual(['Клиент Б'])
    const made: any = await Contact.findOne({ orgId: group.store }).lean()
    expect(made).toMatchObject({ type: 'customer', taxId: '000000022', vatNumber: 'BG000000022' })
    const line = (await entries(group.store))[0].lines.find((l: any) => l.contactId)
    expect(String(line.contactId)).toBe(String(made._id))
  })

  it('the home gets those its own entries and its opening name, with their numbers and address', async () => {
    await chartAndAnalytics([group.home])
    await importOpening(group.home, { ...execute, ...OPENING_2025 }, group.by)
    await journal(group.home, '2025-03', MARCH)
    // A, the supplier, B (through the bank), the till, and C (an opening balance). Not D: nothing names it.
    expect(await contactNames(group.home)).toEqual(['Доставчик А', 'Клиент А', 'Клиент Б', 'Клиент В', 'ОБОРОТ ОТ КАСОВИ ПРОДАЖБИ'].sort())
    const a: any = await Contact.findOne({ orgId: group.home, companyName: 'Клиент А' }).lean()
    expect(a).toMatchObject({ type: 'customer', taxId: '000000011', taxNumber: '000000011' })
    expect(a.addresses[0]).toMatchObject({ street: 'ул. Първа 1', city: 'Пример' })
    expect((await Contact.findOne({ orgId: group.home, companyName: 'Доставчик А' }).lean() as any).type).toBe('supplier')
  })

  it('a store\'s contact who both buys and sells is found for a customer, and keeps its type', async () => {
    const both = await Contact.create({ orgId: group.store, type: 'both', companyName: 'Клиент Б ЕООД', taxId: '000000022' })
    const answer = await importAnalytics(group.store, { ...execute, items: ITEMS }, group.by)
    expect(answer.contacts).toMatchObject({ created: 0, linked: 1, deferred: 5 })
    expect(String((await AccountingAnalytic.findOne({ orgId: group.store, path: CUST_B }).lean() as any).contactId)).toBe(String(both._id))

    await importChart(group.store, { ...execute, accounts: CHART }, group.by)
    expect((await journal(group.store, '2025-03', MARCH)).split!.contacts).toEqual({ created: 0, linked: 0 })
    expect(await Contact.countDocuments({ orgId: group.store })).toBe(1)
    expect((await Contact.findById(both._id).lean() as any).type).toBe('both')
    const line = (await entries(group.store))[0].lines.find((l: any) => l.contactId)
    expect(String(line.contactId)).toBe(String(both._id))
  })

  it('a supplier of the store is the company a customer of the books names: found by its number however it is written, and keeps its type', async () => {
    // The shop buys from this company and typed its number with spaces; the books sell to it.
    const supplier = await Contact.create({ orgId: group.store, type: 'supplier', companyName: 'Клиент Б ООД', taxId: '000 000 022' })
    await importChart(group.store, { ...execute, accounts: CHART }, group.by)
    expect((await importAnalytics(group.store, { ...execute, items: ITEMS }, group.by)).contacts).toMatchObject({ created: 0, linked: 1, deferred: 5 })
    expect((await journal(group.store, '2025-03', MARCH)).split!.contacts).toEqual({ created: 0, linked: 0 })

    expect(await Contact.countDocuments({ orgId: group.store })).toBe(1)
    expect(await Contact.findById(supplier._id).lean()).toMatchObject({ type: 'supplier', taxId: '000 000 022' })
    const line = (await entries(group.store))[0].lines.find((l: any) => l.contactId)
    expect(String(line.contactId)).toBe(String(supplier._id))
  })

  it('a number held only as a VAT number, or only in the form\'s ЕИК field, is found; a placeholder is not', async () => {
    const vat = await Contact.create({ orgId: group.store, type: 'customer', companyName: 'Клиент Б', vatNumber: 'BG 000000022' })
    const form = await Contact.create({ orgId: group.store, type: 'both', companyName: 'Клиент В', taxNumber: '000-000-033' })
    await Contact.create({ orgId: group.store, type: 'customer', companyName: 'Някой', taxId: '000000000' })
    await importAnalytics(group.store, { ...execute, items: [...ITEMS, { path: 'КЛИЕНТИ:Без номер', taxId: '000 000 000' }] }, group.by)
    const linked = async (path: string) => (await AccountingAnalytic.findOne({ orgId: group.store, path }).lean() as any).contactId
    expect(String(await linked(CUST_B))).toBe(String(vat._id))
    expect(String(await linked(CUST_C))).toBe(String(form._id))
    // A placeholder names no company: the partner is looked up by its name, which no contact has.
    expect(await linked('КЛИЕНТИ:Без номер')).toBeUndefined()
  })

  it('a store\'s own contacts are never filled in by the books', async () => {
    const own = await Contact.create({ orgId: group.store, type: 'customer', companyName: 'Клиент Б', taxId: '000000022' })
    await importAnalytics(group.store, { ...execute, items: ITEMS }, group.by)
    await importAnalytics(group.store, { ...execute, items: ITEMS }, group.by)
    expect((await Contact.findById(own._id).lean() as any).vatNumber).toBeUndefined()
  })
})

describe('the opening', () => {
  beforeEach(async () => {
    await chartAndAnalytics()
  })

  it('is the home\'s alone: a store answers unchanged and writes nothing', async () => {
    const home = await importOpening(group.home, { ...execute, ...OPENING_2025 }, group.by)
    expect(home).toMatchObject({ outcome: 'new', lines: 3, balanced: true, continuity: null, split: { role: 'home' } })
    const store = await importOpening(group.store, { ...execute, ...OPENING_2025 }, group.by)
    expect(store).toEqual({
      dryRun: false, year: 2025, currency: 'BGN', outcome: 'unchanged', lines: 0, balanced: true,
      accountsWithRemainder: [], unknownAccounts: [], analyticsToCreate: 0, continuity: null, split: { role: 'member' },
    })
    expect(await entries(group.store)).toEqual([])
    expect(await entries(group.home, { type: 'opening' })).toHaveLength(1)
    expect(await Contact.countDocuments({ orgId: group.store })).toBe(0)
  })

  it('a store refuses another company\'s file all the same', async () => {
    const err = await captureRejection(importOpening(group.store, { ...execute, ...OPENING_2025, eik: '111111111' }, group.by))
    expect(err).toBeInstanceOf(BooksImportError)
    expect(err.code).toBe('other_company')
  })
})

describe('the shares add up to the company\'s books', () => {
  const JANUARY: ImportDocument[] = [
    { date: '2026-01-05', docType: '-ФЕ', docNumber: `${SERIES_B}00201`, total: 24, ops: [{ d: '411', k: '702', ad: CUST_B, amount: 20 }, { d: '411', k: '4532', ad: CUST_B, amount: 4 }] },
    { date: '2026-01-06', docType: '+ФЕ', docNumber: '88', total: 12, ops: [{ d: '304', k: '401', ad: GOODS, ak: SUPPLIER, qty: 1, amount: 10 }, { d: '4531', k: '401', ak: SUPPLIER, amount: 2 }] },
  ]

  /** Both years in every org; 2026's opening is what the books org of its own closed 2025 with. */
  async function twoYears(): Promise<void> {
    await chartAndAnalytics()
    for (const orgId of orgsOf()) {
      await importOpening(orgId, { ...execute, ...OPENING_2025 }, group.by)
      await journal(orgId, '2025-03', MARCH)
    }
    const closing = (await trialBalance(group.whole, COVERAGE_2025)).rows
    const opening2026 = {
      year: 2026,
      accounts: closing.map(r => ({ code: r.code, debit: r.closingDebit / 1.95583, credit: r.closingCredit / 1.95583 })).filter(a => a.debit || a.credit),
    }
    for (const orgId of orgsOf()) {
      await importOpening(orgId, { ...execute, ...opening2026 }, group.by)
      await journal(orgId, '2026-01', JANUARY)
    }
  }

  const expectEqual = (verdict: { differingCells: number; rows: number }) => {
    expect(verdict.differingCells).toBe(0)
    expect(verdict.rows).toBeGreaterThan(0)
  }

  it('per account, per analytic and per correspondent, in both years and across the year\'s opening', async () => {
    await twoYears()
    for (const period of [COVERAGE_2025, { from: '2025-03-01', to: '2025-03-31' }, COVERAGE_2026, { from: '2026-01-06', to: '2026-12-31' }]) {
      const tb = await Promise.all(orgsOf().map(o => trialBalance(o, period)))
      expect(tb[0].currency).toBe(tb[2].currency)
      expect(tb[1].currency).toBe(tb[2].currency)
      expectEqual(compareTrialBalance(sumTrialBalances([tb[0].rows, tb[1].rows]), tb[2].rows))

      const atb = await Promise.all(orgsOf().map(o => analyticTrialBalance(o, period)))
      expectEqual(compareAnalyticTrialBalance(sumAnalyticTrialBalances([atb[0].rows, atb[1].rows]), atb[2].rows))

      const mb = await Promise.all(orgsOf().map(o => mainBook(o, period)))
      expectEqual(compareMainBook(sumMainBooks([mb[0].accounts, mb[1].accounts]), mb[2].accounts))
    }
  })

  it('a store\'s share of a year is not added again after the home\'s next opening', async () => {
    await twoYears()
    // Store B sold in 2025; that is in the home's 2026 opening, so the store's 2026 starts from nothing.
    const store2026 = (await trialBalance(group.store, COVERAGE_2026)).rows.find(r => r.code === '702')!
    expect(store2026).toMatchObject({ openingDebit: 0, openingCredit: 0, turnoverCredit: 20 })
  })

  it('`finish` rebuilds each org\'s balances from its own lines, and they add up to the company\'s', async () => {
    await twoYears()
    for (const orgId of orgsOf()) expect((await finishImport(orgId, execute, group.by)).changed).toBeGreaterThan(0)
    const balances = async (orgId: string) => new Map((await Account.find({ orgId }, { code: 1, balance: 1 }).lean()).map((a: any) => [a.code, a.balance]))
    const [home, store, whole] = await Promise.all(orgsOf().map(balances))
    for (const { code } of CHART) expect(Math.round(((home.get(code) ?? 0) + (store.get(code) ?? 0)) * 100) / 100).toBeCloseTo(whole.get(code) ?? 0, 2)
    for (const orgId of orgsOf()) expect((await finishImport(orgId, execute, group.by)).changed).toBe(0)
  })

  it('so do the balance sheets, read from the lines', async () => {
    await twoYears()
    const asOf = new Date('2026-06-30T00:00:00.000Z')
    const [home, store, whole] = await Promise.all(orgsOf().map(o => getBalanceSheet(o, asOf)))
    const total = (s: any) => Math.round((s.totalAssets - s.totalLiabilitiesAndEquity) * 100) / 100
    expect(Math.round((home.totalAssets + store.totalAssets) * 100) / 100).toBeCloseTo(whole.totalAssets, 2)
    expect(total(home) + total(store)).toBeCloseTo(total(whole), 2)
  })
})

describe('the fiscal years a store org already has', () => {
  it('a year typed in by hand is used, and the year before it made, beside a locked older one', async () => {
    // As the year form makes them: midnights in UTC, and no periods.
    const y2026 = await FiscalYear.create({ orgId: group.home, name: 'FY 2026', startDate: new Date('2026-01-01T00:00:00.000Z'), endDate: new Date('2026-12-31T00:00:00.000Z'), status: 'open' })
    await FiscalYear.create({ orgId: group.home, name: 'FY 2024', startDate: new Date('2024-01-01T00:00:00.000Z'), endDate: new Date('2024-12-31T00:00:00.000Z'), status: 'locked' })
    await chartAndAnalytics([group.home])

    await importOpening(group.home, { ...execute, ...OPENING_2025 }, group.by)
    await journal(group.home, '2025-03', MARCH)
    await journal(group.home, '2026-01', [{ date: '2026-01-06', docType: '+ФЕ', docNumber: '88', ops: [{ d: '304', k: '401', ad: GOODS, ak: SUPPLIER, amount: 10 }] }])

    const years: any[] = await FiscalYear.find({ orgId: group.home }).sort({ startDate: 1 }).lean()
    expect(years.map(y => [y.name, y.status])).toEqual([['FY 2024', 'locked'], ['FY 2025', 'open'], ['FY 2026', 'open']])
    expect(await FiscalPeriod.countDocuments({ orgId: group.home, fiscalYearId: y2026._id })).toBe(12)
    expect(await FiscalPeriod.countDocuments({ orgId: group.home, fiscalYearId: years[0]._id })).toBe(0)
    const january: any = (await entries(group.home, { docNumber: '88' }))[0]
    expect(String((await FiscalPeriod.findById(january.fiscalPeriodId).lean() as any).fiscalYearId)).toBe(String(y2026._id))
  })

  it('an org with no year gets the years its months need', async () => {
    await chartAndAnalytics([group.store])
    expect(await journal(group.store, '2025-03', MARCH)).toMatchObject({ fiscalPeriod: 'created' })
    expect(await journal(group.store, '2026-01', [], { dryRun: true })).toMatchObject({ fiscalPeriod: 'would_create' })
    await journal(group.store, '2026-01', [])
    expect((await FiscalYear.find({ orgId: group.store }).lean()).map((y: any) => y.name).sort()).toEqual(['FY 2025', 'FY 2026'])
    expect(await FiscalPeriod.countDocuments({ orgId: group.store })).toBe(24)
  })

  it('a closed period is refused as before, and so is a locked year that has no periods', async () => {
    await chartAndAnalytics([group.home, group.store])
    await journal(group.store, '2025-03', MARCH)
    await FiscalPeriod.updateMany({ orgId: group.store, number: 3 }, { $set: { status: 'closed' } })
    const closed = await captureRejection(journal(group.store, '2025-03', MARCH))
    expect(closed).toBeInstanceOf(BooksImportError)
    expect(closed.code).toBe('period_closed')

    await FiscalYear.create({ orgId: group.home, name: 'FY 2025', startDate: new Date('2025-01-01T00:00:00.000Z'), endDate: new Date('2025-12-31T00:00:00.000Z'), status: 'locked' })
    const locked = await captureRejection(journal(group.home, '2025-03', MARCH))
    expect(locked.code).toBe('period_closed')
    expect(await captureRejection(journal(group.home, '2025-03', MARCH, { dryRun: true }))).toMatchObject({ code: 'period_closed' })
    expect(await FiscalPeriod.countDocuments({ orgId: group.home })).toBe(0)
    expect(await entries(group.home)).toEqual([])
  })
})

describe('linking a split', () => {
  const code = async (p: Promise<unknown>) => {
    const err = await captureRejection(p)
    expect(err).toBeInstanceOf(BooksLinkError)
    return err.code
  }
  const books = async (slug: string) => ((await Org.findOne({ slug }).lean()) as any).settings.accounting?.books

  it('writes the same list and the same home into every branch, on --execute only, and says so again as already', async () => {
    const a = await createTestOrg({ slug: 'split-a', taxNumber: EIK } as any)
    const b = await createTestOrg({ slug: 'split-b', taxNumber: EIK } as any)
    const spec = { booksSlug: 'split-a', split: true, branches: [{ slug: 'split-a', code: 'A', docSeries: [SERIES_A] }, { slug: 'split-b', code: 'B', docSeries: [SERIES_B] }] }

    expect(await linkBooks(spec, { dryRun: true })).toEqual({
      dryRun: true,
      booksOrg: { slug: 'split-a', state: 'exists' },
      branches: [{ slug: 'split-a', code: 'A', state: 'would_link', docSeries: [SERIES_A] }, { slug: 'split-b', code: 'B', state: 'would_link', docSeries: [SERIES_B] }],
      externalBranches: [],
      split: { home: 'split-a' },
    })
    expect(await books('split-a')).toBeUndefined()

    await linkBooks(spec, { dryRun: false })
    const held = await books('split-a')
    expect(held).toEqual(await books('split-b'))
    expect(held).toMatchObject({ mode: 'books', split: { homeOrgId: a._id } })
    expect(held.branches.map((x: any) => [String(x.orgId), x.code, x.docSeries])).toEqual([[String(a._id), 'A', [SERIES_A]], [String(b._id), 'B', [SERIES_B]]])
    expect((await linkBooks(spec, { dryRun: true })).branches.map(x => x.state)).toEqual(['already', 'already'])
  })

  it('takes the stores out of the books org named with --from, which keeps its copy and its stores outside LGR', async () => {
    await createTestOrg({ slug: 'from-a', taxNumber: EIK } as any)
    await createTestOrg({ slug: 'from-b', taxNumber: EIK } as any)
    await createTestOrg({ slug: 'from-books', taxNumber: EIK } as any)
    const branches = [{ slug: 'from-a', code: 'A', docSeries: [SERIES_A] }, { slug: 'from-b', code: 'B', docSeries: [SERIES_B] }]
    await linkBooks({ booksSlug: 'from-books', branches, externalBranches: [{ code: 'W', docSeries: [SERIES_W] }] }, { dryRun: false })
    const before = await books('from-books')

    // Named without their series: each store keeps the one the books org it leaves holds for it.
    const spec = { booksSlug: 'from-a', split: true, branches: branches.map(({ slug, code }) => ({ slug, code })) }
    expect(await code(linkBooks(spec, { dryRun: true }))).toBe('linked_elsewhere')
    const answer = await linkBooks({ ...spec, from: 'from-books' }, { dryRun: false })
    expect(answer.branches.map(x => [x.slug, x.state, x.docSeries, x.leaves])).toEqual([
      ['from-a', 'linked', [SERIES_A], 'from-books'],
      ['from-b', 'linked', [SERIES_B], 'from-books'],
    ])
    expect(answer.externalBranches).toEqual([{ code: 'W', docSeries: [SERIES_W], state: 'set' }])
    expect(await books('from-books')).toEqual(before)
    expect((await books('from-b')).externalBranches).toEqual([{ code: 'W', docSeries: [SERIES_W] }])
    expect((await books('from-b')).branches.map((b: any) => [b.code, b.docSeries])).toEqual([['A', [SERIES_A]], ['B', [SERIES_B]]])
    // Named again, with the series it already keeps, it is already linked.
    expect((await linkBooks({ booksSlug: 'from-a', split: true, branches }, { dryRun: true })).branches.map(x => x.state)).toEqual(['already', 'already'])
  })

  it('refuses what would mix: a books org of its own, another split, another company, a store with no series', async () => {
    for (const slug of ['m-a', 'm-b', 'm-c', 'm-books']) await createTestOrg({ slug, taxNumber: EIK } as any)
    await createTestOrg({ slug: 'm-other', taxNumber: '111111111' } as any)
    await createTestOrg({ slug: 'm-plain', taxNumber: EIK } as any)
    await linkBooks({ booksSlug: 'm-books', branches: [{ slug: 'm-c', code: 'C' }] }, { dryRun: false })
    await linkBooks({ booksSlug: 'm-b', split: true, branches: [{ slug: 'm-b', code: 'B', docSeries: ['7'] }] }, { dryRun: false })
    const split = (home: string, ...slugs: string[]) => ({ booksSlug: home, split: true, branches: slugs.map((slug, i) => ({ slug, code: `X${i}`, docSeries: [`${i + 1}`] })) })

    expect(await code(linkBooks(split('m-a', 'm-a', 'm-books'), { dryRun: true }))).toBe('branch_is_books')
    expect(await code(linkBooks(split('m-a', 'm-a', 'm-b'), { dryRun: true }))).toBe('linked_elsewhere')
    expect(await code(linkBooks(split('m-a', 'm-a', 'm-other'), { dryRun: true }))).toBe('tax_number_differs')
    expect(await code(linkBooks(split('m-a', 'm-plain'), { dryRun: true }))).toBe('home_not_a_branch')
    expect(await code(linkBooks({ ...split('m-a', 'm-a', 'm-plain'), createWithName: 'X' }, { dryRun: true }))).toBe('split_creates_nothing')
    expect(await code(linkBooks({ booksSlug: 'm-a', split: true, branches: [{ slug: 'm-a', code: 'A' }, { slug: 'm-plain', code: 'P' }] }, { dryRun: true }))).toBe('no_series')
    expect(await code(linkBooks({ ...split('m-a', 'm-a', 'm-plain'), from: 'm-plain' }, { dryRun: true }))).toBe('from_not_books')
    expect(await code(linkBooks({ booksSlug: 'm-books', branches: [{ slug: 'm-c', code: 'C' }], from: 'm-plain' }, { dryRun: true }))).toBe('from_without_split')
    // And the other way: a split org is not made a books org of its own, nor a branch of one.
    expect(await code(linkBooks({ booksSlug: 'm-b', branches: [{ slug: 'm-plain', code: 'P' }] }, { dryRun: true }))).toBe('split_member')
    expect(await code(linkBooks({ booksSlug: 'm-books', branches: [{ slug: 'm-b', code: 'B' }] }, { dryRun: true }))).toBe('branch_is_books')
    expect(await books('m-a')).toBeUndefined()
  })

  it('scripts/link-books.ts --split: a dry run says what it would do, --execute does it, --from names what is left', async () => {
    await createTestOrg({ slug: 'cli-a', taxNumber: EIK } as any)
    await createTestOrg({ slug: 'cli-b', taxNumber: EIK } as any)
    await createTestOrg({ slug: 'cli-books', taxNumber: EIK } as any)
    await linkBooks({ booksSlug: 'cli-books', branches: [{ slug: 'cli-a', code: 'A', docSeries: [SERIES_A] }, { slug: 'cli-b', code: 'B', docSeries: [SERIES_B] }] }, { dryRun: false })
    const REPO = join(import.meta.dir, '..', '..', '..', '..')
    const cli = async (...args: string[]) => {
      const proc = Bun.spawn(['bun', join(REPO, 'scripts', 'link-books.ts'), ...args], { cwd: REPO, env: { ...process.env, MONGODB_URI: testDbUri() }, stdout: 'pipe', stderr: 'pipe' })
      const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
      return { code, out: out + err }
    }
    const branches = ['--branch', `cli-a:A:${SERIES_A}`, '--branch', `cli-b:B:${SERIES_B}`]

    expect((await cli('--split', ...branches)).code).toBe(2)
    expect((await cli('--split', '--home', 'cli-a', '--books', 'cli-b', ...branches)).code).toBe(2)
    expect((await cli('--home', 'cli-a', '--books', 'cli-a', ...branches)).code).toBe(2)
    const refused = await cli('--split', '--home', 'cli-a', ...branches)
    expect(refused).toMatchObject({ code: 1 })
    expect(refused.out).toContain('Refused (linked_elsewhere)')

    // The series are not typed again: they come from the books org the stores leave, and the dry run shows them.
    const dry = await cli('--split', '--home', 'cli-a', '--from', 'cli-books', '--branch', 'cli-a:A', '--branch', 'cli-b:B')
    expect(dry.code).toBe(0)
    expect(dry.out).toContain('Dry run: nothing written.')
    expect(dry.out).toContain('split: every branch keeps its share; home cli-a')
    expect(dry.out).toContain(`branch cli-b (B, series ${SERIES_B}): would_link, leaving cli-books (which keeps its copy)`)
    expect(await books('cli-a')).toMatchObject({ mode: 'branch' })

    expect((await cli('--split', '--home', 'cli-a', '--from', 'cli-books', ...branches, '--execute')).code).toBe(0)
    expect(await books('cli-b')).toMatchObject({ mode: 'books', split: { homeOrgId: (await Org.findOne({ slug: 'cli-a' }).lean() as any)._id } })
    expect((await cli('--split', '--home', 'cli-a', ...branches)).out).toContain(`branch cli-a (A, series ${SERIES_A}): already`)
  })

  it('the books org the stores left still imports, and still names their sales by store', async () => {
    // `makeGroup` split the two stores while the books org of its own still lists them as its branches.
    await chartAndAnalytics([group.whole])
    expect(await journal(group.whole, '2025-03', MARCH)).toMatchObject({ entries: 7, new: 7 })
    expect((await journal(group.whole, '2025-03', MARCH)).split).toBeUndefined()
    expect(String((await entries(group.whole, { docNumber: saleB.docNumber }))[0].branchOrgId)).toBe(group.store)
  })
})

describe('over HTTP', () => {
  let app: Elysia

  beforeAll(() => {
    app = new Elysia().use(createApiApp())
  })

  /** What the importer does: one POST a step, to one org of the split. */
  const poster = async (orgId: string) => {
    const token = await tokenFor(orgId)
    return async (step: string, body: unknown) => {
      const res = await app.handle(new Request(`http://localhost/api/org/${orgId}/accounting/import/${step}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }))
      return { status: res.status, body: await res.json() as any }
    }
  }

  it('end to end: a partner\'s properties go from the file to the Contact a store makes when its own sale names the partner', async () => {
    const post = await poster(group.store)
    expect((await post('chart', { ...execute, accounts: CHART })).status).toBe(200)

    // The file, read by the books' parser, sent as the importer sends it. The store links no one yet: no
    // contact of it is any of these partners, and none is made from a list.
    const items = parseAnalyticsFile(apFile())
    const analytics = await post('analytics', { ...execute, items })
    expect(analytics.status).toBe(200)
    expect(analytics.body.contacts).toEqual({ created: 0, linked: 0, withoutIdentifier: 1, deferred: 6 })
    expect(await Contact.countDocuments({ orgId: group.store })).toBe(0)
    // The import keeps every property on its analytic, as the file spells it.
    const kept: any = await AccountingAnalytic.findOne({ orgId: group.store, path: CUST_B }).lean()
    expect(kept.params.map((p: any) => p.key)).toEqual(['БУЛСТАТ', 'ИНДДС', 'АДРЕС', 'ГРАД', 'МОЛ'])

    // The month: the store holds its own sale, which names customer B; customer A is the sister store's.
    const month = await post('journal', { ...execute, month: '2025-03', coverage: COVERAGE_2025, documents: MARCH })
    expect(month.status).toBe(200)
    expect(month.body).toMatchObject({ entries: 1, new: 1, split: { role: 'member', fileEntries: 7, contacts: { created: 1, linked: 0 } } })

    const made: any[] = await Contact.find({ orgId: group.store }).lean()
    expect(made).toHaveLength(1)
    expect(made[0]).toMatchObject({
      companyName: 'Клиент Б', type: 'customer', taxId: '000000022', taxNumber: '000000022', vatNumber: 'BG000000022', representative: 'Лице Б',
    })
    expect(made[0].addresses[0]).toMatchObject({ street: 'ул. Втора 2', city: 'Друго', country: 'BG' })
    const sale = (await entries(group.store))[0]
    const named = sale.lines.filter((l: any) => l.contactId)
    expect(named.length).toBeGreaterThan(0)
    expect(named.every((l: any) => String(l.contactId) === String(made[0]._id))).toBe(true)
    // The sister store's customer, and the supplier: their analytics are here (the tree is whole), their Contacts are not.
    expect(await AccountingAnalytic.countDocuments({ orgId: group.store, path: { $in: [CUST_A, SUPPLIER] } })).toBe(2)
    expect(await Contact.countDocuments({ orgId: group.store, companyName: { $in: ['Клиент А', 'Доставчик А'] } })).toBe(0)

    // Dry reruns of both steps change nothing.
    expect((await post('analytics', { eik: EIK, items })).body).toMatchObject({ created: 0, updated: 0 })
    expect((await post('journal', { eik: EIK, month: '2025-03', coverage: COVERAGE_2025, documents: MARCH })).body).toMatchObject({ entries: 1, unchanged: 1 })
  })

  it('a store\'s routes answer with its share and the file\'s whole count, and an old client\'s body is enough', async () => {
    const post = await poster(group.store)
    const month = await post('journal', { eik: EIK, month: '2025-03', coverage: COVERAGE_2025, documents: MARCH })
    expect(month.status).toBe(200)
    expect(month.body).toMatchObject({ dryRun: true, entries: 1, new: 1, split: { role: 'member', fileEntries: 7 } })
    const opening = await post('opening', { eik: EIK, ...OPENING_2025 })
    expect(opening.body).toMatchObject({ outcome: 'unchanged', lines: 0, split: { role: 'member' } })
    expect(await JournalEntry.countDocuments({ orgId: group.store })).toBe(0)
  })
})
