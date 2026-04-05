import { Elysia } from 'elysia'
import { AppAuthService } from '../auth/app-auth.service.js'
import { JournalEntry } from 'db/models'

/**
 * Journal Analysis endpoint — server-side aggregation for pivot tables.
 * Groups journal entry lines by account + month, returns pre-aggregated data.
 */
export const journalAnalysisController = new Elysia({ prefix: '/org/:orgId/accounting/reports' })
  .use(AppAuthService)
  .get('/journal-analysis', async ({ params: { orgId }, query }) => {
    const dateFrom = query.dateFrom ? new Date(query.dateFrom as string) : new Date(new Date().getFullYear(), 0, 1)
    const dateTo = query.dateTo ? new Date(query.dateTo as string) : new Date()

    const pipeline = [
      {
        $match: {
          orgId: { $exists: true },
          date: { $gte: dateFrom, $lte: dateTo },
          status: { $in: ['posted', 'draft'] },
        },
      },
      { $unwind: '$lines' },
      {
        $group: {
          _id: {
            accountId: '$lines.accountId',
            month: { $dateToString: { format: '%Y-%m', date: '$date' } },
          },
          totalDebit: { $sum: '$lines.baseDebit' },
          totalCredit: { $sum: '$lines.baseCredit' },
          count: { $sum: 1 },
        },
      },
      {
        $lookup: {
          from: 'accounts',
          localField: '_id.accountId',
          foreignField: '_id',
          as: 'account',
        },
      },
      { $unwind: { path: '$account', preserveNullAndEmptyArrays: true } },
      {
        $project: {
          _id: 0,
          accountId: '$_id.accountId',
          accountCode: '$account.code',
          accountName: '$account.name',
          accountType: '$account.type',
          month: '$_id.month',
          totalDebit: { $round: ['$totalDebit', 2] },
          totalCredit: { $round: ['$totalCredit', 2] },
          balance: { $round: [{ $subtract: ['$totalDebit', '$totalCredit'] }, 2] },
          count: 1,
        },
      },
      { $sort: { accountCode: 1, month: 1 } },
    ]

    // Use orgId filter via tenant plugin's pre-hook on the model
    const results = await JournalEntry.aggregate([
      { $match: { orgId: orgId } },
      ...pipeline.slice(0), // clone
    ]).exec()

    // Fix: replace the first $match with orgId-aware one
    const orgAwarePipeline = [
      {
        $match: {
          orgId: orgId,
          date: { $gte: dateFrom, $lte: dateTo },
          status: { $in: ['posted', 'draft'] },
        },
      },
      ...pipeline.slice(1),
    ]

    const data = await JournalEntry.aggregate(orgAwarePipeline).exec()

    return { data }
  }, { isSignIn: true })
