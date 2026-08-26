/**
 * FR-06 (#14) P2 — `stock-movements`: the raw movement journal for a period, line by line.
 *
 * The literal register: every StockMovement line, whatever its type, with the document it
 * belongs to. That is what separates it from FR-07's `warehouse-operations`, which answers a
 * commercial question (purchases and sales per article, returns negated, transfers and
 * adjustments deliberately excluded). This one hides nothing — a transfer, an adjustment and
 * a production issue are exactly what you come here to find.
 *
 * Rows are LINES, not documents: a receipt of 40 articles is 40 rows. Grouping by document is
 * available for the eyeball view.
 */

import { StockMovement } from 'db/models'
import {
  rowCapFor,
  type ReportColumn,
  type ReportHandlerContext,
  type ReportResult,
} from '../report-registry.types.js'

export const MOVEMENT_TYPE_OPTIONS = [
  'receipt', 'dispatch', 'transfer', 'adjustment', 'return', 'production_in', 'production_out',
]
export const MOVEMENT_STATUS_OPTIONS = ['draft', 'confirmed', 'completed', 'cancelled']

function oid(v: unknown) {
  return new StockMovement.base.Types.ObjectId(String(v))
}
function dayStart(d: string) { return new Date(`${d}T00:00:00.000`) }
function dayEnd(d: string) { return new Date(`${d}T23:59:59.999`) }

const LINE_COLUMNS: ReportColumn[] = [
  { key: 'date',           labelKey: 'reports.columns.date',      type: 'date' },
  { key: 'movementNumber', labelKey: 'reports.columns.document' },
  { key: 'type',           labelKey: 'reports.columns.operation' },
  { key: 'status',         labelKey: 'common.status' },
  { key: 'sku',            labelKey: 'reports.columns.sku' },
  { key: 'productName',    labelKey: 'reports.columns.product' },
  { key: 'fromWarehouse',  labelKey: 'reports.columns.fromWarehouse' },
  { key: 'toWarehouse',    labelKey: 'reports.columns.toWarehouse' },
  { key: 'contactName',    labelKey: 'reports.columns.contact' },
  { key: 'quantity',       labelKey: 'reports.columns.quantity',  type: 'quantity', align: 'end' },
  { key: 'unitCost',       labelKey: 'reports.columns.avgCost',   type: 'money',    align: 'end' },
  { key: 'totalCost',      labelKey: 'reports.columns.value',     type: 'money',    align: 'end' },
]

const DOC_COLUMNS: ReportColumn[] = [
  { key: 'date',           labelKey: 'reports.columns.date',      type: 'date' },
  { key: 'movementNumber', labelKey: 'reports.columns.document' },
  { key: 'type',           labelKey: 'reports.columns.operation' },
  { key: 'status',         labelKey: 'common.status' },
  { key: 'fromWarehouse',  labelKey: 'reports.columns.fromWarehouse' },
  { key: 'toWarehouse',    labelKey: 'reports.columns.toWarehouse' },
  { key: 'contactName',    labelKey: 'reports.columns.contact' },
  { key: 'lineCount',      labelKey: 'reports.columns.lines',     type: 'int',      align: 'end' },
  { key: 'quantity',       labelKey: 'reports.columns.quantity',  type: 'quantity', align: 'end' },
  { key: 'totalCost',      labelKey: 'reports.columns.value',     type: 'money',    align: 'end' },
]

export async function runStockMovements(ctx: ReportHandlerContext): Promise<ReportResult> {
  const cap = rowCapFor(ctx.output)
  const byDocument = ctx.params.groupBy === 'document'
  const period = (ctx.params.period || {}) as { from?: string; to?: string }

  const match: Record<string, any> = { orgId: oid(ctx.orgId) }
  if (period.from || period.to) {
    match.date = {
      ...(period.from ? { $gte: dayStart(period.from) } : {}),
      ...(period.to ? { $lte: dayEnd(period.to) } : {}),
    }
  }

  const types = (ctx.params.types as string[] | undefined)?.filter(t => MOVEMENT_TYPE_OPTIONS.includes(t))
  if (types?.length) match.type = { $in: types }

  const statuses = (ctx.params.statuses as string[] | undefined)?.filter(s => MOVEMENT_STATUS_OPTIONS.includes(s))
  // Default: everything that actually moved stock. A draft moved nothing.
  match.status = statuses?.length ? { $in: statuses } : { $in: ['confirmed', 'completed'] }

  if (ctx.params.warehouseId) {
    const wh = oid(ctx.params.warehouseId)
    match.$or = [{ fromWarehouseId: wh }, { toWarehouseId: wh }]
  }
  if (ctx.params.contactId) match.contactId = oid(ctx.params.contactId)

  const pipeline: any[] = [{ $match: match }]

  // Product filter has to bite on the LINE, so it runs both before the unwind (to skip whole
  // documents cheaply) and after it (to keep only that product's lines).
  if (ctx.params.productId) {
    pipeline.push({ $match: { 'lines.productId': oid(ctx.params.productId) } })
  }

  pipeline.push({ $unwind: '$lines' })

  if (ctx.params.productId) {
    pipeline.push({ $match: { 'lines.productId': oid(ctx.params.productId) } })
  }

  pipeline.push(
    {
      $lookup: {
        from: 'products',
        localField: 'lines.productId',
        foreignField: '_id',
        as: 'product',
        pipeline: [{ $project: { name: 1, sku: 1 } }],
      },
    },
    { $unwind: { path: '$product', preserveNullAndEmptyArrays: true } },
    {
      $lookup: {
        from: 'warehouses',
        localField: 'fromWarehouseId',
        foreignField: '_id',
        as: 'fromWh',
        pipeline: [{ $project: { name: 1 } }],
      },
    },
    { $unwind: { path: '$fromWh', preserveNullAndEmptyArrays: true } },
    {
      $lookup: {
        from: 'warehouses',
        localField: 'toWarehouseId',
        foreignField: '_id',
        as: 'toWh',
        pipeline: [{ $project: { name: 1 } }],
      },
    },
    { $unwind: { path: '$toWh', preserveNullAndEmptyArrays: true } },
    {
      $lookup: {
        from: 'contacts',
        localField: 'contactId',
        foreignField: '_id',
        as: 'contact',
        pipeline: [{ $project: { companyName: 1, firstName: 1, lastName: 1 } }],
      },
    },
    { $unwind: { path: '$contact', preserveNullAndEmptyArrays: true } },
  )

  const contactNameExpr = {
    $ifNull: [
      '$contact.companyName',
      {
        $trim: {
          input: {
            $concat: [{ $ifNull: ['$contact.firstName', ''] }, ' ', { $ifNull: ['$contact.lastName', ''] }],
          },
        },
      },
    ],
  }

  if (byDocument) {
    pipeline.push(
      {
        $group: {
          _id: '$_id',
          date: { $first: '$date' },
          movementNumber: { $first: '$movementNumber' },
          type: { $first: '$type' },
          status: { $first: '$status' },
          fromWarehouse: { $first: { $ifNull: ['$fromWh.name', ''] } },
          toWarehouse: { $first: { $ifNull: ['$toWh.name', ''] } },
          contactName: { $first: contactNameExpr },
          lineCount: { $sum: 1 },
          quantity: { $sum: '$lines.quantity' },
          totalCost: { $sum: { $ifNull: ['$lines.totalCost', 0] } },
        },
      },
      { $sort: { date: -1, movementNumber: -1 } },
      { $limit: cap + 1 },
      {
        $project: {
          _id: 0,
          movementId: { $toString: '$_id' },
          date: { $dateToString: { format: '%Y-%m-%d', date: '$date' } },
          movementNumber: 1, type: 1, status: 1,
          fromWarehouse: 1, toWarehouse: 1, contactName: 1,
          lineCount: 1,
          quantity: { $round: ['$quantity', 3] },
          totalCost: { $round: ['$totalCost', 2] },
        },
      },
    )
  } else {
    pipeline.push(
      { $sort: { date: -1, movementNumber: -1 } },
      { $limit: cap + 1 },
      {
        $project: {
          _id: 0,
          movementId: { $toString: '$_id' },
          productId: { $toString: '$lines.productId' },
          date: { $dateToString: { format: '%Y-%m-%d', date: '$date' } },
          movementNumber: 1, type: 1, status: 1,
          sku: { $ifNull: ['$product.sku', ''] },
          productName: { $ifNull: ['$product.name', ''] },
          fromWarehouse: { $ifNull: ['$fromWh.name', ''] },
          toWarehouse: { $ifNull: ['$toWh.name', ''] },
          contactName: contactNameExpr,
          quantity: { $round: ['$lines.quantity', 3] },
          unitCost: { $round: [{ $ifNull: ['$lines.unitCost', 0] }, 4] },
          totalCost: { $round: [{ $ifNull: ['$lines.totalCost', 0] }, 2] },
        },
      },
    )
  }

  const raw = await StockMovement.aggregate(pipeline).exec()
  const truncated = raw.length > cap
  const rows = truncated ? raw.slice(0, cap) : raw

  return {
    columns: byDocument ? DOC_COLUMNS : LINE_COLUMNS,
    rows,
    totals: {
      quantity: +rows.reduce((s, r) => s + (r.quantity || 0), 0).toFixed(3),
      totalCost: +rows.reduce((s, r) => s + (r.totalCost || 0), 0).toFixed(2),
      ...(byDocument ? { lineCount: rows.reduce((s, r) => s + (r.lineCount || 0), 0) } : {}),
    },
    meta: { truncated, cap, rowCount: rows.length, groupBy: byDocument ? 'document' : 'line' },
  }
}
