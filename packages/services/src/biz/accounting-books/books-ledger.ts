/**
 * FR-25 §8: the books the way the accountant reads them, from the posted lines: the six columns per
 * account and per analytic, the correspondences, an account's chronology and the documents. The
 * reports (`reports/accounting-books.report.ts`) and the comparison with PlusMinus read the same
 * functions, so what is proven is what is shown.
 *
 * Aggregated in Mongo, never loaded: a year is 150k rows (FR-25 §3.4). What adds up lines goes through
 * `sumPostedLines`, the statements' one reading, so what it leaves out (the shadow ledger, what an
 * opening restates) is left out here too.
 *
 * The rules, each proven on the accountant's own exports:
 * - **A balance is a net, on the side of its sign.** Every row of the trial balances is: 3,260 rows,
 *   no exceptions. So 411's closing is one number, and a per-partner split is the analytic report's.
 * - **Turnovers are per side, as booked.** A correction is a negative amount on its side, so a debit
 *   column can be negative, and nets nothing against the credit column.
 * - **An imported opening restates the year.** It carries what the year before ended with, so a
 *   reading that adds up lines starts at the last one, and it is never a turnover.
 * - **A year is in the currency it was booked in.** BGN before 2026-01-01 (FR-25 §11): a period
 *   inside one currency shows the amounts as booked, which is what compares to the cent. One that
 *   crosses the change shows base amounts, in EUR, each line rounded once.
 */
import { mongoose } from 'db/connection'
import { Account, AccountingAnalytic, BOOKS_IMPORT, IMPORTED_OPENING, JournalEntry, Org, POSTED_BOOKS } from 'db/models'
import { getRepos } from '../../context.js'
import { ledgerCurrencyOn } from './registry.js'

type ObjectId = mongoose.Types.ObjectId

export interface BooksPeriod {
  /** YYYY-MM-DD */
  from: string
  to: string
}

const oid = (v: unknown) => new mongoose.Types.ObjectId(String(v))
const startOf = (iso: string) => new Date(`${iso}T00:00:00.000Z`)
const endOf = (iso: string) => new Date(`${iso}T23:59:59.999Z`)

/** Sums of doubles carry noise past anything booked: the file's amounts have at most ten decimals. */
const clean = (n: number) => Math.round(n * 1e8) / 1e8 || 0

interface Amounts {
  asBooked: boolean
  currency: string
}

/**
 * Which amounts a reading adds up. An org that keeps its own books has no booked currency of its own:
 * its lines can be in anything, so its reports are in base, as every statement of it is (FR-25 D2).
 */
async function amountsFor(orgId: ObjectId, period: BooksPeriod): Promise<Amounts> {
  const org: any = await Org.findById(orgId, { 'settings.baseCurrency': 1, 'settings.accounting.books.mode': 1 }).lean()
  if (org?.settings?.accounting?.books?.mode !== 'books') return { asBooked: false, currency: org?.settings?.baseCurrency ?? 'EUR' }

  // What the opening column adds up starts here, not at the period.
  const from = startOf(period.from)
  const opening: any = await JournalEntry.findOne({ orgId, ...POSTED_BOOKS, ...IMPORTED_OPENING, date: { $lte: from } }, { date: 1 }).sort({ date: -1 }).lean()
  const first: any = opening ?? await JournalEntry.findOne({ orgId, ...POSTED_BOOKS }, { date: 1 }).sort({ date: 1 }).lean()

  const currency = ledgerCurrencyOn(period.to)
  const start = first?.date ? first.date.toISOString().slice(0, 10) : period.from
  return ledgerCurrencyOn(start) === currency ? { asBooked: true, currency } : { asBooked: false, currency: 'EUR' }
}

interface Cell {
  debit: number
  credit: number
  quantityDebit?: number
  quantityCredit?: number
}

const NO_CELL: Cell = { debit: 0, credit: 0 }

/** The two readings every report here is made of: what stands before the period, and what moved in it. */
function windows(orgId: string, period: BooksPeriod, amounts: Amounts, only?: string[]) {
  const from = startOf(period.from)
  const shared = { orgId, asBooked: amounts.asBooked, ...(only ? { only } : {}) }
  return {
    before: { ...shared, before: from },
    within: { ...shared, from, to: endOf(period.to), turnoverOnly: true },
  }
}

async function readAccounts(orgId: string, period: BooksPeriod, amounts: Amounts, only?: string[]) {
  const r = getRepos().journalEntries
  const { before, within } = windows(orgId, period, amounts, only)
  const [opening, turnover] = await Promise.all([r.sumPostedLines(before), r.sumPostedLines(within)])
  const byId = (rows: typeof opening) => new Map<string, Cell>(rows.map(row => [row.accountId, row]))
  return { opening: byId(opening), turnover: byId(turnover) }
}

async function readAnalytics(orgId: string, period: BooksPeriod, amounts: Amounts, only?: string[]) {
  const r = getRepos().journalEntries
  const { before, within } = windows(orgId, period, amounts, only)
  const [opening, turnover] = await Promise.all([r.sumPostedAnalytics(before), r.sumPostedAnalytics(within)])
  const byId = (rows: typeof opening) => new Map<string, Cell>(rows.map(row => [row.analyticId, row]))
  return { opening: byId(opening), turnover: byId(turnover) }
}

export interface BalanceColumns {
  openingDebit: number
  openingCredit: number
  turnoverDebit: number
  turnoverCredit: number
  closingDebit: number
  closingCredit: number
}

function balanceColumns(opening: Cell, turnover: Cell): BalanceColumns {
  const openingNet = opening.debit - opening.credit
  const closingNet = openingNet + turnover.debit - turnover.credit
  return {
    openingDebit: clean(Math.max(openingNet, 0)),
    openingCredit: clean(Math.max(-openingNet, 0)),
    turnoverDebit: clean(turnover.debit),
    turnoverCredit: clean(turnover.credit),
    closingDebit: clean(Math.max(closingNet, 0)),
    closingCredit: clean(Math.max(-closingNet, 0)),
  }
}

const isEmpty = (c: BalanceColumns) => !Object.values(c).some(Boolean)

export interface TrialBalanceRow extends BalanceColumns {
  accountId: string
  code: string
  name: string
}

/** Оборотна ведомост, синтетична: the accounts that hold or moved anything, by code. */
export async function trialBalance(orgId: string, period: BooksPeriod): Promise<{ currency: string; rows: TrialBalanceRow[] }> {
  const org = oid(orgId)
  const amounts = await amountsFor(org, period)
  const { opening, turnover } = await readAccounts(orgId, period, amounts)
  const ids = [...new Set([...opening.keys(), ...turnover.keys()])]
  const accounts: any[] = await Account.find({ orgId: org, _id: { $in: ids } }, { code: 1, name: 1 }).lean()

  const rows: TrialBalanceRow[] = []
  for (const account of accounts) {
    const id = String(account._id)
    const columns = balanceColumns(opening.get(id) ?? NO_CELL, turnover.get(id) ?? NO_CELL)
    if (!isEmpty(columns)) rows.push({ accountId: id, code: account.code, name: account.name, ...columns })
  }
  rows.sort((a, b) => a.code.localeCompare(b.code))
  return { currency: amounts.currency, rows }
}

export interface AnalyticBalanceRow extends BalanceColumns {
  analyticId: string
  path: string
  unit?: string
  openingQuantity: number
  turnoverDebitQuantity: number
  turnoverCreditQuantity: number
  closingQuantity: number
}

/**
 * Оборотна ведомост, аналитична. An analytic is one row whatever accounts it is on, as in PlusMinus:
 * КЛИЕНТИ:x on 411 and on 412 is one partner. Quantities add on the debit and go on the credit.
 */
export async function analyticTrialBalance(orgId: string, period: BooksPeriod, root?: string): Promise<{ currency: string; rows: AnalyticBalanceRow[] }> {
  const org = oid(orgId)
  const analytics: any[] = await AccountingAnalytic.find({ orgId: org, ...(root ? { root } : {}) }, { path: 1, unit: 1 }).lean()
  const amounts = await amountsFor(org, period)
  const { opening, turnover } = await readAnalytics(orgId, period, amounts, root ? analytics.map(a => String(a._id)) : undefined)

  const rows: AnalyticBalanceRow[] = []
  for (const analytic of analytics) {
    const id = String(analytic._id)
    const before = opening.get(id) ?? NO_CELL
    const during = turnover.get(id) ?? NO_CELL
    const columns = balanceColumns(before, during)
    const quantityDebit = during.quantityDebit ?? 0
    const quantityCredit = during.quantityCredit ?? 0
    const openingQuantity = (before.quantityDebit ?? 0) - (before.quantityCredit ?? 0)
    const closingQuantity = openingQuantity + quantityDebit - quantityCredit
    if (isEmpty(columns) && !openingQuantity && !quantityDebit && !quantityCredit) continue
    rows.push({
      analyticId: id,
      path: analytic.path,
      ...(analytic.unit ? { unit: analytic.unit } : {}),
      ...columns,
      openingQuantity: clean(openingQuantity),
      turnoverDebitQuantity: clean(quantityDebit),
      turnoverCreditQuantity: clean(quantityCredit),
      closingQuantity: clean(closingQuantity),
    })
  }
  rows.sort((a, b) => a.path.localeCompare(b.path, 'bg'))
  return { currency: amounts.currency, rows }
}

export interface MainBookAccount extends TrialBalanceRow {
  /** Each account it corresponds with: what was debited here against it, and credited. */
  counters: { code: string; name: string; debit: number; credit: number }[]
}

/**
 * Главна книга: each account with its correspondents. An operation is what pairs them, so a line with
 * no `opNo` (an entry typed in another way) is in the account's turnover and against no one.
 */
export async function mainBook(orgId: string, period: BooksPeriod): Promise<{ currency: string; accounts: MainBookAccount[] }> {
  const org = oid(orgId)
  const { currency, rows } = await trialBalance(orgId, period)
  const { asBooked } = await amountsFor(org, period)

  const pairs = await JournalEntry.aggregate([
    { $match: { orgId: org, ...POSTED_BOOKS, date: { $gte: startOf(period.from), $lte: endOf(period.to) }, $nor: [IMPORTED_OPENING], 'lines.opNo': { $exists: true } } },
    { $project: { 'lines.opNo': 1, 'lines.side': 1, 'lines.accountId': 1, 'lines.debit': 1, 'lines.baseDebit': 1 } },
    { $unwind: '$lines' },
    { $match: { 'lines.opNo': { $ne: null } } },
    {
      $group: {
        _id: { entry: '$_id', op: '$lines.opNo' },
        debit: { $max: { $cond: [{ $eq: ['$lines.side', 'debit'] }, '$lines.accountId', null] } },
        credit: { $max: { $cond: [{ $eq: ['$lines.side', 'credit'] }, '$lines.accountId', null] } },
        amount: { $sum: { $cond: [{ $eq: ['$lines.side', 'debit'] }, asBooked ? '$lines.debit' : '$lines.baseDebit', 0] } },
      },
    },
    { $group: { _id: { debit: '$debit', credit: '$credit' }, amount: { $sum: '$amount' } } },
  ]).allowDiskUse(true).exec()

  const counters = new Map<string, Map<string, { debit: number; credit: number }>>()
  const note = (account: string, counter: string, side: 'debit' | 'credit', amount: number) => {
    if (!counters.has(account)) counters.set(account, new Map())
    const row = counters.get(account)!.get(counter) ?? { debit: 0, credit: 0 }
    row[side] += amount
    counters.get(account)!.set(counter, row)
  }
  for (const { _id, amount } of pairs) {
    note(String(_id.debit), String(_id.credit), 'debit', amount)
    note(String(_id.credit), String(_id.debit), 'credit', amount)
  }

  const names = new Map((await Account.find({ orgId: org }, { code: 1, name: 1 }).lean()).map((a: any) => [String(a._id), a]))
  const accounts = rows.map(row => ({
    ...row,
    counters: [...(counters.get(row.accountId) ?? new Map<string, { debit: number; credit: number }>())]
      .map(([id, sides]) => ({ code: names.get(id)?.code ?? '', name: names.get(id)?.name ?? '', debit: clean(sides.debit), credit: clean(sides.credit) }))
      .sort((a, b) => a.code.localeCompare(b.code)),
  }))
  return { currency, accounts }
}

export interface ChronologyRow {
  date: string
  docType?: string
  docNumber?: string
  counterCode?: string
  counterPath?: string
  path?: string
  comment?: string
  quantityDebit?: number
  quantityCredit?: number
  quantityBalance: number
  debit: number
  credit: number
  balance: number
}

/**
 * Хронологична ведомост of one account: every line in order, each with what it corresponds with and
 * a running balance, from the account's opening.
 */
export async function chronology(orgId: string, accountId: ObjectId, period: BooksPeriod, cap: number) {
  const org = oid(orgId)
  const amounts = await amountsFor(org, period)
  const id = String(accountId)
  const { opening, turnover } = await readAccounts(orgId, period, amounts, [id])
  const before = opening.get(id) ?? NO_CELL
  const during = turnover.get(id) ?? NO_CELL
  const openingQuantity = (before.quantityDebit ?? 0) - (before.quantityCredit ?? 0)

  const lines = await JournalEntry.aggregate([
    { $match: { orgId: org, ...POSTED_BOOKS, 'lines.accountId': accountId, date: { $gte: startOf(period.from), $lte: endOf(period.to) }, $nor: [IMPORTED_OPENING] } },
    { $project: { date: 1, docType: 1, docNumber: 1, description: 1, lines: { accountId: 1, opNo: 1, side: 1, debit: 1, credit: 1, baseDebit: 1, baseCredit: 1, quantity: 1, analyticId: 1, description: 1 } } },
    { $sort: { date: 1, _id: 1 } },
    { $set: { own: { $filter: { input: '$lines', cond: { $eq: ['$$this.accountId', accountId] } } } } },
    { $unwind: '$own' },
    { $set: { counter: { $first: { $filter: { input: '$lines', cond: { $and: [{ $eq: ['$$this.opNo', '$own.opNo'] }, { $ne: ['$$this.side', '$own.side'] }] } } } } } },
    { $project: { lines: 0 } },
    { $limit: cap + 1 },
    { $set: amounts.asBooked ? { debit: '$own.debit', credit: '$own.credit' } : { debit: '$own.baseDebit', credit: '$own.baseCredit' } },
  ]).allowDiskUse(true).exec()

  const truncated = lines.length > cap
  const page = truncated ? lines.slice(0, cap) : lines

  const accounts = new Map((await Account.find({ orgId: org }, { code: 1 }).lean()).map((a: any) => [String(a._id), a.code as string]))
  const analyticIds = [...new Set(page.flatMap(l => [l.own.analyticId, l.counter?.analyticId]).filter(Boolean).map(String))]
  const paths = new Map((await AccountingAnalytic.find({ orgId: org, _id: { $in: analyticIds } }, { path: 1 }).lean()).map((a: any) => [String(a._id), a.path as string]))
  const pathOf = (id: unknown) => (id ? paths.get(String(id)) : undefined)

  let balance = before.debit - before.credit
  let quantityBalance = openingQuantity
  const rows: ChronologyRow[] = page.map(l => {
    const quantity = l.own.quantity
    const debitSide = l.own.side === 'debit'
    balance += (l.debit ?? 0) - (l.credit ?? 0)
    if (quantity) quantityBalance += debitSide ? quantity : -quantity
    return {
      date: l.date.toISOString().slice(0, 10),
      docType: l.docType,
      docNumber: l.docNumber,
      counterCode: l.counter ? accounts.get(String(l.counter.accountId)) : undefined,
      counterPath: pathOf(l.counter?.analyticId),
      path: pathOf(l.own.analyticId),
      comment: l.own.description ?? l.description,
      quantityDebit: debitSide ? quantity : undefined,
      quantityCredit: debitSide ? undefined : quantity,
      quantityBalance: clean(quantityBalance),
      debit: clean(l.debit ?? 0),
      credit: clean(l.credit ?? 0),
      balance: clean(balance),
    }
  })

  return {
    currency: amounts.currency,
    rows,
    truncated,
    opening: clean(before.debit - before.credit),
    openingQuantity: clean(openingQuantity),
    turnoverDebit: clean(during.debit),
    turnoverCredit: clean(during.credit),
  }
}

/** Журнал на документите: one row a document, with what the document itself says it is for. */
export async function documentJournal(orgId: string, period: BooksPeriod, docType: string | undefined, cap: number) {
  const org = oid(orgId)
  const rows = await JournalEntry.aggregate([
    { $match: { orgId: org, ...POSTED_BOOKS, date: { $gte: startOf(period.from), $lte: endOf(period.to) }, docType: docType ?? { $exists: true } } },
    { $sort: { date: 1, docNumber: 1 } },
    { $limit: cap + 1 },
    { $project: { date: 1, docDate: 1, docType: 1, docNumber: 1, vatKind: 1, docTotal: 1, docVat: 1, docCurrency: 1, description: 1, partnerAnalyticId: 1 } },
    {
      $lookup: {
        from: AccountingAnalytic.collection.name,
        localField: 'partnerAnalyticId',
        foreignField: '_id',
        as: 'partner',
        pipeline: [{ $project: { name: 1 } }],
      },
    },
  ]).allowDiskUse(true).exec()
  const truncated = rows.length > cap
  return { rows: truncated ? rows.slice(0, cap) : rows, truncated }
}

/** A year's closing per account, or null when nothing of that year is imported. */
export async function closingOfYear(orgId: string, year: number): Promise<{ currency: string; balances: Map<string, number> } | null> {
  const org = oid(orgId)
  const period = { from: `${year}-01-01`, to: `${year}-12-31` }
  const imported = await JournalEntry.exists({ orgId: org, ...POSTED_BOOKS, sourceModule: BOOKS_IMPORT, date: { $gte: startOf(period.from), $lte: endOf(period.to) } })
  if (!imported) return null
  const { currency, rows } = await trialBalance(orgId, period)
  return { currency, balances: new Map(rows.map(r => [r.code, r.closingDebit - r.closingCredit])) }
}

/**
 * `Account.balance` from the lines (FR-25 §5.5). A cache with no date that no statement reads any
 * more: the screens that list accounts still show it, so it must not stay at nothing.
 */
export async function rebuildBalances(orgId: string, dryRun: boolean): Promise<{ accounts: number; changed: number }> {
  const org = oid(orgId)
  const totals = new Map((await getRepos().journalEntries.sumPostedLines({ orgId })).map(t => [t.accountId, t]))

  const accounts: any[] = await Account.find({ orgId: org }, { type: 1, balance: 1 }).lean()
  const ops: any[] = []
  for (const account of accounts) {
    const total = totals.get(String(account._id))
    const net = (total?.debit ?? 0) - (total?.credit ?? 0)
    const balance = Math.round((['asset', 'expense'].includes(account.type) ? net : -net) * 100) / 100 || 0
    if (balance !== (account.balance ?? 0)) ops.push({ updateOne: { filter: { _id: account._id, orgId: org }, update: { $set: { balance } } } })
  }
  if (!dryRun && ops.length) await Account.bulkWrite(ops)
  return { accounts: accounts.length, changed: ops.length }
}
