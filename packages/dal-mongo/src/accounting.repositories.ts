import { Types } from 'mongoose'
import { IMPORTED_OPENING, POSTED_BOOKS } from 'db/models'
import type { IAccountRepository, IJournalEntryRepository, JournalAnalyticTotals, JournalLineTotals, JournalLineTotalsQuery } from 'dal'
import type { IAccount, IJournalEntry } from 'dal/entities'
import { MongoRepository } from './base.repository.js'

const ids = (list: string[]) => list.filter(id => Types.ObjectId.isValid(id)).map(id => new Types.ObjectId(id))

const quantityOn = (side: 'debit' | 'credit') => ({
  $sum: { $cond: [{ $eq: ['$lines.side', side] }, { $ifNull: ['$lines.quantity', 0] }, 0] },
})

const totals = (asBooked: boolean | undefined) => ({
  debit: { $sum: asBooked ? '$lines.debit' : '$lines.baseDebit' },
  credit: { $sum: asBooked ? '$lines.credit' : '$lines.baseCredit' },
  quantityDebit: quantityOn('debit'),
  quantityCredit: quantityOn('credit'),
})

const quantities = ({ quantityDebit, quantityCredit }: { quantityDebit: number; quantityCredit: number }) => ({
  ...(quantityDebit ? { quantityDebit } : {}),
  ...(quantityCredit ? { quantityCredit } : {}),
})

export class MongoJournalEntryRepository extends MongoRepository<IJournalEntry> implements IJournalEntryRepository {
  /** The imported opening a reading at `at` starts from; with no `at`, the last there is. */
  private lastOpening(orgId: Types.ObjectId, at?: Date): Promise<{ _id: Types.ObjectId; date: Date } | null> {
    return this.model
      .findOne({ orgId, ...POSTED_BOOKS, ...IMPORTED_OPENING, ...(at ? { date: { $lte: at } } : {}) }, { date: 1 })
      .sort({ date: -1 })
      .lean()
      .exec() as any
  }

  /** The one place that decides which entries a statement reads. */
  private async postedIn({ orgId, fiscalPeriodIds, from, to, before, turnoverOnly }: JournalLineTotalsQuery) {
    // ⚠ `orgId` is cast by hand: an aggregation is not cast against the schema, so as a string it
    // matches nothing and the statement comes back empty.
    const org = new Types.ObjectId(orgId)
    const match: Record<string, unknown> = { orgId: org, ...POSTED_BOOKS }
    if (fiscalPeriodIds) match.fiscalPeriodId = { $in: ids(fiscalPeriodIds) }

    if (before) {
      const opening = await this.lastOpening(org, before)
      if (opening) match.$or = [{ _id: opening._id }, { date: { $gte: opening.date, $lt: before } }]
      else match.date = { $lt: before }
    } else if (from || fiscalPeriodIds) {
      if (from || to) match.date = { ...(from ? { $gte: from } : {}), ...(to ? { $lte: to } : {}) }
    } else {
      const since = (await this.lastOpening(org, to))?.date
      if (since || to) match.date = { ...(since ? { $gte: since } : {}), ...(to ? { $lte: to } : {}) }
    }

    if (turnoverOnly) match.$nor = [IMPORTED_OPENING]
    return match
  }

  async sumPostedLines(query: JournalLineTotalsQuery): Promise<JournalLineTotals[]> {
    const { byContact, asBooked, only } = query
    const onLine = only ? { 'lines.accountId': { $in: ids(only) } } : {}

    const rows = await this.model.aggregate([
      { $match: { ...(await this.postedIn(query)), ...onLine } },
      { $project: { lines: 1 } },
      { $unwind: '$lines' },
      { $match: onLine },
      {
        $group: {
          _id: byContact ? { accountId: '$lines.accountId', contactId: '$lines.contactId' } : { accountId: '$lines.accountId' },
          ...totals(asBooked),
        },
      },
    ]).exec()

    return rows.map(row => ({
      accountId: String(row._id.accountId),
      ...(row._id.contactId ? { contactId: String(row._id.contactId) } : {}),
      debit: row.debit,
      credit: row.credit,
      ...quantities(row),
    }))
  }

  async sumPostedAnalytics(query: JournalLineTotalsQuery): Promise<JournalAnalyticTotals[]> {
    // ⚠ `$exists`, never `$ne: null`: before the `$unwind` that reads "no line lacks one", and drops
    // every document with a line on an account that has no analytics.
    const onLine = { 'lines.analyticId': query.only ? { $in: ids(query.only) } : { $exists: true } }

    const rows = await this.model.aggregate([
      { $match: { ...(await this.postedIn(query)), ...onLine } },
      { $project: { lines: 1 } },
      { $unwind: '$lines' },
      { $match: onLine },
      {
        $group: {
          _id: '$lines.analyticId',
          ...totals(query.asBooked),
        },
      },
    ]).exec()

    return rows.map(row => ({ analyticId: String(row._id), debit: row.debit, credit: row.credit, ...quantities(row) }))
  }
}

export class MongoAccountRepository extends MongoRepository<IAccount> implements IAccountRepository {
  async adjustBalances(orgId: string, amounts: Record<string, number>): Promise<void> {
    const ops = Object.entries(amounts)
      .filter(([, amount]) => amount)
      .map(([id, amount]) => ({
        updateOne: {
          filter: { _id: new Types.ObjectId(id), orgId: new Types.ObjectId(orgId) },
          // Rounded by the server, so a cached balance never drifts off the cent as doubles add up.
          update: [{ $set: { balance: { $round: [{ $add: [{ $ifNull: ['$balance', 0] }, amount] }, 2] } } }],
        },
      }))
    if (ops.length) await this.model.bulkWrite(ops as any)
  }
}
