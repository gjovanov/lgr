import { mongoose } from 'db/connection'
import { Account, AccountingAnalytic, BOOKS_IMPORT, IMPORTED_OPENING, JournalEntry, Org, POSTED_BOOKS } from 'db/models'
import { GroupCostBook, type CostBucket } from './group-cost.js'
import { GOODS_ROOT } from './posting-rule-seed.js'
import { GOODS_ACCOUNT, ledgerCurrencyOn } from './registry.js'

/**
 * FR-25 R3, slice 3: the cost of every goods group, its moving average replayed from the books, for the sales of one
 * org up to a day (`group-cost.ts` holds the rules). Read from the COMPANY's books: in a split (R7) the home holds the
 * purchases and the opening and each store its own sales, so the group's average is the sum over every org of the
 * split, matched by the group's path. Only the books' lines: the shadow ledger never feeds the cost it is compared by
 * (`POSTED_BOOKS`).
 *
 * Aggregated in Mongo, one pipeline an org: what comes back is one sum per group and business day, never the entries.
 * The window starts at the company's last imported opening on or before the first sale day, as every reading of the
 * books does; a window that starts before 2026 reads base amounts (EUR, each line rounded once), as `books-ledger.ts`.
 */

const oid = (v: unknown) => new mongoose.Types.ObjectId(String(v))
const isoDay = (d: Date) => d.toISOString().slice(0, 10)
const DAY_MS = 86_400_000

interface BooksSettings {
  mode?: string
  split?: { homeOrgId?: unknown }
  branches?: { orgId?: unknown }[]
}

/** The orgs that hold the company's books, the one whose openings they start from, and where the VAT files are. */
export async function booksOrgsOf(orgId: string): Promise<{ ledgerOrgs: string[]; openingOrg: string; homeOrg: string }> {
  const org = await Org.findOne({ _id: oid(orgId) }).select('settings.accounting.books').lean<{ settings?: { accounting?: { books?: BooksSettings } } }>()
  const books = org?.settings?.accounting?.books
  const home = books?.split?.homeOrgId ? String(books.split.homeOrgId) : undefined
  if (!home) return { ledgerOrgs: [orgId], openingOrg: orgId, homeOrg: orgId }
  const branches = (books?.branches ?? []).map(b => (b.orgId ? String(b.orgId) : '')).filter(Boolean)
  return { ledgerOrgs: [...new Set([home, ...branches, orgId])], openingOrg: home, homeOrg: home }
}

export interface GroupCosts {
  /** The unit cost, in EUR, of one of the posting org's groups at the start of `day`. */
  unitCost(groupId: string, day: Date): number | undefined
  /** Counts only: the sums read, and from which day. */
  read: { buckets: number; from?: string; asBooked: boolean }
}

/**
 * The cost of the posting org's goods groups for sales on business days up to `to`, from the books' state at the
 * last imported opening on or before `from`.
 */
export async function loadGroupCosts(orgId: string, from: Date, to: Date): Promise<GroupCosts> {
  const { ledgerOrgs, openingOrg } = await booksOrgsOf(orgId)
  const opening = await JournalEntry.findOne({ orgId: oid(openingOrg), ...POSTED_BOOKS, ...IMPORTED_OPENING, date: { $lte: from } })
    .select('date').sort({ date: -1 }).lean<{ date: Date }>()
  const start = opening?.date
  const until = new Date(to.getTime() + DAY_MS)
  const first = start ?? (await JournalEntry.findOne({ orgId: { $in: ledgerOrgs.map(oid) }, ...POSTED_BOOKS }).select('date').sort({ date: 1 }).lean<{ date: Date }>())?.date
  // Sales post from 2026 on: a window inside the euro reads the amounts as booked, one that starts in leva reads base.
  const asBooked = !first || ledgerCurrencyOn(isoDay(first)) === 'EUR'
  const dates = { ...(start ? { $gte: start } : {}), $lt: until }

  const openingDays = (await JournalEntry.find({ orgId: oid(openingOrg), ...POSTED_BOOKS, ...IMPORTED_OPENING, date: dates }).select('date').lean<{ date: Date }[]>())
    .map(o => isoDay(o.date))

  const merged = new Map<string, CostBucket>()
  let pathOfPosting = new Map<string, string>()
  for (const ledgerOrg of ledgerOrgs) {
    const org = oid(ledgerOrg)
    const account = await Account.findOne({ orgId: org, code: GOODS_ACCOUNT }).select('_id').lean<{ _id: unknown }>()
    const groups = await AccountingAnalytic.find({ orgId: org, root: GOODS_ROOT, path: { $ne: GOODS_ROOT } }).select('path').lean<{ _id: unknown; path: string }[]>()
    const pathOf = new Map(groups.map(g => [String(g._id), g.path]))
    if (ledgerOrg === orgId) pathOfPosting = pathOf
    if (!account || !groups.length) continue
    const onLine = { 'lines.accountId': account._id, 'lines.analyticId': { $in: groups.map(g => g._id) } }
    const quantityOn = (side: 'debit' | 'credit') => ({ $sum: { $cond: [{ $eq: ['$lines.side', side] }, { $ifNull: ['$lines.quantity', 0] }, 0] } })
    // A line without a quantity moves value, not goods: `group-cost.ts` applies it to what is on hand, as booked.
    const valueOnlyOn = (side: 'debit' | 'credit') => ({
      $sum: { $cond: [{ $and: [{ $eq: ['$lines.side', side] }, { $eq: [{ $ifNull: ['$lines.quantity', 0] }, 0] }] }, `$lines.${asBooked ? side : side === 'debit' ? 'baseDebit' : 'baseCredit'}`, 0] },
    })
    const rows = await JournalEntry.aggregate([
      // Only the opening org's openings restate the year; no other org of a split holds one.
      { $match: { orgId: org, ...POSTED_BOOKS, date: dates, ...(ledgerOrg === openingOrg ? {} : { $nor: [IMPORTED_OPENING] }), 'lines.accountId': account._id } },
      { $project: { date: 1, type: 1, sourceModule: 1, lines: 1 } },
      { $unwind: '$lines' },
      { $match: onLine },
      {
        $group: {
          _id: {
            analyticId: '$lines.analyticId',
            day: { $dateToString: { format: '%Y-%m-%d', date: '$date' } },
            opening: { $and: [{ $eq: ['$type', IMPORTED_OPENING.type] }, { $eq: ['$sourceModule', BOOKS_IMPORT] }] },
          },
          debit: { $sum: asBooked ? '$lines.debit' : '$lines.baseDebit' },
          credit: { $sum: asBooked ? '$lines.credit' : '$lines.baseCredit' },
          quantityDebit: quantityOn('debit'),
          quantityCredit: quantityOn('credit'),
          debitValueOnly: valueOnlyOn('debit'),
          creditValueOnly: valueOnlyOn('credit'),
        },
      },
    ]).allowDiskUse(true).exec()
    for (const r of rows) {
      const path = pathOf.get(String(r._id.analyticId))
      if (!path) continue
      const key = `${path}\u0000${r._id.day}\u0000${r._id.opening ? 1 : 0}`
      const b = merged.get(key) ?? { path, day: r._id.day, opening: !!r._id.opening, debit: 0, credit: 0, quantityDebit: 0, quantityCredit: 0, debitValueOnly: 0, creditValueOnly: 0 }
      b.debit += Number(r.debit) || 0
      b.credit += Number(r.credit) || 0
      b.quantityDebit += Number(r.quantityDebit) || 0
      b.quantityCredit += Number(r.quantityCredit) || 0
      b.debitValueOnly = (b.debitValueOnly ?? 0) + (Number(r.debitValueOnly) || 0)
      b.creditValueOnly = (b.creditValueOnly ?? 0) + (Number(r.creditValueOnly) || 0)
      merged.set(key, b)
    }
  }

  const book = new GroupCostBook([...merged.values()], openingDays)
  return {
    unitCost: (groupId, day) => {
      const path = pathOfPosting.get(groupId)
      return path === undefined ? undefined : book.unitCostAt(path, isoDay(day))
    },
    read: { buckets: merged.size, ...(start ? { from: isoDay(start) } : {}), asBooked },
  }
}
