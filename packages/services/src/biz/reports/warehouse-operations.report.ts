/**
 * FR-07 (#16) — „Складови операции" / Warehouse Operations.
 *
 * Purchases and sales of goods over a period, aggregated per article (quantity, price,
 * value, average price), or drilled down per document.
 *
 * ── Why StockMovements and not Invoices ──────────────────────────────────────
 * At regal most purchases exist ONLY as imported receipt movements with no bill attached
 * (the stokrazp import path), so a document-driven report would miss them. Movements are
 * the ground truth for "what physically entered or left the warehouse".
 *
 * ── The two traps this handler is written around ─────────────────────────────
 * 1. **Dates lie on invoice-born movements.** `createInvoiceStockMovement` stamps
 *    `date: new Date()` — booking time, not the invoice's `issueDate`. An invoice issued
 *    30.06 and booked 01.07 belongs to June. So the effective date is the linked invoice's
 *    `issueDate` when there is one, and the movement's own `date` otherwise — and the
 *    period filter must run AFTER the lookup, not before it.
 *    ⚠ Except a receipt a bill was MADE FROM (FR-22.31, `stockSource.detectedBy: 'manual'`):
 *    it was booked by hand on the day the goods came, days before the supplier's invoice, and
 *    the bill only names it afterwards. Its own date is the business date; taking the bill's
 *    would move a past day's delivery to the day the invoice arrived (and the digest, which
 *    keeps this rule, would count it on both days).
 * 2. **`lines[].unitCost` is the SALE price on dispatches.** The same function assigns
 *    `unitCost = line.unitPrice`. It is the document price on both sides, which is exactly
 *    what the report's Цена/Стойност columns want — but it means `unitCost` must NEVER be
 *    used as the cost basis for profit. Cost comes from `costAllocations[]` /
 *    `resolvedUnitCost` instead (FR-7.6).
 */

import { StockMovement, ProductCategory } from 'db/models'
import {
  rowCapFor,
  type ReportHandlerContext,
  type ReportResult,
  type ReportColumn,
} from '../report-registry.types.js'

/** Movement statuses that count as real stock activity. Drafts never do. */
const LIVE_STATUSES = ['confirmed', 'completed']

/**
 * A movement's business date, after the `$lookup` of its invoice into `invoice` (trap 1): the
 * invoice's `issueDate` for a movement the invoice booked, the movement's own `date` otherwise —
 * including a receipt a bill was made from, which the bill only names (FR-22.31). Shared with the
 * digest (`daily-digest.service.ts`), whose numbers reconcile with this report's.
 */
export const EFFECTIVE_DATE = {
  $cond: [
    { $eq: ['$invoice.stockSource.detectedBy', 'manual'] },
    '$date',
    { $ifNull: ['$invoice.issueDate', '$date'] },
  ],
}

/**
 * Operation families (FR-7.3). `transfer`, `adjustment` and `production_*` are excluded on
 * purpose: they move stock but are neither a purchase nor a sale.
 *
 * A `return` is the negative of its family, and which family it belongs to is decided by
 * WHICH SIDE the warehouse sits on: goods going back out to a supplier (`fromWarehouseId`)
 * negate a purchase; goods coming back in from a customer (`toWarehouseId`) negate a sale.
 */
const OPERATIONS = {
  purchases: { mainType: 'receipt', sideField: 'toWarehouseId', returnSide: 'fromWarehouseId' },
  sales: { mainType: 'dispatch', sideField: 'fromWarehouseId', returnSide: 'toWarehouseId' },
} as const

export type OperationKey = keyof typeof OPERATIONS

/** Pseudo doc-types for movements with no invoice — the regal majority on the buy side. */
export const NO_INVOICE_DOC_TYPES = { purchases: 'receipt_note', sales: 'dispatch_note' } as const

function oid(v: unknown) {
  return new StockMovement.base.Types.ObjectId(String(v))
}

/** Local calendar day → the instant boundaries the movement/invoice dates are compared to. */
function dayStart(d: string) { return new Date(`${d}T00:00:00.000`) }
function dayEnd(d: string) { return new Date(`${d}T23:59:59.999`) }

/**
 * A category filter includes its descendants (FR-7.2): picking „Крепежни елементи" must not
 * exclude products filed under a child category.
 */
async function categoryWithDescendants(orgId: string, categoryId: string): Promise<any[]> {
  const ids = [oid(categoryId)]
  let frontier = [oid(categoryId)]
  // Depth-guarded: the fastener tree is 2 levels, but a cycle would otherwise hang the report.
  for (let depth = 0; depth < 6 && frontier.length; depth++) {
    const children = await ProductCategory.find(
      { orgId: oid(orgId), parentId: { $in: frontier } },
      { _id: 1 },
    ).lean()
    frontier = children.map((c: any) => c._id)
    ids.push(...frontier)
  }
  return ids
}

const PRODUCT_COLUMNS: ReportColumn[] = [
  { key: 'sku', labelKey: 'reports.columns.sku' },
  { key: 'name', labelKey: 'reports.columns.product' },
  { key: 'unit', labelKey: 'reports.columns.unit' },
  { key: 'category', labelKey: 'reports.columns.category' },
  { key: 'quantity', labelKey: 'reports.columns.quantity', type: 'quantity', align: 'end' },
  { key: 'avgPrice', labelKey: 'reports.columns.avgPrice', type: 'money', align: 'end' },
  { key: 'value', labelKey: 'reports.columns.value', type: 'money', align: 'end' },
  { key: 'cost', labelKey: 'reports.columns.cost', type: 'money', align: 'end' },
  { key: 'profit', labelKey: 'reports.columns.profit', type: 'money', align: 'end' },
]

const DOCUMENT_COLUMNS: ReportColumn[] = [
  { key: 'date', labelKey: 'reports.columns.date', type: 'date' },
  { key: 'documentNumber', labelKey: 'reports.columns.document' },
  { key: 'docType', labelKey: 'reports.columns.docType' },
  { key: 'contactName', labelKey: 'reports.columns.contact' },
  { key: 'warehouseName', labelKey: 'reports.columns.warehouse' },
  { key: 'sku', labelKey: 'reports.columns.sku' },
  { key: 'name', labelKey: 'reports.columns.product' },
  { key: 'unit', labelKey: 'reports.columns.unit' },
  { key: 'quantity', labelKey: 'reports.columns.quantity', type: 'quantity', align: 'end' },
  { key: 'price', labelKey: 'reports.columns.price', type: 'money', align: 'end' },
  { key: 'value', labelKey: 'reports.columns.value', type: 'money', align: 'end' },
]

export async function runWarehouseOperations(ctx: ReportHandlerContext): Promise<ReportResult> {
  const cap = rowCapFor(ctx.output)
  const operation: OperationKey = ctx.params.operation === 'purchases' ? 'purchases' : 'sales'
  const op = OPERATIONS[operation]
  const groupByDocument = ctx.params.groupBy === 'document'
  const withBatches = ctx.params.withBatches === true

  const period = (ctx.params.period || {}) as { from?: string; to?: string }
  const orgObjectId = oid(ctx.orgId)

  // ── Stage 1: what could possibly qualify ──────────────────────────────────
  // A `return` belongs to this operation only when its own side carries a warehouse.
  const typeClause: any[] = [
    { type: op.mainType },
    { type: 'return', [op.returnSide]: { $exists: true, $ne: null } },
  ]

  const match: Record<string, any> = {
    orgId: orgObjectId,
    status: { $in: LIVE_STATUSES },
    $or: typeClause,
    // A record-only movement repeats goods another movement moved (FR-21.4).
    recordOnly: { $ne: true },
  }

  if (ctx.params.warehouseId) {
    // The warehouse must be on the operation's own side; a return uses the opposite one.
    const wh = oid(ctx.params.warehouseId)
    match.$and = [{ $or: [{ [op.sideField]: wh }, { [op.returnSide]: wh }] }]
  }

  /**
   * A movement's own `date` is only an approximation of the effective date (trap 1), so the
   * cheap pre-filter widens the window rather than applying the user's bounds directly.
   * The exact filter runs after the invoice lookup. 45 days covers any plausible drift
   * between issuing a document and booking its movement.
   */
  const SLACK_DAYS = 45
  if (period.from || period.to) {
    const dateClause: Record<string, Date> = {}
    if (period.from) dateClause.$gte = new Date(dayStart(period.from).getTime() - SLACK_DAYS * 86400000)
    if (period.to) dateClause.$lte = new Date(dayEnd(period.to).getTime() + SLACK_DAYS * 86400000)
    match.date = dateClause
  }

  const productMatch: Record<string, any> = {}
  if (ctx.params.productId) productMatch['lines.productId'] = oid(ctx.params.productId)

  let categoryIds: any[] | null = null
  if (ctx.params.categoryId) categoryIds = await categoryWithDescendants(ctx.orgId, ctx.params.categoryId)

  const docTypes: string[] | undefined = Array.isArray(ctx.params.docTypes) && ctx.params.docTypes.length
    ? ctx.params.docTypes
    : undefined

  const pipeline: any[] = [
    { $match: match },
    // Document enrichment first — the effective date depends on it.
    {
      $lookup: {
        from: 'invoices',
        localField: 'invoiceId',
        foreignField: '_id',
        as: 'invoice',
        pipeline: [{ $project: { invoiceNumber: 1, type: 1, direction: 1, issueDate: 1, contactId: 1, currency: 1, 'stockSource.detectedBy': 1 } }],
      },
    },
    { $unwind: { path: '$invoice', preserveNullAndEmptyArrays: true } },
    {
      $addFields: {
        effectiveDate: EFFECTIVE_DATE,
        docType: { $ifNull: ['$invoice.type', NO_INVOICE_DOC_TYPES[operation]] },
        documentNumber: { $ifNull: ['$invoice.invoiceNumber', '$movementNumber'] },
        effectiveContactId: { $ifNull: ['$contactId', '$invoice.contactId'] },
        currency: { $ifNull: ['$invoice.currency', null] },
        // Returns negate their family.
        sign: { $cond: [{ $eq: ['$type', 'return'] }, -1, 1] },
      },
    },
  ]

  // ── Stage 2: the real period filter, on the effective date ────────────────
  const effective: Record<string, Date> = {}
  if (period.from) effective.$gte = dayStart(period.from)
  if (period.to) effective.$lte = dayEnd(period.to)
  if (Object.keys(effective).length) pipeline.push({ $match: { effectiveDate: effective } })

  if (docTypes) pipeline.push({ $match: { docType: { $in: docTypes } } })
  if (ctx.params.contactId) pipeline.push({ $match: { effectiveContactId: oid(ctx.params.contactId) } })

  pipeline.push({ $unwind: '$lines' })
  if (Object.keys(productMatch).length) pipeline.push({ $match: productMatch })

  // Product enrichment — needed for name/sku/unit and for the category filter.
  pipeline.push(
    {
      $lookup: {
        from: 'products',
        localField: 'lines.productId',
        foreignField: '_id',
        as: 'product',
        pipeline: [{ $project: { name: 1, sku: 1, unit: 1, category: 1, categoryId: 1, avgCost: 1 } }],
      },
    },
    { $unwind: { path: '$product', preserveNullAndEmptyArrays: true } },
  )
  if (categoryIds) pipeline.push({ $match: { 'product.categoryId': { $in: categoryIds } } })

  /**
   * Cost basis (FR-7.6). NEVER `lines.unitCost` — on invoice-born movements that is the
   * sale price (trap 2). Preference: actual layer allocations → the resolved WAC/FIFO cost
   * → the product's current average cost (an approximation, flagged in meta).
   */
  pipeline.push({
    $addFields: {
      signedQty: { $multiply: ['$lines.quantity', '$sign'] },
      signedValue: { $multiply: [{ $ifNull: ['$lines.totalCost', 0] }, '$sign'] },
      allocCost: { $sum: { $ifNull: ['$lines.costAllocations.totalCost', []] } },
    },
  })
  pipeline.push({
    $addFields: {
      costBasis: {
        $switch: {
          branches: [
            { case: { $gt: ['$allocCost', 0] }, then: '$allocCost' },
            {
              case: { $gt: [{ $ifNull: ['$lines.resolvedUnitCost', 0] }, 0] },
              then: { $multiply: ['$lines.resolvedUnitCost', '$lines.quantity'] },
            },
          ],
          default: { $multiply: [{ $ifNull: ['$product.avgCost', 0] }, '$lines.quantity'] },
        },
      },
    },
  })
  pipeline.push({ $addFields: { signedCost: { $multiply: ['$costBasis', '$sign'] } } })

  if (groupByDocument) {
    pipeline.push(
      {
        $lookup: {
          from: 'contacts',
          localField: 'effectiveContactId',
          foreignField: '_id',
          as: 'contact',
          pipeline: [{ $project: { companyName: 1, firstName: 1, lastName: 1 } }],
        },
      },
      { $unwind: { path: '$contact', preserveNullAndEmptyArrays: true } },
      {
        $lookup: {
          from: 'warehouses',
          localField: op.sideField,
          foreignField: '_id',
          as: 'warehouse',
          pipeline: [{ $project: { name: 1 } }],
        },
      },
      { $unwind: { path: '$warehouse', preserveNullAndEmptyArrays: true } },
      { $sort: { effectiveDate: -1, documentNumber: 1 } },
      { $limit: cap + 1 },
      {
        $project: {
          _id: 0,
          movementId: { $toString: '$_id' },
          productId: { $toString: '$lines.productId' },
          invoiceId: { $cond: [{ $ifNull: ['$invoice._id', false] }, { $toString: '$invoice._id' }, null] },
          date: '$effectiveDate',
          documentNumber: 1,
          docType: 1,
          contactName: {
            $ifNull: [
              '$contact.companyName',
              { $trim: { input: { $concat: [{ $ifNull: ['$contact.firstName', ''] }, ' ', { $ifNull: ['$contact.lastName', ''] }] } } },
            ],
          },
          warehouseName: { $ifNull: ['$warehouse.name', ''] },
          sku: { $ifNull: ['$product.sku', ''] },
          name: { $ifNull: ['$product.name', ''] },
          unit: { $ifNull: ['$product.unit', ''] },
          batchNumber: { $ifNull: ['$lines.batchNumber', ''] },
          quantity: { $round: ['$signedQty', 3] },
          price: { $round: [{ $ifNull: ['$lines.unitCost', 0] }, 4] },
          value: { $round: ['$signedValue', 2] },
          currency: 1,
        },
      },
    )
  } else {
    pipeline.push(
      {
        $group: {
          _id: withBatches ? { p: '$lines.productId', b: '$lines.batchNumber' } : '$lines.productId',
          productId: { $first: '$lines.productId' },
          sku: { $first: '$product.sku' },
          name: { $first: '$product.name' },
          unit: { $first: '$product.unit' },
          category: { $first: '$product.category' },
          batchNumber: { $first: '$lines.batchNumber' },
          quantity: { $sum: '$signedQty' },
          value: { $sum: '$signedValue' },
          cost: { $sum: '$signedCost' },
          currencies: { $addToSet: '$currency' },
        },
      },
      { $sort: { name: 1 } },
      { $limit: cap + 1 },
      {
        $project: {
          _id: 0,
          productId: { $toString: '$productId' },
          sku: { $ifNull: ['$sku', ''] },
          name: { $ifNull: ['$name', ''] },
          unit: { $ifNull: ['$unit', ''] },
          category: { $ifNull: ['$category', ''] },
          batchNumber: { $ifNull: ['$batchNumber', ''] },
          quantity: { $round: ['$quantity', 3] },
          value: { $round: ['$value', 2] },
          cost: { $round: ['$cost', 2] },
          // Weighted average, not the mean of the line prices.
          avgPrice: {
            $cond: [
              { $eq: ['$quantity', 0] },
              0,
              { $round: [{ $divide: ['$value', '$quantity'] }, 4] },
            ],
          },
          profit: { $round: [{ $subtract: ['$value', '$cost'] }, 2] },
          currencies: 1,
        },
      },
    )
  }

  const raw = await StockMovement.aggregate(pipeline).exec()
  const truncated = raw.length > cap
  const rows = truncated ? raw.slice(0, cap) : raw

  const columns = groupByDocument
    ? DOCUMENT_COLUMNS
    : withBatches
      ? [...PRODUCT_COLUMNS.slice(0, 4), { key: 'batchNumber', labelKey: 'reports.columns.batch' } as ReportColumn, ...PRODUCT_COLUMNS.slice(4)]
      : PRODUCT_COLUMNS

  const totals: Record<string, number> = {
    quantity: +rows.reduce((s, r) => s + (r.quantity || 0), 0).toFixed(3),
    value: +rows.reduce((s, r) => s + (r.value || 0), 0).toFixed(2),
  }
  if (!groupByDocument) {
    totals.cost = +rows.reduce((s, r) => s + (r.cost || 0), 0).toFixed(2)
    totals.profit = +rows.reduce((s, r) => s + (r.profit || 0), 0).toFixed(2)
  }

  // Mixed currencies must never be summed into one number (house rule).
  const currencies = [...new Set(
    rows.flatMap((r: any) => (groupByDocument ? [r.currency] : r.currencies || [])).filter(Boolean),
  )]

  return {
    columns,
    rows,
    totals,
    meta: {
      truncated,
      cap,
      rowCount: rows.length,
      operation,
      groupBy: groupByDocument ? 'document' : 'product',
      currencies,
      mixedCurrency: currencies.length > 1,
      /** Cost is best-effort — see the cost-basis switch above. */
      costBasis: 'allocations|resolved|product_avg',
    },
  }
}
