import { Types } from 'mongoose'
import type { IAccountRepository, IJournalEntryRepository, JournalLineTotals, JournalLineTotalsQuery } from 'dal'
import type { IAccount, IJournalEntry } from 'dal/entities'
import { MongoRepository } from './base.repository.js'

export class MongoJournalEntryRepository extends MongoRepository<IJournalEntry> implements IJournalEntryRepository {
  async sumPostedLines({ orgId, fiscalPeriodIds, from, to, byContact }: JournalLineTotalsQuery): Promise<JournalLineTotals[]> {
    // ⚠ `orgId` is cast by hand: an aggregation is not cast against the schema, so as a string it
    // matches nothing and the statement comes back empty.
    const match: Record<string, unknown> = { orgId: new Types.ObjectId(orgId), status: 'posted' }
    if (fiscalPeriodIds) {
      match.fiscalPeriodId = { $in: fiscalPeriodIds.filter(id => Types.ObjectId.isValid(id)).map(id => new Types.ObjectId(id)) }
    }
    if (from || to) match.date = { ...(from ? { $gte: from } : {}), ...(to ? { $lte: to } : {}) }

    const rows = await this.model.aggregate([
      { $match: match },
      { $unwind: '$lines' },
      {
        $group: {
          _id: byContact ? { accountId: '$lines.accountId', contactId: '$lines.contactId' } : { accountId: '$lines.accountId' },
          debit: { $sum: '$lines.baseDebit' },
          credit: { $sum: '$lines.baseCredit' },
        },
      },
    ]).exec()

    return rows.map(row => ({
      accountId: String(row._id.accountId),
      ...(row._id.contactId ? { contactId: String(row._id.contactId) } : {}),
      debit: row.debit,
      credit: row.credit,
    }))
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
