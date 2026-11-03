import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'bun:test'
import { Elysia } from 'elysia'
import jwt from '@elysiajs/jwt'
import { clearCollections, setupTestDB, teardownTestDB } from '../setup'
import { createTestOrg, createTestUser } from '../helpers/factories'
import { captureRejection } from '../helpers/capture-rejection'
import { config } from 'config'
import { DEFAULT_ROLE_PERMISSIONS } from 'config/constants'
import { Account, AccountingAnalytic, AuditLog, BankAccount, Contact, FiscalPeriod, FixedAsset, JournalEntry, Org, Sequence } from 'db/models'
import {
  BooksImportError,
  finishImport,
  importAnalytics,
  importChart,
  importJournalMonth,
  importOpening,
} from 'services/biz/accounting-books/import.service'
import { BooksLinkError, linkBooks } from 'services/biz/accounting-books/link-books.service'
import { analyticTrialBalance, chronology, documentJournal, mainBook, rebuildBalances, trialBalance } from 'services/biz/accounting-books/books-ledger'
import { getBalanceSheet, getProfitLoss, getTrialBalance, postJournalEntry, voidJournalEntry } from 'services/biz/accounting.service'
import { mongoose } from 'db/connection'
import { compareJournalAccounts, compareJournalAnalytics } from 'services/biz/accounting-books/compare'
import { REPORT_REGISTRY, listReportsFor, reportById } from 'services/biz/report-registry'
import type { ImportDocument, JournalBody } from 'services/biz/accounting-books/import.types'
import { createApiApp } from '../../../portal-api/src/api.js'

/**
 * FR-25 §5: a company's books, imported as booked. Fictional data only, in the shape of the journal:
 * every row kind of §1.4 is here as a fixture, and what must hold is that the books say what the file
 * says, per account and per analytic, with quantities.
 */

const EIK = '000000000'
const CHART = [
  ['101', 'Основен капитал'], ['122', 'Неразпределена печалба'], ['123', 'Печалби и загуби'], ['159', 'Други заеми'],
  ['204', 'Машини'], ['2414', 'Амортизация на машини'], ['302', 'Материали'], ['303', 'Продукция'], ['304', 'Стоки'],
  ['401', 'Доставчици'], ['402', 'Доставчици по аванси'], ['411', 'Клиенти'], ['412', 'Клиенти по аванси'], ['421', 'Персонал'],
  ['425', 'Задължения за съучастия'], ['452', 'Данък върху печалбата'], ['4531', 'ДДС за покупките'], ['4532', 'ДДС за продажбите'],
  ['4539', 'ДДС за внасяне'], ['454', 'Данъци върху доходите'], ['455', 'Социално осигуряване'], ['457', 'Разчети с митници'],
  ['501', 'Каса'], ['503', 'Разплащателна сметка'], ['504', 'Сметка във валута'], ['601', 'Разходи за материали'],
  ['602', 'Разходи за услуги'], ['603', 'Разходи за амортизация'], ['604', 'Разходи за заплати'], ['605', 'Разходи за осигуровки'],
  ['609', 'Други разходи'], ['611', 'Разходи за основна дейност'], ['621', 'Разходи за лихви'], ['624', 'Курсови разлики'],
  ['629', 'Други финансови разходи'], ['651', 'Разходи за бъдещи периоди'], ['701', 'Приходи от продукция'], ['702', 'Приходи от стоки'],
  ['703', 'Приходи от услуги'], ['724', 'Положителни курсови разлики'],
].map(([code, name]) => ({ code, name }))

const IBAN = 'XX00BANK0000000000000001'
const CUSTOMER = 'КЛИЕНТИ:Клиент А'
const PREPAID = 'КЛИЕНТИ:Клиент Б'
const SUPPLIER = 'ДОСТАВЧИЦИ:Доставчик А'
const GOODS = 'СТОКИ:БОЛТОВЕ'
const BANK = `БАНКОВИ СМЕТКИ:${IBAN}`

/** Each row of FR-25 §1.4, as the journal books it. */
const MARCH: ImportDocument[] = [
  // `-ФЕ`: cost at the group's average on 702, the customer's account hit even for cash.
  { date: '2025-03-03', docType: '-ФЕ', docNumber: '0000100101', vatKind: '1', total: 120, comment: 'Стоки', ops: [
    { d: '702', k: '304', ak: GOODS, qty: 10, amount: 60.1234 },
    { d: '411', k: '702', ad: CUSTOMER, amount: 100 },
    { d: '411', k: '4532', ad: CUSTOMER, amount: 20 },
    { d: '501', k: '411', ak: CUSTOMER, amount: 120 },
  ] },
  { date: '2025-03-03', docType: '-ФЕ', docNumber: '0000200102', vatKind: '1', total: 60, ops: [
    { d: '411', k: '703', ad: CUSTOMER, ak: 'УСЛУГИ:Монтаж', qty: 1, amount: 40 },
    { d: '411', k: '701', ad: CUSTOMER, amount: 10 },
    { d: '701', k: '303', ak: 'ПРОДУКЦИЯ:Изделие', qty: 2, amount: 6 },
    { d: '411', k: '4532', ad: CUSTOMER, amount: 10 },
    { d: '411', k: '412', ad: CUSTOMER, ak: CUSTOMER, amount: 15 },
  ] },
  // `КП`: one till document a month.
  { date: '2025-03-31', docType: 'КП', docNumber: '1', vatKind: '3', total: 600, comment: 'Каса', ops: [
    { d: '702', k: '304', ak: GOODS, qty: 20, amount: 300 },
    { d: '411', k: '702', ad: 'КЛИЕНТИ:ОБОРОТ ОТ КАСОВИ ПРОДАЖБИ', amount: 500 },
    { d: '411', k: '4532', ad: 'КЛИЕНТИ:ОБОРОТ ОТ КАСОВИ ПРОДАЖБИ', amount: 100 },
    { d: '501', k: '411', ak: 'КЛИЕНТИ:ОБОРОТ ОТ КАСОВИ ПРОДАЖБИ', amount: 600 },
  ] },
  // Annulled: the same shape, negative, on the same sides.
  { date: '2025-03-10', docType: '-ФЕА', docNumber: '0000100103', vatKind: '1', total: -12, ops: [
    { d: '702', k: '304', ak: GOODS, qty: -1, amount: -6 },
    { d: '411', k: '702', ad: CUSTOMER, amount: -10 },
    { d: '411', k: '4532', ad: CUSTOMER, amount: -2 },
  ] },
  { date: '2025-03-10', docType: '-ФИ', docNumber: '0000100104', vatKind: '1', total: -12, ops: [
    { d: '411', k: '702', ad: CUSTOMER, amount: -10 },
    { d: '411', k: '4532', ad: CUSTOMER, amount: -2 },
  ] },
  // `+ФЕ`: goods, materials, expense, lease, interest, prepaid, an asset, its VAT, paid in cash.
  { date: '2025-03-04', docType: '+ФЕ', docNumber: '77', vatKind: '1', total: 1200, comment: 'Стоки', ops: [
    { d: '304', k: '401', ad: GOODS, ak: SUPPLIER, qty: 100, amount: 500, cur: 'EUR', rate: 1.95583, fx: 255.65 },
    { d: '302', k: '401', ad: 'МАТЕРИАЛИ:ДИЗЕЛ', ak: SUPPLIER, qty: 5, amount: 50 },
    { d: '601', k: '401', ad: 'РАЗХОДИ:МАТЕРИАЛИ:Канцеларски', ak: SUPPLIER, amount: 10 },
    { d: '602', k: '401', ad: 'РАЗХОДИ:УСЛУГИ:Интернет', ak: SUPPLIER, amount: 20 },
    { d: '609', k: '401', ad: 'РАЗХОДИ:ДРУГИ:Глоби', ak: SUPPLIER, amount: 5 },
    { d: '159', k: '401', ad: 'РАЗХОДИ:ЛИЗИНГОВА ВНОСКА', ak: SUPPLIER, amount: 80 },
    { d: '621', k: '401', ad: 'РАЗХОДИ:ФИНАНСОВИ:Лихви', ak: SUPPLIER, amount: 8 },
    { d: '651', k: '401', ad: 'РАЗХОДИ:ЗАСТРАХОВКИ', ak: SUPPLIER, amount: 30 },
    { d: '204', k: '401', ad: 'ДА:Машина', ak: SUPPLIER, amount: 297 },
    { d: '4531', k: '401', ak: SUPPLIER, amount: 200 },
    { d: '401', k: '501', ad: SUPPLIER, amount: 100 },
  ] },
  // The same number from another supplier, on the same day: a document number is not unique.
  { date: '2025-03-04', docType: '+ФЕ', docNumber: '77', vatKind: '1', total: 12, ops: [
    { d: '602', k: '401', ad: 'РАЗХОДИ:УСЛУГИ:Интернет', ak: 'ДОСТАВЧИЦИ:Доставчик Б', amount: 10 },
    { d: '4531', k: '401', ak: 'ДОСТАВЧИЦИ:Доставчик Б', amount: 2 },
  ] },
  // One quantity with no amount, as one row of a year had it.
  { date: '2025-03-05', docType: '+ФЕ', docNumber: '78', ops: [{ d: '304', k: '401', ad: GOODS, ak: SUPPLIER, qty: 5, amount: 0 }] },
  // A document with no operations: 27 in a year.
  { date: '2025-03-05', docType: '+ФЕ', docNumber: '79', total: 0, ops: [] },
  { date: '2025-03-06', docType: '-П', docNumber: '55', vatKind: '17', total: 20, comment: 'ВОП, +ФЕ77', ops: [{ d: '4531', k: '4532', amount: 20 }] },
  { date: '2025-03-06', docType: 'МД', docNumber: '56', total: 120, ops: [
    { d: '4531', k: '457', ak: 'РАЗЧЕТИ:Митница', amount: 20 },
    { d: '304', k: '457', ad: GOODS, ak: 'РАЗЧЕТИ:Митница', qty: 3, amount: 100 },
  ] },
  { date: '2025-03-07', docType: '-ПЛН', docNumber: '57', vatKind: '39', total: 2, ops: [{ d: '609', k: '4532', ad: 'РАЗХОДИ:ДРУГИ:Лична употреба', amount: 2 }] },
  { date: '2025-03-07', docType: 'СИ', docNumber: '58', ops: [{ d: '601', k: '304', ad: 'РАЗХОДИ:МАТЕРИАЛИ:Брак', ak: GOODS, qty: 1, amount: 6 }] },
  // Bank: the comment names what it pays.
  { date: '2025-03-12', docType: '+ББ', docNumber: '901', comment: '-ФЕ 0000100101,-ФЕА 0000100103', ops: [
    { d: '503', k: '411', ad: BANK, ak: CUSTOMER, amount: 50, comment: '-ФЕ 0000100101,-ФЕА 0000100103' },
  ] },
  { date: '2025-03-12', docType: '-ББ', docNumber: '902', comment: '+ФЕ 77', ops: [{ d: '401', k: '503', ad: SUPPLIER, ak: BANK, amount: 200 }] },
  { date: '2025-03-13', docType: 'ББ', docNumber: '903', comment: 'Такса', ops: [
    { d: '629', k: '503', ad: 'РАЗХОДИ:БАНКОВИ ТАКСИ', ak: BANK, amount: 3.5, comment: 'Такса' },
    { d: '503', k: '501', ad: BANK, amount: 400 },
    { d: '4539', k: '503', ad: 'РАЗЧЕТИ:ДДС', ak: BANK, amount: 40 },
    { d: '454', k: '503', ad: 'РАЗЧЕТИ:ДАНЪЦИ:ДОД', ak: BANK, amount: 30 },
    { d: '455', k: '503', ad: 'РАЗЧЕТИ:ОСИГУРОВКИ:ДОО', ak: BANK, amount: 60 },
    { d: '452', k: '503', ad: 'РАЗЧЕТИ:ДАНЪЦИ:Печалба', ak: BANK, amount: 15 },
    { d: '421', k: '503', ak: BANK, amount: 250, journal: 'ТРЗ' },
    { d: '425', k: '503', ad: 'ПЕРСОНАЛ:Съдружник', ak: BANK, amount: 25 },
    { d: '504', k: '503', ad: 'БАНКОВИ СМЕТКИ:XX00BANK0000000000000002', ak: BANK, amount: 70 },
  ] },
  { date: '2025-03-14', docType: '+БВ', docNumber: '904', ops: [
    { d: '504', k: '411', ad: 'БАНКОВИ СМЕТКИ:XX00BANK0000000000000002', ak: CUSTOMER, amount: 39.12, cur: 'EUR', rate: 1.95583, fx: 20 },
    { d: '504', k: '724', ad: 'БАНКОВИ СМЕТКИ:XX00BANK0000000000000002', amount: 0.5 },
  ] },
  { date: '2025-03-14', docType: '-БВ', docNumber: '905', ops: [
    { d: '401', k: '504', ad: SUPPLIER, ak: 'БАНКОВИ СМЕТКИ:XX00BANK0000000000000002', amount: 18.5, cur: 'USD', rate: 1.85, fx: 10 },
    { d: '624', k: '504', ak: 'БАНКОВИ СМЕТКИ:XX00BANK0000000000000002', amount: 0.25 },
  ] },
  // `ЗАП`: payroll, one aggregate document, no person on any line.
  { date: '2025-03-31', docType: 'ЗАП', docNumber: '3', ops: [
    { d: '604', k: '421', ad: 'РАЗХОДИ:ЗАПЛАТИ:Магазин', amount: 1000 },
    { d: '605', k: '455', ad: 'РАЗХОДИ:ОСИГУРОВКИ:ДОО', ak: 'РАЗЧЕТИ:ОСИГУРОВКИ:ДОО', amount: 190 },
    { d: '421', k: '455', ak: 'РАЗЧЕТИ:ОСИГУРОВКИ:ДОО', amount: 138 },
    { d: '421', k: '454', ak: 'РАЗЧЕТИ:ДАНЪЦИ:ДОД', amount: 86 },
  ] },
  // No document: amortization, materials used, the month's VAT.
  { date: '2025-03-31', ops: [{ d: '603', k: '2414', ak: 'ДА:Машина', amount: 12.5 }] },
  { date: '2025-03-31', ops: [{ d: '601', k: '302', ad: 'РАЗХОДИ:МАТЕРИАЛИ:Гориво', ak: 'МАТЕРИАЛИ:ДИЗЕЛ', qty: 2, amount: 12.3456789012 }] },
  { date: '2025-03-31', ops: [{ d: '4532', k: '4531', ad: 'РАЗЧЕТИ:ДДС', ak: 'РАЗЧЕТИ:ДДС', amount: 242 }] },
  { date: '2025-03-31', ops: [{ d: '4532', k: '4539', ad: 'РАЗЧЕТИ:ДДС', ak: 'РАЗЧЕТИ:ДДС', amount: 12 }] },
]

/** Year-end, with no document (FR-25 §1.4). */
const DECEMBER: ImportDocument[] = [
  { date: '2025-12-31', ops: [{ d: '611', k: '601', ak: 'РАЗХОДИ:МАТЕРИАЛИ:Канцеларски', amount: 10 }] },
  { date: '2025-12-31', ops: [{ d: '702', k: '611', amount: 10 }] },
  { date: '2025-12-31', ops: [{ d: '702', k: '123', amount: 100 }] },
  { date: '2025-12-31', ops: [{ d: '123', k: '452', ak: 'РАЗЧЕТИ:ДАНЪЦИ:Печалба', amount: 10 }] },
  { date: '2025-12-31', ops: [{ d: '123', k: '122', amount: 90 }] },
  { date: '2025-12-31', ops: [{ d: '122', k: '425', ak: 'ПЕРСОНАЛ:Съдружник', amount: 50 }] },
  { date: '2025-12-31', ops: [{ d: '425', k: '501', ad: 'ПЕРСОНАЛ:Съдружник', amount: 50 }] },
]

const YEAR = { from: '2025-01-01', to: '2025-12-31' }
const MARCH_PERIOD = { from: '2025-03-01', to: '2025-03-31' }
const COVERAGE = { from: '2025-01-01', to: '2025-12-31' }

interface World {
  orgId: string
  storeId: string
  by: { id: string }
}

let world: World

async function makeWorld(): Promise<World> {
  const store = await createTestOrg({ taxNumber: EIK } as any)
  const books = await createTestOrg({ taxNumber: EIK } as any)
  await Org.updateOne({ _id: books._id }, { $set: { 'settings.accounting.books': { mode: 'books', branches: [{ orgId: store._id, code: 'PZ', label: 'Магазин', docSeries: ['00001'] }] } } })
  await Org.updateOne({ _id: store._id }, { $set: { 'settings.accounting.books': { mode: 'branch', booksOrgId: books._id, branchCode: 'PZ' } } })
  const user = await createTestUser(books._id as any)
  return { orgId: String(books._id), storeId: String(store._id), by: { id: String(user._id) } }
}

const execute = { eik: EIK, dryRun: false }

const importJournal = (month: string, documents: ImportDocument[], over: Partial<JournalBody> = {}) =>
  importJournalMonth(world.orgId, { ...execute, month, coverage: COVERAGE, documents, ...over }, world.by)

async function chartIn(): Promise<void> {
  await importChart(world.orgId, { ...execute, accounts: CHART }, world.by)
}

const entryOf = (docType: string, docNumber: string) => JournalEntry.findOne({ orgId: world.orgId, docType, docNumber }).lean() as any

const accountOf = async (code: string) => (await Account.findOne({ orgId: world.orgId, code }, { _id: 1 }).lean()) as any

beforeAll(async () => {
  await setupTestDB()
}, 120_000)

afterAll(async () => {
  await teardownTestDB()
}, 60_000)

beforeEach(async () => {
  await clearCollections()
  world = await makeWorld()
})

describe('the journal, as booked', () => {
  beforeEach(async () => {
    await chartIn()
    await importJournal('2025-03', MARCH)
    await importJournal('2025-12', DECEMBER)
  })

  it('a document is one entry, and an operation with no document is one of its own', async () => {
    expect(await JournalEntry.countDocuments({ orgId: world.orgId })).toBe(MARCH.length + DECEMBER.length)
    expect(await JournalEntry.countDocuments({ orgId: world.orgId, docType: { $exists: false } })).toBe(4 + DECEMBER.length)
    const empty = await entryOf('+ФЕ', '79')
    expect(empty.lines).toEqual([])
  })

  it('says what the file says: every row of §1.4, per account and per analytic, with quantities', async () => {
    const documents = [...MARCH, ...DECEMBER]
    const accounts = compareJournalAccounts({ documents }, (await trialBalance(world.orgId, YEAR)).rows)
    expect(accounts).toMatchObject({ differingCells: 0 })
    expect(accounts.rows).toBeGreaterThan(30)
    const analytics = compareJournalAnalytics({ documents }, (await analyticTrialBalance(world.orgId, YEAR)).rows)
    expect(analytics).toMatchObject({ differingCells: 0 })
    expect(analytics.rows).toBeGreaterThan(20)
  })

  it('an operation is two lines with one number, each on its side, amounts as booked', async () => {
    const sale = await entryOf('-ФЕ', '0000100101')
    expect(sale.lines).toHaveLength(8)
    const accounts = new Map((await Account.find({ orgId: world.orgId }).lean()).map((a: any) => [String(a._id), a.code]))
    expect(sale.lines.map((l: any) => [l.opNo, l.side, accounts.get(String(l.accountId))])).toEqual([
      [1, 'debit', '702'], [1, 'credit', '304'],
      [2, 'debit', '411'], [2, 'credit', '702'],
      [3, 'debit', '411'], [3, 'credit', '4532'],
      [4, 'debit', '501'], [4, 'credit', '411'],
    ])
    expect(sale.lines[0]).toMatchObject({ debit: 60.1234, credit: 0, side: 'debit', quantity: 10 })
    expect(sale.lines[1]).toMatchObject({ debit: 0, credit: 60.1234, side: 'credit', quantity: 10 })
    const decimals = await JournalEntry.findOne({ orgId: world.orgId, 'lines.debit': 12.3456789012 }).lean() as any
    expect(decimals.lines[0].debit).toBe(12.3456789012)
  })

  it('cost of sales stays a debit on revenue: 702 shows both sides, not a margin', async () => {
    const row = (await trialBalance(world.orgId, MARCH_PERIOD)).rows.find(r => r.code === '702')!
    expect(row.turnoverDebit).toBeCloseTo(60.1234 + 300 - 6, 6)
    expect(row.turnoverCredit).toBeCloseTo(100 + 500 - 10 - 10, 6)
  })

  it('a correction is negative on the same side, and a debit column can be negative', async () => {
    const annul = await entryOf('-ФЕА', '0000100103')
    expect(annul.lines[0]).toMatchObject({ side: 'debit', debit: -6, credit: 0, baseCredit: 0, quantity: -1 })
    expect(annul.lines[1]).toMatchObject({ side: 'credit', credit: -6, debit: 0, baseDebit: 0, quantity: -1 })
    expect(annul.lines[0].baseDebit).toBeCloseTo(-3.07, 2)
    const goods = (await analyticTrialBalance(world.orgId, MARCH_PERIOD, 'СТОКИ')).rows[0]
    expect(goods.turnoverCreditQuantity).toBe(10 + 20 - 1 + 1)
  })

  it('every entry balances, as booked and in base', async () => {
    const entries: any[] = await JournalEntry.find({ orgId: world.orgId }).lean()
    for (const e of entries) {
      const sum = (f: string) => e.lines.reduce((s: number, l: any) => s + l[f], 0)
      expect(Math.abs(sum('debit') - sum('credit'))).toBeLessThan(0.000001)
      expect(Math.abs(sum('baseDebit') - sum('baseCredit'))).toBeLessThan(0.000001)
      expect(e.totalDebit).toBe(e.totalCredit)
    }
  })

  it('before the euro an amount keeps BGN, with the rate and a rounded base, booked in the fiscal period', async () => {
    const sale = await entryOf('-ФЕ', '0000100101')
    expect(sale.lines[2]).toMatchObject({ currency: 'BGN', debit: 100, baseDebit: 51.13 })
    expect(sale.lines[2].exchangeRate).toBeCloseTo(1 / 1.95583, 10)
    expect(sale).toMatchObject({ status: 'posted', ledger: 'books', sourceModule: 'plusminus', docCurrency: 'BGN', docTotal: 120, docVat: 20, vatKind: '1' })
    const period: any = await FiscalPeriod.findById(sale.fiscalPeriodId).lean()
    expect(period.number).toBe(3)
    expect(String(period.orgId)).toBe(world.orgId)
  })

  it('from the euro on an amount is its own base', async () => {
    await importJournal('2026-02', [{ date: '2026-02-02', docType: '+ФЕ', docNumber: '80', ops: [{ d: '602', k: '401', amount: 10.5 }] }], { coverage: { from: '2026-01-01', to: '2026-02-28' } })
    const entry = await entryOf('+ФЕ', '80')
    expect(entry.lines[0]).toMatchObject({ currency: 'EUR', exchangeRate: 1, debit: 10.5, baseDebit: 10.5 })
    expect(entry.docCurrency).toBe('EUR')
  })

  it('a document and each of its lines carry whose they are', async () => {
    const pz = await entryOf('-ФЕ', '0000100101')
    expect(String(pz.branchOrgId)).toBe(world.storeId)
    expect(pz.lines.every((l: any) => String(l.branchOrgId) === world.storeId)).toBe(true)
    const unsaid = await entryOf('-ФЕ', '0000200102')
    expect(String(unsaid.branchOrgId)).toBe(world.orgId)
    const purchase = await JournalEntry.findOne({ orgId: world.orgId, docType: '+ФЕ', docNumber: '77' }).lean() as any
    expect(String(purchase.branchOrgId)).toBe(world.orgId)
  })

  it('a line with a customer carries its Contact, and the document its partner', async () => {
    const sale = await entryOf('-ФЕ', '0000100101')
    const contact: any = await Contact.findOne({ orgId: world.orgId, companyName: 'Клиент А' }).lean()
    expect(contact.type).toBe('customer')
    expect(String(sale.lines[2].contactId)).toBe(String(contact._id))
    expect(String(sale.lines[7].contactId)).toBe(String(contact._id))
    expect(sale.lines[0].contactId).toBeUndefined()
    const analytic: any = await AccountingAnalytic.findOne({ orgId: world.orgId, path: CUSTOMER }).lean()
    expect(String(sale.partnerAnalyticId)).toBe(String(analytic._id))
    expect(analytic).toMatchObject({ kind: 'customer', root: 'КЛИЕНТИ', name: 'Клиент А', nameLower: 'клиент а' })
    expect(String(analytic.contactId)).toBe(String(contact._id))
  })

  it('a path is kept in a tree, with what is above it', async () => {
    const leaf: any = await AccountingAnalytic.findOne({ orgId: world.orgId, path: 'РАЗХОДИ:ФИНАНСОВИ:Лихви' }).lean()
    const parent: any = await AccountingAnalytic.findById(leaf.parentId).lean()
    expect(parent).toMatchObject({ path: 'РАЗХОДИ:ФИНАНСОВИ', kind: 'expense' })
    const root: any = await AccountingAnalytic.findById(parent.parentId).lean()
    expect(root).toMatchObject({ path: 'РАЗХОДИ', root: 'РАЗХОДИ' })
    expect((await AccountingAnalytic.findOne({ orgId: world.orgId, path: 'ПЕРСОНАЛ:Съдружник' }).lean() as any).kind).toBe('personnel')
  })

  it('a bank line says what it pays, on the partner\'s side', async () => {
    const bank = await entryOf('+ББ', '901')
    expect(bank.lines[0].settles).toBeUndefined()
    expect(bank.lines[1].settles).toEqual([{ docType: '-ФЕ', docNumber: '0000100101' }, { docType: '-ФЕА', docNumber: '0000100103' }])
    const fees = await entryOf('ББ', '903')
    expect(fees.lines.every((l: any) => !l.settles)).toBe(true)
  })

  it('a line keeps the currency it was made in, PlusMinus\'s journal and its comment', async () => {
    const purchase: any = await JournalEntry.findOne({ orgId: world.orgId, 'lines.fx.currency': 'EUR', docType: '+ФЕ' }).lean()
    expect(purchase.lines[0].fx).toEqual({ currency: 'EUR', rate: 1.95583, amount: 255.65 })
    const fees = await entryOf('ББ', '903')
    expect(fees.lines[0].description).toBe('Такса')
    expect(fees.lines.find((l: any) => l.journalCode === 'ТРЗ')).toBeTruthy()
  })

  it('an account learns which trees it uses, and whether it counts stock', async () => {
    const stock: any = await Account.findOne({ orgId: world.orgId, code: '304' }).lean()
    expect(stock.analyticRoots).toEqual(['СТОКИ'])
    expect(stock.quantitative).toBe(true)
    expect((await Account.findOne({ orgId: world.orgId, code: '411' }).lean() as any).quantitative).toBeUndefined()
  })

  it('numbers its entries in a series of their own, never reusing one', async () => {
    const numbers = (await JournalEntry.find({ orgId: world.orgId }, { entryNumber: 1 }).lean()).map((e: any) => e.entryNumber)
    expect(new Set(numbers).size).toBe(numbers.length)
    expect(numbers.every((n: string) => /^PM-2025-\d{6}$/.test(n))).toBe(true)
  })

  it('leaves one audit row a month, with counts and nothing of the books', async () => {
    const rows: any[] = await AuditLog.find({ orgId: world.orgId, entityType: 'accounting_import', entityName: 'journal 2025-03' }).lean()
    expect(rows).toHaveLength(1)
    expect(JSON.stringify(rows[0])).not.toContain('Клиент')
  })
})

describe('a re-import replaces the month', () => {
  const docA: ImportDocument = { date: '2025-03-03', docType: '-ФЕ', docNumber: '0000100101', total: 120, ops: [{ d: '702', k: '304', ak: GOODS, qty: 10, amount: 60 }] }
  const docB: ImportDocument = { date: '2025-03-04', docType: '-ФЕ', docNumber: '0000100102', total: 240, ops: [{ d: '702', k: '304', ak: GOODS, qty: 20, amount: 120 }] }
  const docC: ImportDocument = { date: '2025-03-05', docType: '+ФЕ', docNumber: '77', total: 100, ops: [{ d: '304', k: '401', ad: GOODS, ak: SUPPLIER, amount: 100 }] }
  const docD: ImportDocument = { date: '2025-03-06', docType: '+ФЕ', docNumber: '78', total: 50, ops: [{ d: '304', k: '401', ad: GOODS, ak: SUPPLIER, amount: 50 }] }

  beforeEach(async () => {
    await chartIn()
    await importJournal('2025-03', [docA, docB, docC])
  })

  it('a dry rerun proves it: every entry unchanged, and nothing written', async () => {
    const before = await JournalEntry.find({ orgId: world.orgId }).lean()
    const answer = await importJournal('2025-03', [docA, docB, docC], { dryRun: true })
    expect(answer).toMatchObject({ dryRun: true, new: 0, changed: 0, gone: 0, unchanged: 3, entries: 3, balanced: 3 })
    expect(await JournalEntry.find({ orgId: world.orgId }).lean()).toEqual(before)
  })

  it('reports what is new, changed and gone, per document type, and writes that', async () => {
    const recosted = { ...docA, ops: [{ ...docA.ops[0], amount: 61 }] }
    const answer = await importJournal('2025-03', [recosted, docC, docD])
    expect(answer).toMatchObject({ new: 1, changed: 1, gone: 1, unchanged: 1 })
    expect(answer.byDocType).toEqual({
      '-ФЕ': { new: 0, changed: 1, gone: 1, unchanged: 0 },
      '+ФЕ': { new: 1, changed: 0, gone: 0, unchanged: 1 },
    })
    expect(await JournalEntry.countDocuments({ orgId: world.orgId })).toBe(3)
    expect((await entryOf('-ФЕ', '0000100101')).lines[0].debit).toBe(61)
    expect(await entryOf('-ФЕ', '0000100102')).toBeNull()
    expect(await entryOf('+ФЕ', '78')).toBeTruthy()
  })

  it('an entry that survives keeps its id and its number: ids are never reissued', async () => {
    const before = await entryOf('-ФЕ', '0000100101')
    await importJournal('2025-03', [{ ...docA, ops: [{ ...docA.ops[0], amount: 61 }] }, docB, docC])
    const after = await entryOf('-ФЕ', '0000100101')
    expect(String(after._id)).toBe(String(before._id))
    expect(after.entryNumber).toBe(before.entryNumber)
    expect(String(after.importBatchId)).not.toBe(String(before.importBatchId))
    const unchanged = await entryOf('-ФЕ', '0000100102')
    expect(String(unchanged.importBatchId)).toBe(String(before.importBatchId))
  })

  it('clears what the file no longer says', async () => {
    await importJournal('2025-03', [docA, { ...docB, total: undefined }, docC])
    expect((await entryOf('-ФЕ', '0000100102')).docTotal).toBeUndefined()
  })

  it('judges nothing outside what the file covers', async () => {
    const answer = await importJournal('2025-03', [docA], { coverage: { from: '2025-03-01', to: '2025-03-03' } })
    expect(answer).toMatchObject({ gone: 0, unchanged: 1 })
    expect(await JournalEntry.countDocuments({ orgId: world.orgId })).toBe(3)
  })

  it('an empty month in the file empties the month in the books', async () => {
    const answer = await importJournal('2025-03', [])
    expect(answer).toMatchObject({ gone: 3, entries: 0 })
    expect(await JournalEntry.countDocuments({ orgId: world.orgId })).toBe(0)
  })

  it('touches no other month, and no entry an import did not write', async () => {
    await importJournal('2025-04', [{ date: '2025-04-01', docType: '+ФЕ', docNumber: '90', ops: [{ d: '602', k: '401', amount: 1 }] }])
    const account = await accountOf('602')
    await JournalEntry.create({
      orgId: world.orgId, entryNumber: 'JE-2025-00001', date: new Date('2025-03-20'), fiscalPeriodId: (await entryOf('-ФЕ', '0000100101')).fiscalPeriodId,
      description: 'Typed by hand', type: 'standard', status: 'posted', lines: [{ accountId: account._id, debit: 1, credit: 0, currency: 'BGN', exchangeRate: 1, baseDebit: 1, baseCredit: 0 }],
      totalDebit: 1, totalCredit: 0, createdBy: world.by.id,
    })
    await importJournal('2025-03', [])
    expect(await JournalEntry.countDocuments({ orgId: world.orgId, entryNumber: 'JE-2025-00001' })).toBe(1)
    expect(await entryOf('+ФЕ', '90')).toBeTruthy()
  })

  it('a partner pointed at another Contact shows as changed, and the re-import writes it onto the lines', async () => {
    const merged = await Contact.create({ orgId: world.orgId, type: 'supplier', companyName: 'Обединен' })
    await AccountingAnalytic.updateOne({ orgId: world.orgId, path: SUPPLIER }, { $set: { contactId: merged._id } })

    expect(await importJournal('2025-03', [docA, docB, docC], { dryRun: true })).toMatchObject({ changed: 1, unchanged: 2 })
    expect(String((await entryOf('+ФЕ', '77')).lines[1].contactId)).not.toBe(String(merged._id))

    await importJournal('2025-03', [docA, docB, docC])
    expect(String((await entryOf('+ФЕ', '77')).lines[1].contactId)).toBe(String(merged._id))
    expect(await importJournal('2025-03', [docA, docB, docC], { dryRun: true })).toMatchObject({ changed: 0, unchanged: 3 })
  })

  it('two imports of a month at once cannot double it', async () => {
    const key = (await entryOf('+ФЕ', '77')).importKey
    const copy: any = (await JournalEntry.findOne({ orgId: world.orgId, importKey: key }).lean())
    delete copy._id
    const err = await captureRejection(JournalEntry.create({ ...copy, entryNumber: 'PM-2025-999999' }))
    expect(err?.code).toBe(11000)
  })
})

describe('what an import refuses', () => {
  const doc: ImportDocument = { date: '2025-03-03', docType: '+ФЕ', docNumber: '1', ops: [{ d: '602', k: '401', amount: 1 }] }

  const refusedCode = async (p: Promise<unknown>) => {
    const err = await captureRejection(p)
    expect(err).toBeInstanceOf(BooksImportError)
    return err.code
  }

  it('an org that keeps its own books: nothing here runs for it (FR-25 D2)', async () => {
    const own = await createTestOrg({ taxNumber: EIK } as any)
    expect(await refusedCode(importChart(String(own._id), { ...execute, accounts: CHART }, world.by))).toBe('not_a_books_org')
    expect(await refusedCode(importChart(world.storeId, { ...execute, accounts: CHART }, world.by))).toBe('not_a_books_org')
  })

  it('another company\'s file, whichever way it says so', async () => {
    expect(await refusedCode(importChart(world.orgId, { ...execute, eik: '111111111', accounts: CHART }, world.by))).toBe('other_company')
    const noTaxNumber = await createTestOrg({} as any)
    await Org.updateOne({ _id: noTaxNumber._id }, { $set: { 'settings.accounting.books': { mode: 'books' } } })
    expect(await refusedCode(importChart(String(noTaxNumber._id), { ...execute, accounts: CHART }, world.by))).toBe('other_company')
  })

  it('reads an EIK written as a VAT number', async () => {
    const answer = await importChart(world.orgId, { eik: `BG${EIK}`, accounts: CHART.slice(0, 1) }, world.by)
    expect(answer.created).toBe(1)
  })

  it('an account the chart does not hold, on a real run; a dry run answers and names it', async () => {
    const err = await captureRejection(importJournal('2025-03', [doc]))
    expect(err.code).toBe('unknown_accounts')
    expect(err.extra.accounts).toEqual(['401', '602'])
    const dry = await importJournal('2025-03', [doc], { dryRun: true })
    expect(dry).toMatchObject({ new: 1, unknownAccounts: ['401', '602'], fiscalPeriod: 'would_create' })
    expect(await JournalEntry.countDocuments({ orgId: world.orgId })).toBe(0)
    expect(await FiscalPeriod.countDocuments({ orgId: world.orgId })).toBe(0)
  })

  it('a document outside its month or what the file covers', async () => {
    await chartIn()
    expect(await refusedCode(importJournal('2025-04', [doc]))).toBe('document_outside_month')
    expect(await refusedCode(importJournal('2025-03', [doc], { coverage: { from: '2025-03-10', to: '2025-03-20' } }))).toBe('document_outside_month')
  })

  it('a closed period: an import never rewrites one', async () => {
    await chartIn()
    await importJournal('2025-03', [doc])
    await FiscalPeriod.updateMany({ orgId: world.orgId, number: 3 }, { $set: { status: 'closed' } })
    expect(await refusedCode(importJournal('2025-03', [doc]))).toBe('period_closed')
  })

  it('the employees\' analytics, whatever a client sends', async () => {
    expect(await refusedCode(importAnalytics(world.orgId, { ...execute, items: [{ path: 'ПЕРСОНАЛ:Някой' }] }, world.by))).toBe('personal_data')
  })

  it('names a document type the registry does not know, and imports it as booked', async () => {
    await chartIn()
    const answer = await importJournal('2025-03', [{ ...doc, docType: 'ХХ' }])
    expect(answer.unknownDocTypes).toEqual([{ docType: 'ХХ', count: 1 }])
    expect(await entryOf('ХХ', '1')).toBeTruthy()
  })
})

describe('the chart', () => {
  it('upserts by code, says what it dropped, and gives each account its shape', async () => {
    const accounts = [...CHART, { code: '#VALUE!', name: 'Счупен ред' }, { code: '7654321', name: 'Число' }]
    const dry = await importChart(world.orgId, { eik: EIK, accounts }, world.by)
    expect(dry).toMatchObject({ dryRun: true, created: CHART.length, updated: 0 })
    expect(await Account.countDocuments({ orgId: world.orgId })).toBe(0)

    const first = await importChart(world.orgId, { ...execute, accounts }, world.by)
    expect(first.created).toBe(CHART.length)
    expect(first.junk).toEqual([{ code: '#VALUE!', reason: 'code' }, { code: '7654321', reason: 'code' }])
    expect(await Account.findOne({ orgId: world.orgId, code: '411' }).lean()).toMatchObject({ type: 'asset', balanceSide: 'both', balance: 0 })

    const renamed = CHART.map(a => (a.code === '501' ? { ...a, name: 'Каса в евро' } : a))
    expect(await importChart(world.orgId, { ...execute, accounts: renamed }, world.by)).toMatchObject({ created: 0, updated: 1, unchanged: CHART.length - 1 })
    expect((await Account.findOne({ orgId: world.orgId, code: '501' }).lean() as any).name).toBe('Каса в евро')
  })
})

describe('the analytics', () => {
  const items = [
    { path: 'СТОКИ:БОЛТОВЕ', unit: 'бр' },
    { path: 'КЛИЕНТИ:Клиент А', taxId: '000000000', vatNumber: 'BG000000000', address: 'ул. Първа 1', city: 'Пример', phone: '000', contactPerson: 'Лице' },
    { path: 'КЛИЕНТИ:Без номер' },
    { path: 'ДОСТАВЧИЦИ:Доставчик А', taxId: '000000001' },
    { path: BANK, bankName: 'Банка' },
    { path: 'БАНКОВИ СМЕТКИ:XX00BANK0000000000000002', foreignCurrency: true },
    { path: 'ДА:Машина' },
  ]

  it('answers what it would do, and writes nothing on a dry run', async () => {
    const answer = await importAnalytics(world.orgId, { eik: EIK, items }, world.by)
    // Each path, and the roots above them.
    expect(answer).toMatchObject({ dryRun: true, created: items.length + 5 })
    expect(answer.byRoot['КЛИЕНТИ']).toBe(3)
    expect(answer.contacts).toEqual({ created: 3, linked: 0, withoutIdentifier: 1 })
    expect(await AccountingAnalytic.countDocuments({ orgId: world.orgId })).toBe(0)
    expect(await Contact.countDocuments({ orgId: world.orgId })).toBe(0)
  })

  it('links a partner to a Contact by ЕИК, and one with no number by name, as the seed skills do', async () => {
    await chartIn()
    await importAnalytics(world.orgId, { ...execute, items }, world.by)
    const contact: any = await Contact.findOne({ orgId: world.orgId, taxId: '000000000' }).lean()
    expect(contact).toMatchObject({ type: 'customer', companyName: 'Клиент А', taxNumber: '000000000', vatNumber: 'BG000000000', phone: '000', notes: 'МОЛ: Лице' })
    expect(contact.addresses[0]).toMatchObject({ street: 'ул. Първа 1', city: 'Пример', country: 'BG' })
    const analytic: any = await AccountingAnalytic.findOne({ orgId: world.orgId, path: CUSTOMER }).lean()
    expect(String(analytic.contactId)).toBe(String(contact._id))
    const nameless: any = await AccountingAnalytic.findOne({ orgId: world.orgId, path: 'КЛИЕНТИ:Без номер' }).lean()
    expect(nameless.contactId).toBeTruthy()
    expect((await Contact.findById(nameless.contactId).lean() as any).type).toBe('customer')
    const supplier: any = await AccountingAnalytic.findOne({ orgId: world.orgId, path: SUPPLIER }).lean()
    expect((await Contact.findById(supplier.contactId).lean() as any).type).toBe('supplier')
  })

  it('two companies of one name are two Contacts: a number is what says who someone is', async () => {
    await Contact.create({ orgId: world.orgId, type: 'customer', companyName: 'Клиент А', taxId: '111111111' })
    const answer = await importAnalytics(world.orgId, { ...execute, items: [items[1]] }, world.by)
    expect(answer.contacts).toEqual({ created: 1, linked: 0, withoutIdentifier: 0 })
    expect(await Contact.countDocuments({ orgId: world.orgId, companyName: 'Клиент А' })).toBe(2)
  })

  it('one with no number is found by name, as the seed skills find it', async () => {
    const existing = await Contact.create({ orgId: world.orgId, type: 'customer', companyName: 'Без номер', taxId: '111111111' })
    const answer = await importAnalytics(world.orgId, { ...execute, items: [items[2]] }, world.by)
    expect(answer.contacts).toEqual({ created: 0, linked: 1, withoutIdentifier: 1 })
    const analytic: any = await AccountingAnalytic.findOne({ orgId: world.orgId, path: 'КЛИЕНТИ:Без номер' }).lean()
    expect(String(analytic.contactId)).toBe(String(existing._id))
  })

  it('finds a Contact that is already there, rather than making a second', async () => {
    const existing = await Contact.create({ orgId: world.orgId, type: 'customer', companyName: 'Старо име', taxId: '000000000' })
    const answer = await importAnalytics(world.orgId, { ...execute, items: [items[1]] }, world.by)
    expect(answer.contacts).toEqual({ created: 0, linked: 1, withoutIdentifier: 0 })
    const analytic: any = await AccountingAnalytic.findOne({ orgId: world.orgId, path: CUSTOMER }).lean()
    expect(String(analytic.contactId)).toBe(String(existing._id))
  })

  it('gives a partner the journal met first the numbers a later file brings, and never overwrites one', async () => {
    await chartIn()
    await importJournal('2025-03', [{ date: '2025-03-03', docType: '-ФЕ', docNumber: '1', ops: [{ d: '411', k: '702', ad: CUSTOMER, amount: 1 }] }])
    const bare: any = await Contact.findOne({ orgId: world.orgId, companyName: 'Клиент А' }).lean()
    expect(bare.taxId).toBeUndefined()

    await importAnalytics(world.orgId, { ...execute, items: [items[1]] }, world.by)
    const filled: any = await Contact.findById(bare._id).lean()
    expect(filled).toMatchObject({ taxId: '000000000', taxNumber: '000000000', vatNumber: 'BG000000000', taxIdLower: '000000000', phone: '000' })
    expect(await Contact.countDocuments({ orgId: world.orgId, companyName: 'Клиент А' })).toBe(1)

    await Contact.updateOne({ _id: bare._id }, { $set: { phone: 'keyed by hand' } })
    await importAnalytics(world.orgId, { ...execute, items: [{ ...items[1], phone: '111' }] }, world.by)
    expect((await Contact.findById(bare._id).lean() as any).phone).toBe('keyed by hand')
  })

  it('links a bank account by IBAN, on 503 or on 504 for currency', async () => {
    await chartIn()
    const answer = await importAnalytics(world.orgId, { ...execute, items }, world.by)
    expect(answer.bankAccounts).toEqual({ created: 2, linked: 0, noLedgerAccount: 0 })
    const local: any = await BankAccount.findOne({ orgId: world.orgId, iban: IBAN }).lean()
    expect(String(local.accountId)).toBe(String((await accountOf('503'))._id))
    const foreign: any = await BankAccount.findOne({ orgId: world.orgId, iban: 'XX00BANK0000000000000002' }).lean()
    expect(String(foreign.accountId)).toBe(String((await accountOf('504'))._id))
    const analytic: any = await AccountingAnalytic.findOne({ orgId: world.orgId, path: BANK }).lean()
    expect(String(analytic.bankAccountId)).toBe(String(local._id))
  })

  it('links a fixed asset by name when there is one, and counts the rest', async () => {
    await chartIn()
    const account = await accountOf('204')
    const asset = await FixedAsset.create({
      orgId: world.orgId, code: 'FA-1', name: 'Машина', category: 'machinery', accountId: account._id, depreciationAccountId: account._id, accumulatedDepAccountId: account._id,
      purchaseDate: new Date('2024-01-01'), purchasePrice: 100, usefulLifeMonths: 60, depreciationMethod: 'straight_line', currentValue: 100, status: 'active',
    } as any)
    const answer = await importAnalytics(world.orgId, { ...execute, items: [{ path: 'ДА:Машина' }, { path: 'ДА:Друга' }] }, world.by)
    expect(answer.fixedAssets).toEqual({ linked: 1, unlinked: 1 })
    expect(String((await AccountingAnalytic.findOne({ orgId: world.orgId, path: 'ДА:Машина' }).lean() as any).fixedAssetId)).toBe(String(asset._id))
  })

  it('says when there is no chart to book a bank account on', async () => {
    const answer = await importAnalytics(world.orgId, { ...execute, items: [items[4]] }, world.by)
    expect(answer.bankAccounts).toEqual({ created: 0, linked: 0, noLedgerAccount: 1 })
  })

  it('is idempotent', async () => {
    await chartIn()
    await importAnalytics(world.orgId, { ...execute, items }, world.by)
    const second = await importAnalytics(world.orgId, { ...execute, items }, world.by)
    expect(second).toMatchObject({ created: 0, updated: 0, unchanged: items.length })
    expect(second.contacts).toEqual({ created: 0, linked: 0, withoutIdentifier: 0 })
    expect(second.bankAccounts).toEqual({ created: 0, linked: 2, noLedgerAccount: 0 })
  })

  it('a later file adds to what the journal already made', async () => {
    await chartIn()
    await importJournal('2025-03', [{ date: '2025-03-03', docType: '+ФЕ', docNumber: '1', ops: [{ d: '304', k: '401', ad: GOODS, ak: SUPPLIER, qty: 1, amount: 1 }] }])
    const answer = await importAnalytics(world.orgId, { ...execute, items: [items[0]] }, world.by)
    expect(answer).toMatchObject({ created: 0, updated: 1 })
    expect((await AccountingAnalytic.findOne({ orgId: world.orgId, path: GOODS }).lean() as any).unit).toBe('бр')
  })
})

describe('the opening', () => {
  const OPENING = {
    ...execute,
    year: 2026,
    accounts: [
      { code: '101', debit: 0, credit: 1000 },
      { code: '304', debit: 700, credit: 0 },
      { code: '411', debit: 400, credit: 0 },
      { code: '401', debit: 0, credit: 100 },
    ],
    analytics: [
      { code: '304', path: GOODS, debit: 700, credit: 0, quantity: 70 },
      { code: '411', path: CUSTOMER, debit: 300, credit: 0 },
      { code: '401', path: SUPPLIER, debit: 0, credit: 100 },
    ],
  }

  beforeEach(chartIn)

  it('is one entry, a line per account and analytic, each analytic with its quantity', async () => {
    const answer = await importOpening(world.orgId, OPENING, world.by)
    expect(answer).toMatchObject({ outcome: 'new', currency: 'EUR', lines: 5, balanced: true, accountsWithRemainder: ['411'], continuity: null })
    const entries: any[] = await JournalEntry.find({ orgId: world.orgId }).lean()
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ type: 'opening', status: 'posted', ledger: 'books' })
    expect(entries[0].date.toISOString().slice(0, 10)).toBe('2026-01-01')
    const goods = entries[0].lines.find((l: any) => l.quantity)
    expect(goods).toMatchObject({ debit: 700, quantity: 70, side: 'debit' })
  })

  it('leaves what the analytics do not explain on the account itself, so the account\'s balance is the file\'s', async () => {
    await importOpening(world.orgId, OPENING, world.by)
    const rows = (await trialBalance(world.orgId, { from: '2026-01-01', to: '2026-01-31' })).rows
    expect(rows.find(r => r.code === '411')).toMatchObject({ openingDebit: 400, closingDebit: 400, turnoverDebit: 0 })
    const customers = (await analyticTrialBalance(world.orgId, { from: '2026-01-01', to: '2026-01-31' }, 'КЛИЕНТИ')).rows
    expect(customers[0]).toMatchObject({ path: CUSTOMER, openingDebit: 300 })
  })

  it('carries the partner\'s Contact, as a journal line does', async () => {
    await importOpening(world.orgId, OPENING, world.by)
    const entry: any = await JournalEntry.findOne({ orgId: world.orgId }).lean()
    const contact: any = await Contact.findOne({ orgId: world.orgId, companyName: 'Клиент А' }).lean()
    expect(entry.lines.some((l: any) => String(l.contactId) === String(contact._id))).toBe(true)
  })

  it('is in the opening column and in no turnover, on the day of the period too', async () => {
    await importOpening(world.orgId, OPENING, world.by)
    await importJournal('2026-01', [{ date: '2026-01-02', docType: '-ФЕ', docNumber: '0000100001', ops: [{ d: '702', k: '304', ak: GOODS, qty: 10, amount: 100 }] }], { coverage: { from: '2026-01-01', to: '2026-12-31' } })
    const january = { from: '2026-01-01', to: '2026-01-31' }
    expect((await trialBalance(world.orgId, january)).rows.find(r => r.code === '304')).toMatchObject({ openingDebit: 700, turnoverCredit: 100, closingDebit: 600 })
    const goods = (await analyticTrialBalance(world.orgId, january, 'СТОКИ')).rows[0]
    expect(goods).toMatchObject({ openingQuantity: 70, turnoverCreditQuantity: 10, closingQuantity: 60 })

    // Later in the year, January is in the opening column.
    const february = { from: '2026-02-01', to: '2026-02-28' }
    expect((await trialBalance(world.orgId, february)).rows.find(r => r.code === '304')).toMatchObject({ openingDebit: 600, turnoverCredit: 0, closingDebit: 600 })
  })

  it('a dry rerun says unchanged, and a changed balance rewrites the same entry', async () => {
    await importOpening(world.orgId, OPENING, world.by)
    const before: any = await JournalEntry.findOne({ orgId: world.orgId }).lean()
    expect((await importOpening(world.orgId, { ...OPENING, dryRun: true }, world.by)).outcome).toBe('unchanged')

    const accounts = OPENING.accounts.map(a => (a.code === '101' ? { ...a, credit: 1001 } : a))
    expect((await importOpening(world.orgId, { ...OPENING, accounts }, world.by)).outcome).toBe('changed')
    const after: any[] = await JournalEntry.find({ orgId: world.orgId }).lean()
    expect(after).toHaveLength(1)
    expect(String(after[0]._id)).toBe(String(before._id))
    expect(after[0].entryNumber).toBe(before.entryNumber)
  })

  it('an analytic balance on the credit side keeps its stock on hand', async () => {
    const analytics = [{ code: '304', path: GOODS, debit: 0, credit: 5, quantity: 3 }]
    await importOpening(world.orgId, { ...execute, year: 2026, accounts: [{ code: '304', debit: 0, credit: 5 }], analytics }, world.by)
    const [goods] = (await analyticTrialBalance(world.orgId, { from: '2026-01-01', to: '2026-12-31' }, 'СТОКИ')).rows
    expect(goods).toMatchObject({ openingCredit: 5, openingQuantity: 3, closingQuantity: 3 })
  })

  it('answers with the books\' own closing of the year before, at the rate, per account (§5.3)', async () => {
    await importOpening(world.orgId, { ...execute, year: 2025, accounts: [{ code: '101', debit: 0, credit: 1955.83 }, { code: '501', debit: 1955.83, credit: 0 }] }, world.by)
    const year2026 = { ...execute, year: 2026, accounts: [{ code: '101', debit: 0, credit: 1000 }, { code: '501', debit: 1000, credit: 0 }] }
    expect((await importOpening(world.orgId, { ...year2026, dryRun: true }, world.by)).continuity).toEqual({ checked: 2, equal: 2, differing: [] })

    const off = { ...year2026, accounts: [{ code: '101', debit: 0, credit: 1000 }, { code: '501', debit: 999, credit: 0 }] }
    expect((await importOpening(world.orgId, { ...off, dryRun: true }, world.by)).continuity).toEqual({ checked: 2, equal: 1, differing: ['501'] })
  })

  it('a year\'s opening restates the year before: a reading across them does not add it twice', async () => {
    await importOpening(world.orgId, { ...execute, year: 2025, accounts: [{ code: '501', debit: 195.583, credit: 0 }, { code: '101', debit: 0, credit: 195.583 }] }, world.by)
    await importJournal('2025-03', [{ date: '2025-03-03', docType: '-ФЕ', docNumber: '0000100001', ops: [{ d: '501', k: '101', amount: 19.5583 }] }])
    await importOpening(world.orgId, { ...execute, year: 2026, accounts: [{ code: '501', debit: 110, credit: 0 }, { code: '101', debit: 0, credit: 110 }] }, world.by)

    const row = (await trialBalance(world.orgId, { from: '2026-01-01', to: '2026-12-31' })).rows.find(r => r.code === '501')
    expect(row).toMatchObject({ openingDebit: 110, turnoverDebit: 0, closingDebit: 110 })
    expect((await finishImport(world.orgId, { ...execute }, world.by)).changed).toBe(2)
    expect(await Account.findOne({ orgId: world.orgId, code: '501' }).lean()).toMatchObject({ balance: 110 })
  })
})

describe('finishing', () => {
  it('rebuilds each account\'s balance from the lines, once, in base', async () => {
    await chartIn()
    await importJournal('2025-03', [{ date: '2025-03-03', docType: '+ФЕ', docNumber: '1', ops: [{ d: '602', k: '401', ak: SUPPLIER, amount: 195.583 }] }])
    expect((await Account.findOne({ orgId: world.orgId, code: '602' }).lean() as any).balance).toBe(0)

    expect(await finishImport(world.orgId, { eik: EIK }, world.by)).toMatchObject({ dryRun: true, changed: 2 })
    expect((await Account.findOne({ orgId: world.orgId, code: '602' }).lean() as any).balance).toBe(0)

    await finishImport(world.orgId, execute, world.by)
    expect((await Account.findOne({ orgId: world.orgId, code: '602' }).lean() as any).balance).toBe(100)
    expect((await Account.findOne({ orgId: world.orgId, code: '401' }).lean() as any).balance).toBe(100)
    expect(await finishImport(world.orgId, execute, world.by)).toMatchObject({ changed: 0 })
  })
})

describe('the books, read back', () => {
  beforeEach(async () => {
    await chartIn()
    await importJournal('2025-03', MARCH)
    await importJournal('2025-12', DECEMBER)
  })

  it('a balance is a net on the side of its sign, in the currency of the year', async () => {
    const { currency, rows } = await trialBalance(world.orgId, MARCH_PERIOD)
    expect(currency).toBe('BGN')
    const row = rows.find(r => r.code === '304')!
    const net = row.turnoverDebit - row.turnoverCredit
    expect(net).toBeGreaterThan(0)
    expect(row.closingDebit).toBeCloseTo(net, 6)
    expect(row.closingCredit).toBe(0)
    const liability = rows.find(r => r.code === '4539')!
    expect(liability.closingDebit).toBeCloseTo(28, 6)
  })

  it('a period across the euro shows base amounts, in EUR', async () => {
    await importJournal('2026-01', [{ date: '2026-01-02', docType: '+ФЕ', docNumber: '1', ops: [{ d: '602', k: '401', amount: 10 }] }], { coverage: { from: '2026-01-01', to: '2026-01-31' } })
    expect((await trialBalance(world.orgId, { from: '2025-12-01', to: '2026-01-31' })).currency).toBe('EUR')
    expect((await trialBalance(world.orgId, { from: '2026-01-01', to: '2026-01-31' })).currency).toBe('EUR')
    expect((await trialBalance(world.orgId, { from: '2025-01-01', to: '2025-12-31' })).currency).toBe('BGN')
  })

  it('the main book pairs each operation, and adds up to the turnovers', async () => {
    const { accounts } = await mainBook(world.orgId, MARCH_PERIOD)
    const of = (code: string) => accounts.find(a => a.code === code)!
    const cost = 60.1234 + 300 - 6
    expect(of('702').counters.find(c => c.code === '304')!.debit).toBeCloseTo(cost, 6)
    expect(of('304').counters.find(c => c.code === '702')!.credit).toBeCloseTo(cost, 6)
    expect(of('304').counters.find(c => c.code === '702')!.debit).toBe(0)
    for (const account of accounts) {
      expect(account.counters.reduce((s, c) => s + c.debit, 0)).toBeCloseTo(account.turnoverDebit, 6)
      expect(account.counters.reduce((s, c) => s + c.credit, 0)).toBeCloseTo(account.turnoverCredit, 6)
    }
  })

  it('the chronology of an account runs its balance, line by line, with what each corresponds with', async () => {
    const account = await accountOf('304')
    const book = await chronology(world.orgId, account._id, MARCH_PERIOD, 1000)
    expect(book.rows.map(r => r.date)).toEqual([...book.rows.map(r => r.date)].sort())
    expect(book.truncated).toBe(false)
    const first = book.rows[0]
    expect(first).toMatchObject({ date: '2025-03-03', docType: '-ФЕ', docNumber: '0000100101', counterCode: '702', path: GOODS, quantityCredit: 10 })
    expect(first.balance).toBeCloseTo(-60.1234, 6)
    expect(first.quantityBalance).toBe(-10)
    const last = book.rows[book.rows.length - 1]
    expect(last.balance).toBeCloseTo(book.turnoverDebit - book.turnoverCredit, 6)
  })

  it('a chronology stops at its cap, and says so', async () => {
    const account = await accountOf('304')
    const book = await chronology(world.orgId, account._id, MARCH_PERIOD, 2)
    expect(book.rows).toHaveLength(2)
    expect(book.truncated).toBe(true)
  })

  it('the document journal lists documents, not operations, with what each says of itself', async () => {
    const { rows, truncated } = await documentJournal(world.orgId, MARCH_PERIOD, '-ФЕ', 1000)
    expect(truncated).toBe(false)
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({ docType: '-ФЕ', docNumber: '0000100101', docTotal: 120, docVat: 20, vatKind: '1' })
    expect(rows[0].partner[0].name).toBe('Клиент А')
    const all = await documentJournal(world.orgId, MARCH_PERIOD, undefined, 1000)
    expect(all.rows).toHaveLength(MARCH.filter(d => d.docType).length)
  })

  describe('on the report registry', () => {
    const run = (id: string, params: Record<string, unknown>, output: 'table' | 'xlsx' = 'table') =>
      reportById(id)!.handler!({ orgId: world.orgId, params: { period: MARCH_PERIOD, ...params }, output })

    it('each is in the catalog for who reads accounting, and only for them', () => {
      const ids = ['accounting-trial-balance', 'accounting-analytic-balance', 'accounting-main-book', 'accounting-chronology', 'accounting-documents']
      const seen = (permissions: string[]) => listReportsFor({ permissions, role: 'member' }).map(r => r.id)
      expect(seen(['accounting.read'])).toEqual(expect.arrayContaining(ids))
      for (const id of ids) expect(seen(['invoicing.read'])).not.toContain(id)
      for (const id of ids) expect(reportById(id)!.category).toBe('accounting')
      expect(REPORT_REGISTRY.filter(r => r.id.startsWith('accounting-'))).toHaveLength(5)
    })

    it('the trial balance has six columns, and totals that add up', async () => {
      const r = await run('accounting-trial-balance', {})
      expect(r.columns.map(c => c.key)).toEqual(['code', 'name', 'openingDebit', 'openingCredit', 'turnoverDebit', 'turnoverCredit', 'closingDebit', 'closingCredit'])
      expect(r.totals!.turnoverDebit).toBeCloseTo(r.totals!.turnoverCredit, 2)
      expect(r.meta).toMatchObject({ currency: 'BGN', truncated: false })
      expect(r.rows.find(x => x.code === '702')).toMatchObject({ name: 'Приходи от стоки', turnoverCredit: 580 })
    })

    it('the analytic balance shows quantities for goods', async () => {
      const r = await run('accounting-analytic-balance', { root: 'СТОКИ' })
      expect(r.columns.map(c => c.key)).toContain('closingQuantity')
      expect(r.rows).toEqual([expect.objectContaining({ path: GOODS, turnoverDebitQuantity: 108, turnoverCreditQuantity: 30, closingQuantity: 78 })])
    })

    it('the main book puts each correspondent under its account', async () => {
      const r = await run('accounting-main-book', {})
      const at = r.rows.findIndex(x => x.account.startsWith('702 -'))
      expect(r.rows[at]).toMatchObject({ counter: '' })
      expect(r.rows[at + 1].account).toBe('')
      expect(r.rows[at + 1].counter).toContain(' - ')
    })

    it('the chronology opens with the account\'s balance, and an unknown account is an empty table', async () => {
      const r = await run('accounting-chronology', { accountCode: '304' })
      expect(r.rows[0]).toMatchObject({ date: '', balance: 0 })
      expect(r.rows[1]).toMatchObject({ docNumber: '0000100101' })
      expect((await run('accounting-chronology', { accountCode: '999' })).rows).toEqual([])
    })

    it('the document journal filters on a type', async () => {
      const r = await run('accounting-documents', { docType: '+ББ' })
      expect(r.rows).toHaveLength(1)
      expect(r.rows[0]).toMatchObject({ docNumber: '901', currency: 'BGN' })
    })

    it('an org with no imported books reads what it has, in its base currency', async () => {
      const own = await createTestOrg({} as any)
      const r = await reportById('accounting-trial-balance')!.handler!({ orgId: String(own._id), params: { period: MARCH_PERIOD }, output: 'table' })
      expect(r.rows).toEqual([])
      expect(r.meta?.currency).toBe('EUR')
    })
  })
})

describe('the statements, over imported books', () => {
  const sheet = (rows: { account: string; balance: number }[], code: string) =>
    rows.filter(r => r.account.startsWith(`${code} `)).map(r => r.balance)

  beforeEach(chartIn)

  it('a customer who owes and one who paid in advance are not netted on 411', async () => {
    await importJournal('2025-03', [
      { date: '2025-03-03', docType: '-ФЕ', docNumber: '0000100001', ops: [{ d: '411', k: '702', ad: CUSTOMER, amount: 195.583 }] },
      { date: '2025-03-04', docType: '+ББ', docNumber: '1', ops: [{ d: '503', k: '411', ad: BANK, ak: PREPAID, amount: 58.6749 }] },
    ])

    const statement = await getBalanceSheet(world.orgId, new Date('2025-03-31T23:59:59Z'))
    expect(sheet(statement.assets, '411')).toEqual([100])
    expect(sheet(statement.liabilities, '411')).toEqual([30])
    expect(sheet(statement.assets, '503')).toEqual([30])
    expect(statement.totalAssets).toBe(130)
    expect(statement.totalLiabilitiesAndEquity).toBe(130)
  })

  it('cash paid to a supplier is still cash: only an account that runs on both sides is split', async () => {
    await importJournal('2025-03', [
      { date: '2025-03-02', docType: '+ББ', docNumber: '1', ops: [{ d: '501', k: '101', amount: 195.583 }] },
      { date: '2025-03-03', docType: '+ФЕ', docNumber: '2', ops: [
        { d: '602', k: '401', ak: SUPPLIER, amount: 58.6749 },
        { d: '401', k: '501', ad: SUPPLIER, ak: SUPPLIER, amount: 58.6749 },
      ] },
    ])
    const paid: any = await JournalEntry.findOne({ orgId: world.orgId, docType: '+ФЕ' }).lean()
    expect(paid.lines[3].contactId).toBeTruthy()

    const statement = await getBalanceSheet(world.orgId, new Date('2025-03-31T23:59:59Z'))
    expect(sheet(statement.assets, '501')).toEqual([70])
    expect(sheet(statement.liabilities, '501')).toEqual([])
    expect(statement.totalAssets).toBe(statement.totalLiabilitiesAndEquity)
  })

  it('the same from an opening: its partners carry their Contact too', async () => {
    await importOpening(world.orgId, {
      ...execute,
      year: 2026,
      accounts: [{ code: '411', debit: 100, credit: 30 }, { code: '101', debit: 0, credit: 70 }],
      analytics: [{ code: '411', path: CUSTOMER, debit: 100, credit: 0 }, { code: '411', path: PREPAID, debit: 0, credit: 30 }],
    }, world.by)

    const statement = await getBalanceSheet(world.orgId, new Date('2026-01-31T23:59:59Z'))
    expect(sheet(statement.assets, '411')).toEqual([100])
    expect(sheet(statement.liabilities, '411')).toEqual([30])
  })

  it('a year\'s opening is not added to the year before: a sheet reads from the last one', async () => {
    await importOpening(world.orgId, { ...execute, year: 2025, accounts: [{ code: '501', debit: 195.583, credit: 0 }, { code: '101', debit: 0, credit: 195.583 }] }, world.by)
    await importJournal('2025-03', [{ date: '2025-03-03', ops: [{ d: '501', k: '101', amount: 19.5583 }] }])
    await importOpening(world.orgId, { ...execute, year: 2026, accounts: [{ code: '501', debit: 110, credit: 0 }, { code: '101', debit: 0, credit: 110 }] }, world.by)

    expect(sheet((await getBalanceSheet(world.orgId, new Date('2025-12-31T23:59:59Z'))).assets, '501')).toEqual([110])
    expect(sheet((await getBalanceSheet(world.orgId, new Date('2026-06-30T23:59:59Z'))).assets, '501')).toEqual([110])
    expect((await getTrialBalance(world.orgId, {})).find(r => r.code === '501')?.debit).toBe(110)
  })

  it('a report across years reads a balance from the opening before the period', async () => {
    await importOpening(world.orgId, { ...execute, year: 2025, accounts: [{ code: '501', debit: 195.583, credit: 0 }, { code: '101', debit: 0, credit: 195.583 }] }, world.by)
    await importOpening(world.orgId, { ...execute, year: 2026, accounts: [{ code: '501', debit: 100, credit: 0 }, { code: '101', debit: 0, credit: 100 }] }, world.by)
    const { currency, rows } = await trialBalance(world.orgId, { from: '2025-06-01', to: '2026-06-30' })
    expect(currency).toBe('EUR')
    expect(rows.find(r => r.code === '501')).toMatchObject({ openingDebit: 100, turnoverDebit: 0, closingDebit: 100 })
  })

  describe('a shadow entry reaches no statement (FR-25 §3.4)', () => {
    const today = new Date().toISOString().slice(0, 10)
    const THIS_YEAR = { from: `${today.slice(0, 4)}-01-01`, to: today }
    const signer = new Elysia().use(jwt({ name: 'jwt', secret: config.jwt.secret }))

    /** What every statement says of the books, read through its own route or function. */
    async function everything() {
      const app = new Elysia().use(createApiApp())
      const user = await createTestUser(world.orgId as any, { role: 'admin' } as any)
      const token = await (signer as any).decorator.jwt.sign({
        id: String(user._id), orgId: world.orgId, role: 'admin', email: user.email, username: user.username,
        firstName: 'Test', lastName: 'User', permissions: DEFAULT_ROLE_PERMISSIONS.admin, ownRecordsModules: [],
      })
      const get = async (path: string) => {
        const res = await app.handle(new Request(`http://localhost/api/org/${world.orgId}${path}`, { headers: { authorization: `Bearer ${token}` } }))
        expect(res.status).toBe(200)
        return res.json() as any
      }
      const asOf = new Date(`${today}T23:59:59Z`)
      const account = await accountOf('702')
      const { revenue } = await get('/dashboard/summary')
      return {
        trialBalance: await getTrialBalance(world.orgId, {}),
        profitLoss: await getProfitLoss(world.orgId, new Date(THIS_YEAR.from), asOf),
        balanceSheet: await getBalanceSheet(world.orgId, asOf),
        journalAnalysis: await get(`/accounting/reports/journal-analysis?dateFrom=${THIS_YEAR.from}&dateTo=${today}`),
        dashboard: { totalRevenue: revenue.totalRevenue, netIncome: revenue.netIncome },
        sixColumns: await trialBalance(world.orgId, THIS_YEAR),
        analytic: await analyticTrialBalance(world.orgId, THIS_YEAR),
        mainBook: await mainBook(world.orgId, THIS_YEAR),
        chronology: await chronology(world.orgId, account._id, THIS_YEAR, 1000),
        documents: await documentJournal(world.orgId, THIS_YEAR, undefined, 1000),
        balances: await balances(),
      }
    }

    async function balances() {
      await rebuildBalances(world.orgId, false)
      return (await Account.find({ orgId: world.orgId, balance: { $ne: 0 } }, { _id: 0, code: 1, balance: 1 }).sort({ code: 1 }).lean())
    }

    it('none of them moves, and each one sees the same entry in the books', async () => {
      const entry: ImportDocument = { date: today, docType: '-ФЕ', docNumber: '0000100001', ops: [{ d: '411', k: '702', ad: CUSTOMER, amount: 100 }] }
      const coverage = { from: `${today.slice(0, 7)}-01`, to: today }
      await importJournal(today.slice(0, 7), [entry], { coverage })
      const before = await everything()
      expect(before.sixColumns.rows.find(r => r.code === '702')?.turnoverCredit).toBe(100)

      const stored: any = await JournalEntry.findOne({ orgId: world.orgId, docType: '-ФЕ' }).lean()
      const { _id, ...fields } = stored
      await JournalEntry.create({ ...fields, entryNumber: 'SHADOW-1', ledger: 'shadow', importKey: undefined, sourceModule: 'worker', docNumber: '0000100002' })
      expect(await JournalEntry.countDocuments({ orgId: world.orgId, ledger: 'shadow' })).toBe(1)

      expect(await everything()).toEqual(before)
    })

    it('posting a shadow entry moves no balance, and neither does voiding it', async () => {
      const revenue = await accountOf('702')
      const cash = await accountOf('501')
      const period = await FiscalPeriod.create({ orgId: world.orgId, fiscalYearId: new mongoose.Types.ObjectId(), name: 'March', number: 3, startDate: new Date('2025-03-01'), endDate: new Date('2025-03-31'), status: 'open' })
      const lines = [
        { accountId: cash._id, debit: 10, credit: 0, currency: 'EUR', exchangeRate: 1, baseDebit: 10, baseCredit: 0 },
        { accountId: revenue._id, debit: 0, credit: 10, currency: 'EUR', exchangeRate: 1, baseDebit: 0, baseCredit: 10 },
      ]
      const make = (entryNumber: string, ledger?: string) => JournalEntry.create({
        orgId: world.orgId, entryNumber, date: new Date('2025-03-03'), fiscalPeriodId: period._id, description: 'Entry', type: 'standard',
        status: 'draft', ...(ledger ? { ledger } : {}), lines, totalDebit: 10, totalCredit: 10, createdBy: world.by.id,
      })
      const balance = async () => (await Account.findOne({ orgId: world.orgId, code: '501' }).lean() as any).balance

      const shadow = await make('SHADOW-3', 'shadow')
      await postJournalEntry(String(shadow._id), world.by.id)
      expect(await balance()).toBe(0)
      await voidJournalEntry(String(shadow._id))
      expect(await balance()).toBe(0)
      await postJournalEntry(String((await make('BOOKS-3'))._id), world.by.id)
      expect(await balance()).toBe(10)
    })

    it('and the same entry in the books moves every one of them: the test can fail', async () => {
      const entry: ImportDocument = { date: today, docType: '-ФЕ', docNumber: '0000100001', ops: [{ d: '411', k: '702', ad: CUSTOMER, amount: 100 }] }
      const coverage = { from: `${today.slice(0, 7)}-01`, to: today }
      await importJournal(today.slice(0, 7), [entry], { coverage })
      const before = await everything()

      const stored: any = await JournalEntry.findOne({ orgId: world.orgId, docType: '-ФЕ' }).lean()
      const { _id, ...fields } = stored
      await JournalEntry.create({ ...fields, entryNumber: 'BOOKS-2', importKey: undefined, sourceModule: 'worker', docNumber: '0000100002' })

      const after = await everything()
      for (const key of Object.keys(before) as (keyof typeof before)[]) expect(after[key]).not.toEqual(before[key])
    })
  })
})

describe('linking a legal entity', () => {
  const orgWith =(slug: string, taxNumber?: string) => createTestOrg({ slug, ...(taxNumber ? { taxNumber } : {}) } as any)

  const code = async (p: Promise<unknown>) => {
    const err = await captureRejection(p)
    expect(err).toBeInstanceOf(BooksLinkError)
    return err.code
  }

  it('creates the books org with the stores\' number and plan, and links them, on --execute only', async () => {
    await orgWith('store-a', EIK)
    await orgWith('store-b', EIK)
    const spec = {
      booksSlug: 'the-books',
      createWithName: 'Счетоводство',
      branches: [{ slug: 'store-a', code: 'A', docSeries: ['00001'] }, { slug: 'store-b', code: 'B' }],
    }

    expect(await linkBooks(spec, { dryRun: true })).toEqual({
      dryRun: true,
      booksOrg: { slug: 'the-books', state: 'would_create' },
      branches: [{ slug: 'store-a', code: 'A', state: 'would_link' }, { slug: 'store-b', code: 'B', state: 'would_link' }],
      externalBranches: [],
    })
    expect(await Org.findOne({ slug: 'the-books' })).toBeNull()

    const answer = await linkBooks(spec, { dryRun: false })
    expect(answer.booksOrg.state).toBe('created')

    const books: any = await Org.findOne({ slug: 'the-books' }).lean()
    expect(books).toMatchObject({
      taxNumber: EIK,
      subscription: { plan: 'professional', maxUsers: 50 },
      settings: { baseCurrency: 'EUR', timezone: 'Europe/Berlin', cashRegister: { requireConnectedDevice: false } },
    })
    expect(books.settings.accounting.books).toMatchObject({ mode: 'books' })
    expect(books.settings.accounting.books.branches.map((b: any) => [b.code, b.docSeries])).toEqual([['A', ['00001']], ['B', undefined]])
    const store: any = await Org.findOne({ slug: 'store-a' }).lean()
    expect(store.settings.accounting.books).toEqual({ mode: 'branch', booksOrgId: books._id, branchCode: 'A' })

    expect((await linkBooks({ ...spec, createWithName: undefined }, { dryRun: true })).branches.map(b => b.state)).toEqual(['already', 'already'])
  })

  it('names a store that sells outside LGR by its series, keeps it on a re-run that leaves it out, and refuses an overlap', async () => {
    await orgWith('store-a', EIK)
    await orgWith('the-books', EIK)
    const branches = [{ slug: 'store-a', code: 'A', docSeries: ['3000'] }]
    const spec = { booksSlug: 'the-books', branches, externalBranches: [{ code: 'W', docSeries: ['00000'] }] }

    expect((await linkBooks(spec, { dryRun: true })).externalBranches).toEqual([{ code: 'W', docSeries: ['00000'], state: 'would_set' }])
    expect((await Org.findOne({ slug: 'the-books' }).lean() as any).settings.accounting?.books).toBeUndefined()
    expect((await linkBooks(spec, { dryRun: false })).externalBranches[0].state).toBe('set')
    const held = async () => ((await Org.findOne({ slug: 'the-books' }).lean()) as any).settings.accounting.books
    expect((await held()).externalBranches).toEqual([{ code: 'W', docSeries: ['00000'] }])

    // Left out of a later run, it stays; named again, it is already there.
    expect((await linkBooks({ booksSlug: 'the-books', branches }, { dryRun: false })).externalBranches).toEqual([{ code: 'W', docSeries: ['00000'], state: 'already' }])
    expect((await held()).externalBranches).toEqual([{ code: 'W', docSeries: ['00000'] }])
    expect((await held()).branches.map((b: any) => b.code)).toEqual(['A'])

    const refused = (s: any) => linkBooks(s, { dryRun: true }).then(() => 'linked', e => (e instanceof BooksLinkError ? e.code : String(e)))
    expect(await refused({ ...spec, externalBranches: [{ code: 'W', docSeries: ['30001'] }] })).toBe('series_overlap')
    expect(await refused({ ...spec, externalBranches: [{ code: 'A', docSeries: ['00000'] }] })).toBe('duplicate_code')
    expect(await refused({ ...spec, externalBranches: [{ code: 'W', docSeries: [] }] })).toBe('no_series')
  })

  it('links an org that exists', async () => {
    await orgWith('store-a', EIK)
    await orgWith('the-books', EIK)
    expect((await linkBooks({ booksSlug: 'the-books', branches: [{ slug: 'store-a', code: 'A' }] }, { dryRun: false })).booksOrg.state).toBe('exists')
  })

  it('refuses two orgs of different taxNumber, on any side of the link', async () => {
    await orgWith('store-a', EIK)
    await orgWith('store-b', '111111111')
    await orgWith('other-books', '111111111')
    expect(await code(linkBooks({ booksSlug: 'x', createWithName: 'X', branches: [{ slug: 'store-a', code: 'A' }, { slug: 'store-b', code: 'B' }] }, { dryRun: true }))).toBe('tax_number_differs')
    expect(await code(linkBooks({ booksSlug: 'other-books', branches: [{ slug: 'store-a', code: 'A' }] }, { dryRun: false }))).toBe('tax_number_differs')
    expect((await Org.findOne({ slug: 'store-a' }).lean() as any).settings.accounting?.books).toBeUndefined()
  })

  it('refuses a branch of another books org, a books org as a branch, and an org with no number', async () => {
    await orgWith('store-a', EIK)
    await orgWith('books-1', EIK)
    await orgWith('books-2', EIK)
    await orgWith('no-number')
    await linkBooks({ booksSlug: 'books-1', branches: [{ slug: 'store-a', code: 'A' }] }, { dryRun: false })

    expect(await code(linkBooks({ booksSlug: 'books-2', branches: [{ slug: 'store-a', code: 'A' }] }, { dryRun: true }))).toBe('linked_elsewhere')
    expect(await code(linkBooks({ booksSlug: 'books-2', branches: [{ slug: 'books-1', code: 'A' }] }, { dryRun: true }))).toBe('branch_is_books')
    expect(await code(linkBooks({ booksSlug: 'store-a', branches: [{ slug: 'books-2', code: 'B' }] }, { dryRun: true }))).toBe('books_is_branch')
    expect(await code(linkBooks({ booksSlug: 'x', createWithName: 'X', branches: [{ slug: 'no-number', code: 'A' }] }, { dryRun: true }))).toBe('no_tax_number')
    expect(await code(linkBooks({ booksSlug: 'x', branches: [{ slug: 'store-a', code: 'A' }] }, { dryRun: true }))).toBe('unknown_org')
    expect(await code(linkBooks({ booksSlug: 'books-2', branches: [] }, { dryRun: true }))).toBe('no_branches')
    expect(await code(linkBooks({ booksSlug: 'store-a', branches: [{ slug: 'store-a', code: 'A' }] }, { dryRun: true }))).toBe('books_is_branch')
    expect(await code(linkBooks({ booksSlug: 'books-2', branches: [{ slug: 'store-a', code: 'A' }, { slug: 'no-number', code: 'A' }] }, { dryRun: true }))).toBe('duplicate_code')
  })

  it('runs only on global, whose field it is', async () => {
    const saved = config.node.role
    ;(config.node as any).role = 'master'
    try {
      expect(await code(linkBooks({ booksSlug: 'x', branches: [{ slug: 'a', code: 'A' }] }, { dryRun: true }))).toBe('not_global')
    } finally {
      ;(config.node as any).role = saved
    }
  })
})

describe('over HTTP', () => {
  let app: Elysia
  const signer = new Elysia().use(jwt({ name: 'jwt', secret: config.jwt.secret }))

  const tokenFor = async (orgId: unknown, role: keyof typeof DEFAULT_ROLE_PERMISSIONS) => {
    const user = await createTestUser(orgId as any, { role } as any)
    return (signer as any).decorator.jwt.sign({
      id: String(user._id), orgId: String(orgId), role, email: user.email, username: user.username,
      firstName: 'Test', lastName: 'User', permissions: DEFAULT_ROLE_PERMISSIONS[role], ownRecordsModules: [],
    })
  }

  const call = async (method: string, path: string, token: string, body?: unknown) => {
    const res = await app.handle(new Request(`http://localhost${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    }))
    return { status: res.status, body: await res.json().catch(() => null) as any }
  }

  beforeAll(() => {
    app = new Elysia().use(createApiApp())
  })

  it('an import needs `accounting.import`, which an accountant does not hold by default', async () => {
    const path = `/api/org/${world.orgId}/accounting/import/chart`
    const body = { eik: EIK, accounts: CHART }
    expect((await call('POST', path, await tokenFor(world.orgId, 'accountant'), body)).status).toBe(403)
    expect((await call('POST', path, await tokenFor(world.orgId, 'manager'), body)).status).toBe(403)
    expect((await call('POST', path, await tokenFor(world.orgId, 'nra_auditor'), body)).status).toBe(403)
    expect((await call('POST', path, await tokenFor(world.orgId, 'admin'), body)).status).toBe(200)
  })

  it('a request that names no `dryRun` writes nothing', async () => {
    const res = await call('POST', `/api/org/${world.orgId}/accounting/import/chart`, await tokenFor(world.orgId, 'admin'), { eik: EIK, accounts: CHART })
    expect(res.body).toMatchObject({ dryRun: true, created: CHART.length })
    expect(await Account.countDocuments({ orgId: world.orgId })).toBe(0)
  })

  it('a refusal answers with its code', async () => {
    const res = await call('POST', `/api/org/${world.orgId}/accounting/import/chart`, await tokenFor(world.orgId, 'admin'), { eik: '111111111', accounts: CHART })
    expect(res.status).toBe(422)
    expect(res.body.code).toBe('other_company')
  })

  it('a body that is not an export is refused before it reaches the service', async () => {
    const token = await tokenFor(world.orgId, 'admin')
    const path = `/api/org/${world.orgId}/accounting/import/journal`
    const res = await call('POST', path, token, { eik: EIK, month: '2025-3', coverage: COVERAGE, documents: [] })
    expect(res.status).toBe(422)
    expect((await call('POST', path, token, { month: '2025-03', coverage: COVERAGE, documents: [] })).status).toBe(422)
  })

  it('the whole of an import runs through the routes, and the comparison reads it back', async () => {
    const token = await tokenFor(world.orgId, 'admin')
    const post = (step: string, body: unknown) => call('POST', `/api/org/${world.orgId}/accounting/import/${step}`, token, body)
    expect((await post('chart', { ...execute, accounts: CHART })).status).toBe(200)
    expect((await post('analytics', { ...execute, items: [{ path: GOODS, unit: 'бр' }] })).status).toBe(200)
    expect((await post('opening', { ...execute, year: 2025, accounts: [{ code: '304', debit: 100, credit: 0 }, { code: '101', debit: 0, credit: 100 }] })).status).toBe(200)
    const month = await post('journal', { ...execute, month: '2025-03', coverage: COVERAGE, documents: MARCH })
    expect(month.status).toBe(200)
    expect(month.body).toMatchObject({ entries: MARCH.length, balanced: MARCH.length, new: MARCH.length })
    expect((await post('finish', execute)).status).toBe(200)

    const read = (what: string, query: string) => call('GET', `/api/org/${world.orgId}/accounting/books/${what}?${query}`, token)
    const tb = await read('trial-balance', 'from=2025-03-01&to=2025-03-31')
    expect(tb.status).toBe(200)
    expect(compareJournalAccounts({ documents: MARCH }, tb.body.rows).differingCells).toBe(0)
    const analytic = await read('analytic-trial-balance', 'from=2025-03-01&to=2025-03-31')
    expect(compareJournalAnalytics({ documents: MARCH }, analytic.body.rows).differingCells).toBe(0)
    const roots = await read('analytic-trial-balance', `from=2025-03-01&to=2025-03-31&root=${encodeURIComponent('СТОКИ')}`)
    expect(roots.body.rows.map((r: any) => r.path)).toEqual([GOODS])
    expect((await read('main-book', 'from=2025-03-01&to=2025-03-31')).status).toBe(200)
  })

  it('an org admin cannot write the link: it is a sys-admin\'s', async () => {
    const res = await call('PUT', `/api/org/${world.storeId}`, await tokenFor(world.storeId, 'admin'), {
      name: 'Renamed', settings: { accounting: { books: { mode: 'books' } }, timezone: 'Europe/Sofia' },
    })
    expect(res.status).toBe(200)
    const store: any = await Org.findById(world.storeId).lean()
    expect(store).toMatchObject({ name: 'Renamed', settings: { timezone: 'Europe/Sofia' } })
    expect(store.settings.accounting.books).toMatchObject({ mode: 'branch', branchCode: 'PZ' })
  })

  it('a store\'s user is refused on the books org: the link reads nothing across', async () => {
    const storeAdmin = await tokenFor(world.storeId, 'admin')
    expect((await call('GET', `/api/org/${world.orgId}/accounting/books/trial-balance?from=2025-01-01&to=2025-12-31`, storeAdmin)).status).toBe(403)
    expect((await call('GET', `/api/org/${world.orgId}/accounting/account`, storeAdmin)).status).toBe(403)
    expect((await call('POST', `/api/org/${world.orgId}/accounting/import/chart`, storeAdmin, { eik: EIK, accounts: CHART })).status).toBe(403)
    expect((await call('POST', `/api/org/${world.orgId}/reports/accounting-trial-balance/run`, storeAdmin, { params: {} })).status).toBe(403)
  })

  it('and the other way round', async () => {
    const booksAdmin = await tokenFor(world.orgId, 'admin')
    expect((await call('GET', `/api/org/${world.storeId}/accounting/account`, booksAdmin)).status).toBe(403)
  })

  it('a report runs through its route, with a member who reads accounting', async () => {
    await chartIn()
    await importJournal('2025-03', MARCH)
    const res = await call('POST', `/api/org/${world.orgId}/reports/accounting-trial-balance/run`, await tokenFor(world.orgId, 'member'), {
      params: { period: { preset: 'custom', ...MARCH_PERIOD } },
    })
    expect(res.status).toBe(200)
    expect(res.body.rows.length).toBeGreaterThan(20)
  })
})

describe('what is not imported', () => {
  it('nothing of a dry run reaches the numbering', async () => {
    await chartIn()
    await importJournal('2025-03', MARCH, { dryRun: true })
    expect(await Sequence.countDocuments({ orgId: world.orgId })).toBe(0)
    expect(await AccountingAnalytic.countDocuments({ orgId: world.orgId })).toBe(0)
    expect(await Contact.countDocuments({ orgId: world.orgId })).toBe(0)
  })
})

