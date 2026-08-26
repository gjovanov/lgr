/**
 * FR-06 (#14) P2 — `stock-levels`: what is on hand right now, per product and warehouse,
 * with the below-minimum filter that turns it into a reorder list.
 *
 * Distinct from `inventory-valuation`, which rolls warehouses up and answers "what is it
 * worth". This one keeps the per-warehouse row, because "where is it" is the question, and
 * carries reserved/available (the reservation holds from the ORDO/ORDI/RES machinery).
 *
 * ⚠ `minStockLevel` lives on the PRODUCT, not the stock level — it is a per-article
 * threshold, so the below-min comparison happens after the `$lookup`, against the summed
 * quantity when rolling up and against the row when not.
 */

import { StockLevel } from 'db/models'
import {
  rowCapFor,
  type ReportColumn,
  type ReportHandlerContext,
  type ReportResult,
} from '../report-registry.types.js'

function oid(v: unknown) {
  return new StockLevel.base.Types.ObjectId(String(v))
}

/** Category filter includes descendants — same rule as the warehouse-operations report. */
async function categoryWithDescendants(orgId: string, categoryId: string): Promise<any[]> {
  const { ProductCategory } = await import('db/models')
  const ids = [oid(categoryId)]
  let frontier = [oid(categoryId)]
  for (let depth = 0; depth < 10 && frontier.length; depth++) {
    const children: any[] = await ProductCategory.find(
      { orgId: oid(orgId), parentId: { $in: frontier } },
      { _id: 1 },
    ).lean().exec()
    frontier = children.map(c => c._id)
    ids.push(...frontier)
  }
  return ids
}

const COLUMNS: ReportColumn[] = [
  { key: 'sku',           labelKey: 'reports.columns.sku' },
  { key: 'name',          labelKey: 'reports.columns.product' },
  { key: 'category',      labelKey: 'reports.columns.category' },
  { key: 'warehouseName', labelKey: 'reports.columns.warehouse' },
  { key: 'unit',          labelKey: 'reports.columns.unit' },
  { key: 'quantity',      labelKey: 'reports.columns.quantity',  type: 'quantity', align: 'end' },
  { key: 'reserved',      labelKey: 'reports.columns.reserved',  type: 'quantity', align: 'end' },
  { key: 'available',     labelKey: 'reports.columns.available', type: 'quantity', align: 'end' },
  { key: 'minStockLevel', labelKey: 'reports.columns.minStock',  type: 'quantity', align: 'end' },
  { key: 'shortfall',     labelKey: 'reports.columns.shortfall', type: 'quantity', align: 'end' },
  { key: 'avgCost',       labelKey: 'reports.columns.avgCost',   type: 'money',    align: 'end' },
  { key: 'totalValue',    labelKey: 'reports.columns.totalValue', type: 'money',   align: 'end' },
]

export async function runStockLevels(ctx: ReportHandlerContext): Promise<ReportResult> {
  const cap = rowCapFor(ctx.output)
  const rollUp = ctx.params.groupBy === 'product'
  const belowMin = ctx.params.belowMin === true
  const includeZero = ctx.params.includeZero === true

  const match: Record<string, any> = { orgId: oid(ctx.orgId) }
  if (ctx.params.warehouseId) match.warehouseId = oid(ctx.params.warehouseId)

  const pipeline: any[] = [{ $match: match }]

  if (rollUp) {
    pipeline.push({
      $group: {
        _id: '$productId',
        quantity: { $sum: '$quantity' },
        reserved: { $sum: '$reservedQuantity' },
        available: { $sum: '$availableQuantity' },
        totalValue: { $sum: { $multiply: ['$quantity', '$avgCost'] } },
        warehouseCount: { $sum: 1 },
      },
    })
  } else {
    pipeline.push({
      $project: {
        _id: 0,
        productId: '$productId',
        warehouseId: 1,
        quantity: 1,
        reserved: '$reservedQuantity',
        available: '$availableQuantity',
        avgCostRow: '$avgCost',
        totalValue: { $multiply: ['$quantity', '$avgCost'] },
      },
    })
  }

  if (!includeZero) pipeline.push({ $match: { quantity: { $ne: 0 } } })

  pipeline.push(
    {
      $lookup: {
        from: 'products',
        localField: rollUp ? '_id' : 'productId',
        foreignField: '_id',
        as: 'product',
        pipeline: [{ $project: { name: 1, sku: 1, unit: 1, category: 1, categoryId: 1, minStockLevel: 1 } }],
      },
    },
    { $unwind: { path: '$product', preserveNullAndEmptyArrays: true } },
  )

  if (ctx.params.productId) {
    pipeline.push({ $match: { 'product._id': oid(ctx.params.productId) } })
  }
  if (ctx.params.categoryId) {
    const ids = await categoryWithDescendants(ctx.orgId, String(ctx.params.categoryId))
    pipeline.push({ $match: { 'product.categoryId': { $in: ids } } })
  }

  if (!rollUp) {
    pipeline.push(
      {
        $lookup: {
          from: 'warehouses',
          localField: 'warehouseId',
          foreignField: '_id',
          as: 'warehouse',
          pipeline: [{ $project: { name: 1 } }],
        },
      },
      { $unwind: { path: '$warehouse', preserveNullAndEmptyArrays: true } },
    )
  }

  // The reorder filter (FR: "below-min filter"). `minStockLevel` unset means "no threshold",
  // which is NOT the same as a threshold of zero — an unset product is never short.
  if (belowMin) {
    pipeline.push({
      $match: {
        'product.minStockLevel': { $gt: 0 },
        $expr: { $lt: ['$quantity', '$product.minStockLevel'] },
      },
    })
  }

  pipeline.push(
    { $sort: belowMin ? { quantity: 1 } : { totalValue: -1 } },
    { $limit: cap + 1 },
    {
      $project: {
        _id: 0,
        productId: { $toString: '$product._id' },
        sku: { $ifNull: ['$product.sku', ''] },
        name: { $ifNull: ['$product.name', ''] },
        category: { $ifNull: ['$product.category', ''] },
        unit: { $ifNull: ['$product.unit', ''] },
        // Rolled up across warehouses, the column has no single answer — blank beats a
        // made-up one, and the row count next to it is the honest signal.
        warehouseName: rollUp ? '' : { $ifNull: ['$warehouse.name', ''] },
        warehouseCount: { $ifNull: ['$warehouseCount', 1] },
        quantity: { $round: ['$quantity', 3] },
        reserved: { $round: [{ $ifNull: ['$reserved', 0] }, 3] },
        available: { $round: [{ $ifNull: ['$available', 0] }, 3] },
        minStockLevel: { $ifNull: ['$product.minStockLevel', 0] },
        shortfall: {
          $cond: [
            { $gt: [{ $ifNull: ['$product.minStockLevel', 0] }, 0] },
            { $round: [{ $max: [0, { $subtract: ['$product.minStockLevel', '$quantity'] }] }, 3] },
            0,
          ],
        },
        avgCost: {
          $cond: [
            { $eq: ['$quantity', 0] },
            { $ifNull: ['$avgCostRow', 0] },
            { $round: [{ $divide: ['$totalValue', '$quantity'] }, 4] },
          ],
        },
        totalValue: { $round: ['$totalValue', 2] },
      },
    },
  )

  const raw = await StockLevel.aggregate(pipeline).exec()
  const truncated = raw.length > cap
  const rows = truncated ? raw.slice(0, cap) : raw

  return {
    columns: COLUMNS,
    rows,
    totals: {
      quantity: +rows.reduce((s, r) => s + (r.quantity || 0), 0).toFixed(3),
      reserved: +rows.reduce((s, r) => s + (r.reserved || 0), 0).toFixed(3),
      available: +rows.reduce((s, r) => s + (r.available || 0), 0).toFixed(3),
      shortfall: +rows.reduce((s, r) => s + (r.shortfall || 0), 0).toFixed(3),
      totalValue: +rows.reduce((s, r) => s + (r.totalValue || 0), 0).toFixed(2),
    },
    meta: { truncated, cap, rowCount: rows.length, belowMin, groupedByProduct: rollUp },
  }
}
