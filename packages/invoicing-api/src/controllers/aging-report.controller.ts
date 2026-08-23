import { Elysia } from 'elysia'
import { AppAuthService } from '../auth/app-auth.service.js'
import { Invoice } from 'db/models'

/**
 * Invoice Aging Report — server-side aggregation using $bucket.
 * Groups outstanding invoices by contact and aging bucket.
 */
export const agingReportController = new Elysia({ prefix: '/org/:orgId/invoicing/reports' })
  .use(AppAuthService)
  .get('/aging', async ({ params: { orgId }, query }) => {
    const asOfDate = query.asOfDate ? new Date(query.asOfDate as string) : new Date()
    const direction = (query.direction as string) || 'outgoing'

    const data = await Invoice.aggregate([
      {
        $match: {
          orgId: new Invoice.base.Types.ObjectId(orgId),
          direction,
          // `received` is the open state of an issued bill/incoming note — without it the
          // payables aging showed nothing until a partial payment landed.
          status: { $in: ['sent', 'received', 'partially_paid', 'overdue'] },
        },
      },
      {
        $addFields: {
          daysOverdue: {
            $max: [0, { $divide: [{ $subtract: [asOfDate, '$dueDate'] }, 86400000] }],
          },
          // Credit notes offset the outstanding balance instead of adding to it.
          amountOutstanding: {
            $multiply: [
              { $cond: [{ $eq: ['$type', 'credit_note'] }, -1, 1] },
              { $ifNull: ['$amountDue', '$total'] },
            ],
          },
        },
      },
      {
        $addFields: {
          agingBucket: {
            $switch: {
              branches: [
                { case: { $lte: ['$daysOverdue', 0] }, then: 'Current' },
                { case: { $lte: ['$daysOverdue', 30] }, then: '1-30' },
                { case: { $lte: ['$daysOverdue', 60] }, then: '31-60' },
                { case: { $lte: ['$daysOverdue', 90] }, then: '61-90' },
              ],
              default: '90+',
            },
          },
        },
      },
      {
        $group: {
          _id: {
            contactId: '$contactId',
            agingBucket: '$agingBucket',
          },
          total: { $sum: '$amountOutstanding' },
          count: { $sum: 1 },
        },
      },
      {
        $lookup: {
          from: 'contacts',
          localField: '_id.contactId',
          foreignField: '_id',
          as: 'contact',
        },
      },
      { $unwind: { path: '$contact', preserveNullAndEmptyArrays: true } },
      {
        $project: {
          _id: 0,
          contactId: '$_id.contactId',
          contactName: {
            $ifNull: [
              '$contact.companyName',
              { $concat: [{ $ifNull: ['$contact.firstName', ''] }, ' ', { $ifNull: ['$contact.lastName', ''] }] },
            ],
          },
          agingBucket: '$_id.agingBucket',
          total: { $round: ['$total', 2] },
          count: 1,
        },
      },
      { $sort: { contactName: 1, agingBucket: 1 } },
    ]).exec()

    // Pivot the data: group by contact with bucket columns
    const contactMap = new Map<string, any>()
    for (const row of data) {
      const key = row.contactId?.toString() || 'unknown'
      if (!contactMap.has(key)) {
        contactMap.set(key, {
          contactId: key,
          contactName: row.contactName || 'Unknown',
          current: 0,
          '1-30': 0,
          '31-60': 0,
          '61-90': 0,
          '90+': 0,
          totalOutstanding: 0,
        })
      }
      const entry = contactMap.get(key)!
      const bucket = row.agingBucket === 'Current' ? 'current' : row.agingBucket
      entry[bucket] = row.total
      entry.totalOutstanding += row.total
    }

    return {
      data: Array.from(contactMap.values()).sort((a, b) => b.totalOutstanding - a.totalOutstanding),
      asOfDate: asOfDate.toISOString(),
    }
  }, { isSignIn: true })
