import { Invoice } from 'db/models'
import { NOT_INVOICE_FOR_CASH_SALE } from './sale-counting.js'

/**
 * Invoice KPI summary ($facet): outstanding / overdue / paid-30d / drafts.
 *
 * Extracted from invoice.controller's `/summary` route so it can be reused by the
 * Portal dashboard (one source of truth for the aggregation + the orgId-cast footgun:
 * Mongoose aggregate does NOT auto-cast $match orgId string→ObjectId, unlike find).
 */
export interface InvoiceSummaryFilters {
  type?: string
  types?: string
  direction?: string
  contactId?: string
  tags?: string | string[]
  startDate?: string
  endDate?: string
}

export interface InvoiceSummary {
  outstanding: { amount: number; count: number }
  overdue: { amount: number; count: number }
  paid30d: { amount: number; count: number }
  drafts: { count: number }
}

export async function getInvoiceSummary(
  orgId: string,
  f: InvoiceSummaryFilters = {},
): Promise<InvoiceSummary> {
  const match: Record<string, any> = { orgId: new Invoice.base.Types.ObjectId(orgId) }
  if (f.type) match.type = f.type
  if (f.types) {
    const list = String(f.types).split(',').map(s => s.trim()).filter(Boolean)
    if (list.length === 1) match.type = list[0]
    else if (list.length > 1) match.type = { $in: list }
  }
  if (f.direction) match.direction = f.direction
  if (f.contactId) match.contactId = f.contactId
  if (f.tags) {
    const tagList = Array.isArray(f.tags) ? f.tags : String(f.tags).split(',')
    match.tags = { $in: tagList }
  }
  if (f.startDate || f.endDate) {
    match.issueDate = {}
    if (f.startDate) match.issueDate.$gte = new Date(f.startDate)
    if (f.endDate) match.issueDate.$lte = new Date(f.endDate)
  }

  const since30 = new Date(Date.now() - 30 * 86400000)
  // Outstanding/overdue measure what's still owed; paid measures completed value.
  const dueAmt = { $sum: { $ifNull: ['$amountDue', '$total'] } }
  const [res] = await Invoice.aggregate([
    { $match: match },
    {
      $facet: {
        // 'received' is the incoming-bill equivalent of 'sent'.
        outstanding: [
          { $match: { status: { $in: ['sent', 'received', 'partially_paid', 'overdue'] } } },
          { $group: { _id: null, amount: dueAmt, count: { $sum: 1 } } },
        ],
        overdue: [
          { $match: { status: 'overdue' } },
          { $group: { _id: null, amount: dueAmt, count: { $sum: 1 } } },
        ],
        paid30d: [
          // An invoice for a cash sale (#171) is paid with that cash sale's money: counted once.
          { $match: { status: 'paid', paidAt: { $gte: since30 }, ...NOT_INVOICE_FOR_CASH_SALE } },
          { $group: { _id: null, amount: { $sum: '$total' }, count: { $sum: 1 } } },
        ],
        drafts: [{ $match: { status: 'draft' } }, { $count: 'count' }],
      },
    },
  ]).exec()

  const one = (a: any[]) =>
    a && a[0]
      ? { amount: Math.round((a[0].amount || 0) * 100) / 100, count: a[0].count || 0 }
      : { amount: 0, count: 0 }

  return {
    outstanding: one(res?.outstanding),
    overdue: one(res?.overdue),
    paid30d: one(res?.paid30d),
    drafts: { count: res?.drafts?.[0]?.count ?? 0 },
  }
}
