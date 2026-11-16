/**
 * FR-25a §3.6, §3.8: the journal entry's document header on the server. The journal grid's list with its filters, the
 * entries an entry's links name, and the entry behind each row of a VAT register.
 *
 * The rules themselves (what a header may hold, how a link is matched) are `config/journal-header.ts`, which the entry
 * form shares. This file only asks Mongo.
 */
import { AccountingAnalytic, JournalEntry } from 'db/models'
import {
  NOTICE_REGISTER_VARIANTS, docNumberVariants, paymentCodeOf, pickLinkedEntry, pickRegisterEntry, type EntryCandidate,
} from 'config/journal-header'
import { buildSearchFilter } from './search.utils'

/**
 * What the journal grid shows of an entry. Never its lines: an entry of the books carries a line per operation, and a
 * page of them is what the grid reads every time it moves.
 */
export const JOURNAL_LIST_FIELDS = [
  'entryNumber', 'date', 'description', 'reference', 'type', 'status', 'totalDebit', 'totalCredit', 'sourceModule', 'ledger',
  'docType', 'docNumber', 'docDate', 'docTotal', 'docCurrency', 'paymentCode', 'paidAmount', 'registerDocType', 'reportingMonth',
  'createdAt',
].join(' ')

export interface JournalListQuery {
  search?: unknown
  status?: unknown
  fiscalPeriodId?: unknown
  startDate?: unknown
  endDate?: unknown
  /** `cash` or `bank`: the documents paid that way (`paymentCode`). */
  payment?: unknown
  /** The documents paid some way whose paid amount falls short of their total. */
  unpaid?: unknown
  /** Debit and credit notices only. */
  notices?: unknown
  /** The entries reported in another month than their own (`reportingMonth`). */
  otherMonth?: unknown
  page?: unknown
  size?: unknown
  sortBy?: unknown
  sortOrder?: unknown
}

const flag = (v: unknown) => v === true || v === 'true' || v === '1'

/**
 * The list's filter. Each FR-25a filter states the `$type` of the partial index that serves it
 * (`journal-entry.model.ts`), or Mongo cannot use the index and reads every entry of the org to test one field.
 *
 * "Unpaid" compares two fields of the same entry, which no index can do: it reads the entries that are paid some way, and
 * no others. "Another month" compares the month an entry names with its own, on the few entries that name one.
 */
export function journalListFilter(orgId: string, q: JournalListQuery): Record<string, any> {
  const filter: Record<string, any> = { orgId }
  if (typeof q.search === 'string' && q.search.trim()) {
    Object.assign(filter, buildSearchFilter(q.search, ['entryNumber', 'description', 'docNumber']))
  }
  if (typeof q.status === 'string' && q.status) filter.status = q.status
  if (typeof q.fiscalPeriodId === 'string' && q.fiscalPeriodId) filter.fiscalPeriodId = q.fiscalPeriodId
  if (q.startDate || q.endDate) {
    filter.date = {}
    if (q.startDate) filter.date.$gte = new Date(String(q.startDate))
    if (q.endDate) filter.date.$lte = new Date(String(q.endDate))
  }

  const exprs: Record<string, unknown>[] = []
  const paymentCode = paymentCodeOf(q.payment)
  if (paymentCode) filter.paymentCode = { $type: 'string', $eq: paymentCode }
  if (flag(q.unpaid)) {
    filter.paymentCode ??= { $type: 'string' }
    filter.docTotal = { $type: 'number' }
    // By size, as `config/journal-header.ts#isUnpaid` has it: a credit notice not yet refunded is open too.
    exprs.push({ $lt: [{ $add: [{ $abs: { $ifNull: ['$paidAmount', 0] } }, 0.005] }, { $abs: '$docTotal' }] })
  }
  if (flag(q.notices)) filter.registerDocType = { $type: 'string', $in: [...NOTICE_REGISTER_VARIANTS] }
  if (flag(q.otherMonth)) {
    filter.reportingMonth = { $type: 'string' }
    // Days are stored at UTC midnight, and `$dateToString` reads UTC.
    exprs.push({ $ne: ['$reportingMonth', { $dateToString: { date: '$date', format: '%Y%m' } }] })
  }
  if (exprs.length) filter.$expr = exprs.length === 1 ? exprs[0] : { $and: exprs }
  return filter
}

const SORT_KEY = /^[A-Za-z0-9_.]{1,60}$/
/** "All" is a backstop, not a promise: a books org holds years of entries. */
const MAX_ROWS = 100_000

/** A stored entry as the routes answer it: its id as `_id` and `id`, as the repositories map one (`dal-mongo#toEntity`). */
function asEntity<T extends { _id: unknown }>(doc: T) {
  return { ...doc, _id: String(doc._id), id: String(doc._id) }
}

/** A page of the journal, as the grid shows it. The shape of `IRepository#findAll`'s answer. */
export async function listJournalEntries(orgId: string, q: JournalListQuery) {
  const filter = journalListFilter(orgId, q)
  const page = Math.max(0, Number(q.page) || 0)
  const asked = q.size === undefined || q.size === '' ? 10 : Number(q.size)
  const size = Number.isNaN(asked) ? 10 : asked
  const sortBy = typeof q.sortBy === 'string' && SORT_KEY.test(q.sortBy) ? q.sortBy : 'createdAt'
  const sort: Record<string, 1 | -1> = { [sortBy]: q.sortOrder === 'asc' ? 1 : -1 }
  const find = () => JournalEntry.find(filter).select(JOURNAL_LIST_FIELDS).sort(sort)

  if (size <= 0) {
    const docs = await find().limit(MAX_ROWS).lean()
    return { items: docs.map(asEntity), total: docs.length, page: 0, size: docs.length, totalPages: 1 }
  }
  const [docs, total] = await Promise.all([
    find().skip(page * size).limit(size).lean(),
    JournalEntry.countDocuments(filter),
  ])
  return { items: docs.map(asEntity), total, page, size, totalPages: Math.ceil(total / size) }
}

const asCandidate = (d: any): EntryCandidate => ({
  id: String(d._id),
  docType: d.docType,
  docNumber: d.docNumber,
  registerDocType: d.registerDocType,
  partnerAnalyticId: d.partnerAnalyticId ? String(d.partnerAnalyticId) : undefined,
  date: d.date,
  docDate: d.docDate,
  status: d.status,
  ledger: d.ledger,
})

/**
 * The entry with each link's own entry (`entryId`) where exactly one is it (`pickLinkedEntry`), and its partner's name.
 * A link to a document this org does not hold (another org of a split's, a month not imported) stays without one.
 */
export async function withHeaderReferences<E extends { id?: string; links?: any[]; partnerAnalyticId?: string }>(orgId: string, entry: E) {
  const links = entry.links ?? []
  // Per link, its type and every spelling of its number: each branch is a seek in `{orgId, docType, docNumber}`.
  const branches = links
    .filter(l => l?.docType && l?.docNumber)
    .map(l => ({ docType: l.docType, docNumber: { $in: docNumberVariants(l.docNumber) } }))
  const [docs, partner] = await Promise.all([
    branches.length
      ? JournalEntry.find({ orgId, $or: branches }).select('docType docNumber partnerAnalyticId date docDate status').limit(500).lean()
      : Promise.resolve([] as any[]),
    entry.partnerAnalyticId
      ? AccountingAnalytic.findOne({ _id: entry.partnerAnalyticId, orgId }).select('name path').lean()
      : Promise.resolve(null),
  ])
  const candidates = docs.map(asCandidate)
  const self = { id: entry.id, partnerAnalyticId: entry.partnerAnalyticId }
  return {
    ...entry,
    ...(links.length ? {
      links: links.map(l => {
        const entryId = pickLinkedEntry(l, self, candidates)
        return entryId ? { ...l, entryId } : l
      }),
    } : {}),
    ...(partner ? { partnerName: (partner as any).name, partnerPath: (partner as any).path } : {}),
  }
}

/**
 * Each VAT register row with the journal entry behind it (`journalEntryId`, `journalEntryNumber`) where exactly one is
 * (`pickRegisterEntry`). One query for the page: every spelling of its numbers, a seek each in
 * `{orgId, docType, docNumber}`. A row whose document this org's journal does not hold (a store's own sales in a split)
 * stays without one.
 */
export async function withRegisterEntries<R extends { docTypeCode: string; docNumber: string; docDate?: Date | string }>(orgId: string, rows: R[]) {
  const numbers = [...new Set(rows.flatMap(r => docNumberVariants(r.docNumber)))]
  if (!numbers.length) return rows
  const docs = await JournalEntry.find({ orgId, docNumber: { $in: numbers } })
    .select('entryNumber docNumber registerDocType date docDate status ledger')
    .lean()
  const candidates = docs.map(asCandidate)
  const numberOf = new Map(docs.map((d: any) => [String(d._id), d.entryNumber as string]))
  return rows.map(r => {
    const id = pickRegisterEntry(r, candidates)
    return id ? { ...r, journalEntryId: id, journalEntryNumber: numberOf.get(id) } : r
  })
}
