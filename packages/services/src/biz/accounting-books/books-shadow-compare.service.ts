import { mongoose } from 'db/connection'
import { Account, BOOKS_IMPORT, JournalEntry, POSTED_BOOKS, SHADOW_SALES, VatRegisterEntry } from 'db/models'
import { REGISTER_DOC_TYPES } from '../vat-files/sales-register.js'
import { compareMonth, compareRegisterRows, type MonthComparison, type MonthEntry, type RegisterCounts, type RegisterRow } from './books-shadow-compare.js'
import { booksOrgsOf } from './group-cost.service.js'
import { placeOf } from './product-groups.js'
import { ProductGroupsError, seriesOf } from './product-groups.service.js'
import { DOC_TYPES } from './registry.js'
import { sideOf } from './shadow-sales.service.js'

/**
 * FR-25 R3, slice 5: one store's month, books against shadow (§6.3). Reads, never writes. The comparison itself is
 * `books-shadow-compare.ts`, which boots nothing.
 *
 * Where it reads (R7): the store's own books entries and its shadow postings in the store, which name the same goods
 * groups by the same ids; the sales register's rows in the HOME, which holds the VAT files, the shadow's by the store
 * they came from, the filed ones by the store's own series.
 */

export class BooksShadowError extends Error {
  constructor(message: string, readonly code: 'not_a_books_org' | 'no_series' | 'bad_period') {
    super(message)
    this.name = 'BooksShadowError'
  }
}

export interface BooksShadowMonth extends MonthComparison {
  /** `YYYYMM`. */
  period: string
  register: RegisterCounts
  /** The books' sales entries of the month the shadow never posts: the tills' months (slice 4) and other series. */
  leftOut: { till: number; otherSeries: number }
}

const oid = (v: unknown) => new mongoose.Types.ObjectId(String(v))
const SALES_TYPES = DOC_TYPES.filter(d => d.family === 'sales').map(d => d.code)
const DOCUMENT_ROWS = new Set(Object.values(REGISTER_DOC_TYPES))

/** Its stored lines, as the comparison reads them: account code, analytic, side, amount on that side, quantity. */
function linesOf(entry: any, codes: ReadonlyMap<string, string>): MonthEntry['lines'] {
  return (entry.lines ?? []).map((l: any) => {
    const side = sideOf(l)
    return {
      account: codes.get(String(l.accountId)) ?? '', ...(l.analyticId ? { analyticId: String(l.analyticId) } : {}), side,
      amount: side === 'credit' ? Number(l.credit) || 0 : Number(l.debit) || 0, ...(typeof l.quantity === 'number' ? { quantity: l.quantity } : {}),
    }
  })
}

export async function compareBooksShadowOf(orgId: string, period: string): Promise<BooksShadowMonth> {
  if (!/^\d{4}(0[1-9]|1[0-2])$/.test(period)) throw new BooksShadowError(`Not a period: ${period} (YYYYMM)`, 'bad_period')
  const series = await seriesOf(orgId).catch(e => {
    if (e instanceof ProductGroupsError && (e.code === 'not_a_books_org' || e.code === 'no_series')) throw new BooksShadowError(e.message, e.code)
    throw e
  })
  const { homeOrg } = await booksOrgsOf(orgId)
  const org = oid(orgId)
  const y = Number(period.slice(0, 4)), m = Number(period.slice(4))
  // Entries are dated on their business day at UTC midnight, the books' and the shadow's alike.
  const date = { $gte: new Date(Date.UTC(y, m - 1, 1)), $lt: new Date(Date.UTC(y, m, 1)) }
  const codes = new Map((await Account.find({ orgId: org }).select('code').lean<{ _id: unknown; code: string }[]>()).map(a => [String(a._id), a.code]))
  const select = 'docType docNumber registerDocType sourceId lines.accountId lines.analyticId lines.side lines.debit lines.credit lines.quantity'

  const leftOut = { till: 0, otherSeries: 0 }
  const books: MonthEntry[] = []
  for await (const e of JournalEntry.find({ orgId: org, ...POSTED_BOOKS, sourceModule: BOOKS_IMPORT, docType: { $in: SALES_TYPES }, date }).select(select).lean<any[]>().cursor()) {
    const place = placeOf(e, series)
    if (place === 'till') { leftOut.till++; continue }
    if (place !== 'own') { leftOut.otherSeries++; continue }
    books.push({ docNumber: String(e.docNumber ?? ''), ...(e.registerDocType ? { registerDocType: String(e.registerDocType) } : {}), lines: linesOf(e, codes) })
  }
  const shadow: MonthEntry[] = []
  for await (const e of JournalEntry.find({ orgId: org, status: 'posted', ledger: 'shadow', sourceModule: SHADOW_SALES, date }).select(select).lean<any[]>().cursor()) {
    shadow.push({
      docNumber: String(e.docNumber ?? ''), ...(e.registerDocType ? { registerDocType: String(e.registerDocType) } : {}),
      ...(e.sourceId ? { sourceId: String(e.sourceId) } : {}), lines: linesOf(e, codes),
    })
  }

  const rowSelect = 'docTypeCode docNumber docDate partnerVat cells'
  const home = oid(homeOrg)
  const shadowRows = await VatRegisterEntry.find({ orgId: home, ledger: 'shadow', side: 'sales', period, 'source.orgId': org }).select(rowSelect).lean<RegisterRow[]>()
  // The filed rows of the store's own documents: a ten-digit number in its series. The home's register also holds the
  // other store's, the tills' months and the protocols.
  const filedRows = (await VatRegisterEntry.find({ orgId: home, ledger: 'books', side: 'sales', period }).select(rowSelect).lean<RegisterRow[]>())
    .filter(r => DOCUMENT_ROWS.has(r.docTypeCode) && /^\d{10}$/.test(r.docNumber) && series.own.some(s => !!s && r.docNumber.startsWith(s)))

  return { period, ...compareMonth(books, shadow), register: compareRegisterRows(shadowRows, filedRows), leftOut }
}
