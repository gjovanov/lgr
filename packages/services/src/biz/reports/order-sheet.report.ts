/**
 * FR-06 (#14) P2 — `order-sheet`: what is on order with suppliers, and how much of it has
 * actually arrived.
 *
 * ⚠ NOT the same thing as `GET /invoicing/orders/:id/export`, which prints ONE supplier group
 * of ONE order as a sheet to send to that supplier. That endpoint is a document and stays
 * exactly as it is (FR-6.20). This is the report of the same subject matter: every ORDO line
 * in a period, across orders and suppliers, with ordered / received / outstanding — the view
 * you need to answer "what are we still waiting for", which no single order sheet can answer.
 *
 * Rows are LINES of supplier groups. `receivedQuantity` is maintained by the receipt sync
 * (`recomputeOrderReceipts`), so outstanding = ordered − received needs no re-derivation here.
 */

import { Order } from 'db/models'
import {
  rowCapFor,
  type ReportColumn,
  type ReportHandlerContext,
  type ReportResult,
} from '../report-registry.types.js'

export const ORDER_STATUS_OPTIONS = [
  'draft', 'sent', 'partially_received', 'received', 'completed', 'cancelled',
]

function oid(v: unknown) {
  return new Order.base.Types.ObjectId(String(v))
}
function dayStart(d: string) { return new Date(`${d}T00:00:00.000`) }
function dayEnd(d: string) { return new Date(`${d}T23:59:59.999`) }

const COLUMNS: ReportColumn[] = [
  { key: 'date',         labelKey: 'reports.columns.date',        type: 'date' },
  { key: 'orderNumber',  labelKey: 'reports.columns.document' },
  { key: 'status',       labelKey: 'common.status' },
  { key: 'supplierName', labelKey: 'reports.columns.supplier' },
  { key: 'sku',          labelKey: 'reports.columns.sku' },
  { key: 'description',  labelKey: 'reports.columns.product' },
  { key: 'unit',         labelKey: 'reports.columns.unit' },
  { key: 'ordered',      labelKey: 'reports.columns.ordered',     type: 'quantity', align: 'end' },
  { key: 'received',     labelKey: 'reports.columns.received',    type: 'quantity', align: 'end' },
  { key: 'outstanding',  labelKey: 'reports.columns.outstanding', type: 'quantity', align: 'end' },
  { key: 'unitPrice',    labelKey: 'reports.columns.price',       type: 'money',    align: 'end' },
  { key: 'value',        labelKey: 'reports.columns.value',       type: 'money',    align: 'end' },
]

export async function runOrderSheet(ctx: ReportHandlerContext): Promise<ReportResult> {
  const cap = rowCapFor(ctx.output)
  const period = (ctx.params.period || {}) as { from?: string; to?: string }
  const onlyOutstanding = ctx.params.onlyOutstanding === true

  const match: Record<string, any> = { orgId: oid(ctx.orgId) }
  if (period.from || period.to) {
    match.issueDate = {
      ...(period.from ? { $gte: dayStart(period.from) } : {}),
      ...(period.to ? { $lte: dayEnd(period.to) } : {}),
    }
  }

  const statuses = (ctx.params.statuses as string[] | undefined)?.filter(s => ORDER_STATUS_OPTIONS.includes(s))
  // Cancelled orders are noise in a "what is coming" report unless explicitly asked for.
  match.status = statuses?.length
    ? { $in: statuses }
    : { $in: ['draft', 'sent', 'partially_received', 'received', 'completed'] }

  const pipeline: any[] = [
    { $match: match },
    { $unwind: '$supplierGroups' },
  ]

  if (ctx.params.contactId) {
    pipeline.push({ $match: { 'supplierGroups.supplierId': oid(ctx.params.contactId) } })
  }

  pipeline.push({ $unwind: '$supplierGroups.lines' })

  if (ctx.params.productId) {
    pipeline.push({ $match: { 'supplierGroups.lines.productId': oid(ctx.params.productId) } })
  }

  pipeline.push(
    {
      $addFields: {
        line: '$supplierGroups.lines',
        outstanding: {
          $max: [
            0,
            {
              $subtract: [
                '$supplierGroups.lines.quantity',
                { $ifNull: ['$supplierGroups.lines.receivedQuantity', 0] },
              ],
            },
          ],
        },
      },
    },
  )

  if (onlyOutstanding) pipeline.push({ $match: { outstanding: { $gt: 0 } } })

  pipeline.push(
    {
      $lookup: {
        from: 'contacts',
        localField: 'supplierGroups.supplierId',
        foreignField: '_id',
        as: 'supplier',
        pipeline: [{ $project: { companyName: 1, firstName: 1, lastName: 1 } }],
      },
    },
    { $unwind: { path: '$supplier', preserveNullAndEmptyArrays: true } },
    { $sort: { issueDate: -1, orderNumber: -1 } },
    { $limit: cap + 1 },
    {
      $project: {
        _id: 0,
        orderId: { $toString: '$_id' },
        productId: { $toString: '$line.productId' },
        date: { $dateToString: { format: '%Y-%m-%d', date: '$issueDate' } },
        orderNumber: 1,
        status: 1,
        currency: 1,
        supplierName: {
          $ifNull: [
            '$supplier.companyName',
            {
              $trim: {
                input: {
                  $concat: [{ $ifNull: ['$supplier.firstName', ''] }, ' ', { $ifNull: ['$supplier.lastName', ''] }],
                },
              },
            },
          ],
        },
        sku: { $ifNull: ['$line.sku', ''] },
        description: { $ifNull: ['$line.description', ''] },
        unit: { $ifNull: ['$line.unit', ''] },
        ordered: { $round: ['$line.quantity', 3] },
        received: { $round: [{ $ifNull: ['$line.receivedQuantity', 0] }, 3] },
        outstanding: { $round: ['$outstanding', 3] },
        unitPrice: { $round: [{ $ifNull: ['$line.expectedUnitPrice', 0] }, 4] },
        value: {
          $round: [{ $multiply: ['$line.quantity', { $ifNull: ['$line.expectedUnitPrice', 0] }] }, 2],
        },
      },
    },
  )

  const raw = await Order.aggregate(pipeline).exec()
  const truncated = raw.length > cap
  const rows = truncated ? raw.slice(0, cap) : raw

  const currencies = [...new Set(rows.map(r => r.currency).filter(Boolean))]

  return {
    columns: COLUMNS,
    rows,
    totals: {
      ordered: +rows.reduce((s, r) => s + (r.ordered || 0), 0).toFixed(3),
      received: +rows.reduce((s, r) => s + (r.received || 0), 0).toFixed(3),
      outstanding: +rows.reduce((s, r) => s + (r.outstanding || 0), 0).toFixed(3),
      value: +rows.reduce((s, r) => s + (r.value || 0), 0).toFixed(2),
    },
    meta: {
      truncated,
      cap,
      rowCount: rows.length,
      onlyOutstanding,
      currency: currencies.length === 1 ? currencies[0] : undefined,
      mixedCurrency: currencies.length > 1,
    },
  }
}
