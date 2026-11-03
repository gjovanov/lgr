/**
 * FR-25 §8: the accountant's four books on the report registry: Оборотна ведомост (synthetic and
 * analytic), Главна книга, Хронологична ведомост and Журнал на документите. The reading itself is
 * `accounting-books/books-ledger.ts`, which the comparison with PlusMinus proves; a handler here only
 * shapes it into rows and columns.
 */

import { Account } from 'db/models'
import {
  analyticTrialBalance,
  chronology,
  documentJournal,
  mainBook,
  trialBalance,
  type BalanceColumns,
  type BooksPeriod,
} from '../accounting-books/books-ledger.js'
import {
  rowCapFor,
  type ReportColumn,
  type ReportHandlerContext,
  type ReportResult,
} from '../report-registry.types.js'

const money = (n: number | undefined) => Math.round((n ?? 0) * 100) / 100 || 0

const periodOf = (ctx: ReportHandlerContext): BooksPeriod => ctx.params.period as BooksPeriod

const BALANCE_COLUMNS: { key: keyof BalanceColumns; labelKey: string }[] = [
  { key: 'openingDebit', labelKey: 'reports.accountingBooks.columns.openingDebit' },
  { key: 'openingCredit', labelKey: 'reports.accountingBooks.columns.openingCredit' },
  { key: 'turnoverDebit', labelKey: 'reports.accountingBooks.columns.turnoverDebit' },
  { key: 'turnoverCredit', labelKey: 'reports.accountingBooks.columns.turnoverCredit' },
  { key: 'closingDebit', labelKey: 'reports.accountingBooks.columns.closingDebit' },
  { key: 'closingCredit', labelKey: 'reports.accountingBooks.columns.closingCredit' },
]

const moneyColumns: ReportColumn[] = BALANCE_COLUMNS.map(c => ({ ...c, type: 'money', align: 'end' }))

const moneyCells = (row: Partial<BalanceColumns>) =>
  Object.fromEntries(BALANCE_COLUMNS.map(({ key }) => [key, money(row[key])]))

const totalsOf = (rows: Partial<BalanceColumns>[]) =>
  Object.fromEntries(BALANCE_COLUMNS.map(({ key }) => [key, money(rows.reduce((sum, r) => sum + (r[key] ?? 0), 0))]))

function capped<T>(rows: T[], ctx: ReportHandlerContext) {
  const cap = rowCapFor(ctx.output)
  return { page: rows.length > cap ? rows.slice(0, cap) : rows, meta: { truncated: rows.length > cap, cap, rowCount: rows.length } }
}

/** Оборотна ведомост, синтетична. */
export async function runAccountingTrialBalance(ctx: ReportHandlerContext): Promise<ReportResult> {
  const { currency, rows } = await trialBalance(ctx.orgId, periodOf(ctx))
  const { page, meta } = capped(rows, ctx)
  return {
    columns: [
      { key: 'code', labelKey: 'reports.accountingBooks.columns.code' },
      { key: 'name', labelKey: 'reports.accountingBooks.columns.account' },
      ...moneyColumns,
    ],
    rows: page.map(r => ({ code: r.code, name: r.name, ...moneyCells(r) })),
    totals: totalsOf(rows),
    meta: { ...meta, currency },
  }
}

/** Оборотна ведомост, аналитична: one root, with quantities. */
export async function runAccountingAnalyticBalance(ctx: ReportHandlerContext): Promise<ReportResult> {
  const { currency, rows } = await analyticTrialBalance(ctx.orgId, periodOf(ctx), ctx.params.root)
  const { page, meta } = capped(rows, ctx)
  const quantity = (key: string, labelKey: string): ReportColumn => ({ key, labelKey: `reports.accountingBooks.columns.${labelKey}`, type: 'quantity', align: 'end' })
  return {
    columns: [
      { key: 'path', labelKey: 'reports.accountingBooks.columns.analytic' },
      { key: 'unit', labelKey: 'reports.columns.unit' },
      quantity('openingQuantity', 'openingQuantity'),
      moneyColumns[0],
      moneyColumns[1],
      quantity('turnoverDebitQuantity', 'turnoverDebitQuantity'),
      quantity('turnoverCreditQuantity', 'turnoverCreditQuantity'),
      moneyColumns[2],
      moneyColumns[3],
      quantity('closingQuantity', 'closingQuantity'),
      moneyColumns[4],
      moneyColumns[5],
    ],
    rows: page.map(r => ({
      path: r.path,
      unit: r.unit ?? '',
      openingQuantity: r.openingQuantity,
      turnoverDebitQuantity: r.turnoverDebitQuantity,
      turnoverCreditQuantity: r.turnoverCreditQuantity,
      closingQuantity: r.closingQuantity,
      ...moneyCells(r),
    })),
    totals: totalsOf(rows),
    meta: { ...meta, currency },
  }
}

/**
 * Главна книга. An account's row holds its six columns, and the rows under it what it corresponds
 * with, in the same turnover columns: no row needs a word for "opening" in some language.
 */
export async function runAccountingMainBook(ctx: ReportHandlerContext): Promise<ReportResult> {
  const { currency, accounts } = await mainBook(ctx.orgId, periodOf(ctx))
  const rows = accounts.flatMap(a => [
    { account: `${a.code} - ${a.name}`, counter: '', ...moneyCells(a) },
    ...a.counters.map(c => ({
      account: '',
      counter: `${c.code} - ${c.name}`,
      ...moneyCells({ turnoverDebit: c.debit, turnoverCredit: c.credit }),
    })),
  ])
  const { page, meta } = capped(rows, ctx)
  return {
    columns: [
      { key: 'account', labelKey: 'reports.accountingBooks.columns.account' },
      { key: 'counter', labelKey: 'reports.accountingBooks.columns.counterAccount' },
      ...moneyColumns,
    ],
    rows: page,
    // Only the accounts' own rows: the rows under them repeat what those already add up.
    totals: totalsOf(accounts),
    meta: { ...meta, currency },
  }
}

/** Хронологична ведомост of one account, in order, with a running balance from its opening. */
export async function runAccountingChronology(ctx: ReportHandlerContext): Promise<ReportResult> {
  const columns: ReportColumn[] = [
    { key: 'date', labelKey: 'reports.columns.date', type: 'date' },
    { key: 'docType', labelKey: 'reports.columns.docType' },
    { key: 'docNumber', labelKey: 'reports.columns.document' },
    { key: 'counterCode', labelKey: 'reports.accountingBooks.columns.counterAccount' },
    { key: 'counterPath', labelKey: 'reports.accountingBooks.columns.counterAnalytic' },
    { key: 'path', labelKey: 'reports.accountingBooks.columns.analytic' },
    { key: 'comment', labelKey: 'reports.accountingBooks.columns.comment' },
    { key: 'quantityDebit', labelKey: 'reports.accountingBooks.columns.turnoverDebitQuantity', type: 'quantity', align: 'end' },
    { key: 'quantityCredit', labelKey: 'reports.accountingBooks.columns.turnoverCreditQuantity', type: 'quantity', align: 'end' },
    { key: 'quantityBalance', labelKey: 'reports.accountingBooks.columns.closingQuantity', type: 'quantity', align: 'end' },
    { key: 'debit', labelKey: 'reports.accountingBooks.columns.turnoverDebit', type: 'money', align: 'end' },
    { key: 'credit', labelKey: 'reports.accountingBooks.columns.turnoverCredit', type: 'money', align: 'end' },
    { key: 'balance', labelKey: 'reports.accountingBooks.columns.balance', type: 'money', align: 'end' },
  ]

  const account: any = await Account.findOne({ orgId: ctx.orgId, code: ctx.params.accountCode }, { _id: 1 }).lean()
  if (!account) return { columns, rows: [], meta: { rowCount: 0 } }

  const cap = rowCapFor(ctx.output)
  const book = await chronology(ctx.orgId, account._id, periodOf(ctx), cap)
  return {
    columns,
    rows: [
      // The opening is the row with a balance and no date: the columns say what it is.
      { date: '', balance: money(book.opening), quantityBalance: book.openingQuantity },
      ...book.rows.map(r => ({ ...r, debit: money(r.debit), credit: money(r.credit), balance: money(r.balance) })),
    ],
    totals: { debit: money(book.turnoverDebit), credit: money(book.turnoverCredit) },
    meta: { truncated: book.truncated, cap, rowCount: book.rows.length, currency: book.currency },
  }
}

/** Журнал на документите. */
export async function runAccountingDocuments(ctx: ReportHandlerContext): Promise<ReportResult> {
  const cap = rowCapFor(ctx.output)
  const { rows, truncated } = await documentJournal(ctx.orgId, periodOf(ctx), ctx.params.docType, cap)
  return {
    columns: [
      { key: 'date', labelKey: 'reports.columns.date', type: 'date' },
      { key: 'docType', labelKey: 'reports.columns.docType' },
      { key: 'docNumber', labelKey: 'reports.columns.document' },
      { key: 'partner', labelKey: 'reports.columns.contact' },
      { key: 'comment', labelKey: 'reports.accountingBooks.columns.comment' },
      { key: 'vatKind', labelKey: 'reports.accountingBooks.columns.vatKind' },
      { key: 'total', labelKey: 'reports.accountingBooks.columns.total', type: 'money', align: 'end' },
      { key: 'vat', labelKey: 'reports.accountingBooks.columns.vat', type: 'money', align: 'end' },
      { key: 'currency', labelKey: 'reports.accountingBooks.columns.currency' },
    ],
    rows: rows.map(r => ({
      date: r.date.toISOString().slice(0, 10),
      docType: r.docType,
      docNumber: r.docNumber ?? '',
      partner: r.partner?.[0]?.name ?? '',
      comment: r.description,
      vatKind: r.vatKind ?? '',
      total: money(r.docTotal),
      vat: money(r.docVat),
      currency: r.docCurrency ?? '',
    })),
    meta: { truncated, cap, rowCount: rows.length },
  }
}
