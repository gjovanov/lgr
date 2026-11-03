import { Elysia } from 'elysia'
import { AppAuthService } from '../auth/app-auth.service.js'
import { JournalEntry } from 'db/models'
import { reportDayEnd, reportDayStart } from 'services/utils/report-day'

/**
 * Journal Analysis endpoint — server-side aggregation for pivot tables.
 * Groups journal entry lines by account + month, returns pre-aggregated data.
 */
export const journalAnalysisController = new Elysia({ prefix: '/org/:orgId/accounting/reports' })
  .use(AppAuthService)
  .get('/journal-analysis', async ({ params: { orgId }, query, status }) => {
    const from = reportDayStart(query.dateFrom)
    const to = reportDayEnd(query.dateTo)
    if (from === null || to === null) return status(422, { message: `Invalid date: ${from === null ? query.dateFrom : query.dateTo}` })

    const data = await JournalEntry.aggregate([
      {
        $match: {
          // ⚠ Cast by hand: an aggregation is not cast against the schema, so as a string this
          // matches nothing and the report comes back empty for everyone.
          orgId: new JournalEntry.base.Types.ObjectId(orgId),
          date: { $gte: from ?? new Date(new Date().getFullYear(), 0, 1), $lte: to ?? new Date() },
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
    ]).exec()

    return { data }
  }, { isSignIn: true })
