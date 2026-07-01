import { Elysia } from 'elysia'
import { AuthService } from '../auth/auth.service.js'
import { getProfitLoss } from 'services/biz/accounting.service'
import { getStockValuation } from 'services/biz/warehouse.service'
import { queryAuditLogs } from 'services/biz/audit-log.service'
import { getInvoiceSummary } from 'services/biz/invoice-summary.service'
import { getRepos } from 'services/context'
import { Invoice } from 'db/models'

const AGING_BUCKETS = ['current', '1-30', '31-60', '61-90', '90+'] as const

/**
 * AR-aging buckets for the dashboard chart — one small aggregation grouped by bucket
 * (the /invoicing/reports/aging endpoint groups by contact+bucket and is not reusable
 * for a 5-bar chart). Mongoose aggregate does NOT auto-cast orgId → cast it explicitly.
 */
async function aggregateAging(orgId: string, asOf: Date) {
  const rows = await Invoice.aggregate([
    {
      $match: {
        orgId: new Invoice.base.Types.ObjectId(orgId),
        direction: 'outgoing',
        status: { $in: ['sent', 'partially_paid', 'overdue'] },
      },
    },
    {
      $addFields: {
        daysOverdue: { $max: [0, { $divide: [{ $subtract: [asOf, '$dueDate'] }, 86400000] }] },
        amountOutstanding: { $ifNull: ['$amountDue', '$total'] },
      },
    },
    {
      $addFields: {
        agingBucket: {
          $switch: {
            branches: [
              { case: { $lte: ['$daysOverdue', 0] }, then: 'current' },
              { case: { $lte: ['$daysOverdue', 30] }, then: '1-30' },
              { case: { $lte: ['$daysOverdue', 60] }, then: '31-60' },
              { case: { $lte: ['$daysOverdue', 90] }, then: '61-90' },
            ],
            default: '90+',
          },
        },
      },
    },
    { $group: { _id: '$agingBucket', amount: { $sum: '$amountOutstanding' } } },
  ]).exec()
  const map = new Map<string, number>(
    rows.map((x: any) => [x._id, Math.round((x.amount || 0) * 100) / 100]),
  )
  return AGING_BUCKETS.map(label => ({ label, amount: map.get(label) || 0 }))
}

/**
 * Portal dashboard — one consolidated, read-only endpoint that fans out (Promise.all)
 * to the existing module services so the browser makes a single request. Every source
 * is best-effort (a failing module degrades to zeros, not a 500).
 */
export const dashboardController = new Elysia({ prefix: '/org/:orgId/dashboard' })
  .use(AuthService)
  .get('/summary', async ({ params: { orgId }, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })

    const now = new Date()
    const ytdStart = new Date(now.getFullYear(), 0, 1)
    const r = getRepos()

    const [pl, invSummary, stock, empPage, recent, aging] = await Promise.all([
      getProfitLoss(orgId, ytdStart, now).catch(() => ({ totalRevenue: 0, totalExpenses: 0, netIncome: 0 } as any)),
      getInvoiceSummary(orgId).catch(() => ({
        outstanding: { amount: 0, count: 0 },
        overdue: { amount: 0, count: 0 },
        paid30d: { amount: 0, count: 0 },
        drafts: { count: 0 },
      })),
      getStockValuation(orgId).catch(() => ({ items: [] as any[], totalValue: 0 })),
      r.employees.findAll({ orgId, status: 'active' } as any, { page: 0, size: 1 }).catch(() => ({ total: 0 } as any)),
      queryAuditLogs(orgId, { size: 8 }).catch(() => ({ auditLogs: [] as any[] } as any)),
      aggregateAging(orgId, now).catch(() => AGING_BUCKETS.map(label => ({ label, amount: 0 }))),
    ])

    return {
      revenue: {
        totalRevenue: pl.totalRevenue || 0,
        totalExpenses: pl.totalExpenses || 0,
        netIncome: pl.netIncome || 0,
        periodStart: ytdStart.toISOString(),
        periodEnd: now.toISOString(),
      },
      invoices: invSummary,
      stock: { totalValue: stock.totalValue || 0, itemCount: stock.items?.length || 0 },
      employees: { active: empPage.total || 0 },
      recentActivity: recent.auditLogs || [],
      aging: { asOfDate: now.toISOString(), buckets: aging },
    }
  }, { isSignIn: true })
