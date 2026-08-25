/**
 * FR-06 (#14) — the report registry. The heart of the Reports module.
 *
 * Adding a report is ONE entry here plus ONE handler. No new view, no new route, no new
 * endpoint: `/reports/catalog` picks it up, the card hub renders it, `/reports/:id/run`
 * executes it and `/reports/:id/export` renders it to XLSX/PDF.
 *
 * ⚠ SERVER-ONLY. Handlers touch Mongo, so a UI package must never import this file — it
 * would pull mongoose into the browser bundle. The UI gets its metadata over the wire from
 * the catalog endpoint; the shared *types* live in `report-registry.types.ts`.
 *
 * Two gates, checked together and identically by catalog / run / export (FR-6.7):
 *   - `permission` — exact-match against the caller's JWT permissions.
 *   - `roles`      — optional restriction ON TOP of it. The SUPTO tables (P2) need this:
 *                    a `manager` holds every module permission yet must NOT see them.
 * The catalog is a VIEW of that gate, never the boundary — run/export re-check.
 *
 * FR-6.13: handlers are read-only. FR-6.14: they aggregate in Mongo rather than
 * materialising a collection (precedent: dashboard `/summary`, 1.6s → 25ms).
 */

import { StockLevel } from 'db/models'
import { runWarehouseOperations } from './reports/warehouse-operations.report.js'
import { runSalesHistory } from './reports/sales-history.report.js'
import {
  rowCapFor,
  type ReportCaller,
  type ReportEntry,
  type ReportMeta,
  type ReportHandlerContext,
  type ReportResult,
  canAccessReport,
  toReportMeta,
} from './report-registry.types.js'

export * from './report-registry.types.js'

// ── Handlers ────────────────────────────────────────────────────────────────

/**
 * Inventory valuation — quantity × average cost per product, rolled up across warehouses
 * (or scoped to one). Aggregated entirely in Mongo (FR-6.14): the pre-existing
 * `getStockValuation` materialised every StockLevel row plus every Product to do this in
 * JS, which is exactly what FR-6.14 forbids for a report handler.
 */
async function runInventoryValuation(ctx: ReportHandlerContext): Promise<ReportResult> {
  const cap = rowCapFor(ctx.output)
  const match: Record<string, any> = { orgId: new StockLevel.base.Types.ObjectId(ctx.orgId) }
  if (ctx.params.warehouseId) {
    match.warehouseId = new StockLevel.base.Types.ObjectId(String(ctx.params.warehouseId))
  }

  const includeZero = ctx.params.includeZero === true

  const rows = await StockLevel.aggregate([
    { $match: match },
    {
      $group: {
        _id: '$productId',
        quantity: { $sum: '$quantity' },
        reserved: { $sum: '$reservedQuantity' },
        // Value is summed per (product, warehouse) row, since avgCost is per-row.
        totalValue: { $sum: { $multiply: ['$quantity', '$avgCost'] } },
      },
    },
    ...(includeZero ? [] : [{ $match: { quantity: { $ne: 0 } } }]),
    { $sort: { totalValue: -1 } },
    // Cap + 1 so the caller can tell "exactly at the cap" from "there was more".
    { $limit: cap + 1 },
    {
      $lookup: {
        from: 'products',
        localField: '_id',
        foreignField: '_id',
        as: 'product',
        pipeline: [{ $project: { name: 1, sku: 1, unit: 1, category: 1 } }],
      },
    },
    { $unwind: { path: '$product', preserveNullAndEmptyArrays: true } },
    {
      $project: {
        _id: 0,
        productId: { $toString: '$_id' },
        sku: { $ifNull: ['$product.sku', ''] },
        name: { $ifNull: ['$product.name', ''] },
        category: { $ifNull: ['$product.category', ''] },
        unit: { $ifNull: ['$product.unit', ''] },
        quantity: { $round: ['$quantity', 3] },
        reserved: { $round: ['$reserved', 3] },
        avgCost: {
          $cond: [
            { $eq: ['$quantity', 0] },
            0,
            { $round: [{ $divide: ['$totalValue', '$quantity'] }, 4] },
          ],
        },
        totalValue: { $round: ['$totalValue', 2] },
      },
    },
  ]).exec()

  const truncated = rows.length > cap
  const page = truncated ? rows.slice(0, cap) : rows

  return {
    columns: [
      { key: 'sku',        labelKey: 'reports.columns.sku' },
      { key: 'name',       labelKey: 'reports.columns.product' },
      { key: 'category',   labelKey: 'reports.columns.category' },
      { key: 'unit',       labelKey: 'reports.columns.unit' },
      { key: 'quantity',   labelKey: 'reports.columns.quantity',   type: 'quantity', align: 'end' },
      { key: 'reserved',   labelKey: 'reports.columns.reserved',   type: 'quantity', align: 'end' },
      { key: 'avgCost',    labelKey: 'reports.columns.avgCost',    type: 'money',    align: 'end' },
      { key: 'totalValue', labelKey: 'reports.columns.totalValue', type: 'money',    align: 'end' },
    ],
    rows: page,
    totals: {
      quantity: +page.reduce((s, r) => s + (r.quantity || 0), 0).toFixed(3),
      totalValue: +page.reduce((s, r) => s + (r.totalValue || 0), 0).toFixed(2),
    },
    meta: { truncated, cap, rowCount: page.length },
  }
}

// ── The registry ────────────────────────────────────────────────────────────

/**
 * P1 ships three entries: the two pages moved out of Invoicing (which keep their own richer
 * views) and one registry-driven report proving the runner end to end.
 *
 * P2 adds the rest of issue #14's catalog — sales/purchase/cash documents, contact ledger,
 * stock levels/movements, product ledger, order sheet, and the SUPTO 18.1–18.9 tables
 * (`roles: ['admin', 'nra_auditor']`, `outputs: ['xlsx']`).
 */
export const REPORT_REGISTRY: ReportEntry[] = [
  {
    id: 'export',
    category: 'sales',
    labelKey: 'reports.export.label',
    descriptionKey: 'reports.export.description',
    icon: 'mdi-download',
    permission: 'invoicing.read',
    params: [],
    outputs: ['table', 'xlsx', 'pdf'],
    view: 'custom',
    route: '/export',
  },
  {
    id: 'aging',
    category: 'receivables',
    labelKey: 'reports.aging.label',
    descriptionKey: 'reports.aging.description',
    icon: 'mdi-clock-alert-outline',
    permission: 'invoicing.read',
    params: [],
    outputs: ['table'],
    view: 'custom',
    route: '/aging',
  },
  {
    id: 'inventory-valuation',
    category: 'inventory',
    labelKey: 'reports.inventoryValuation.label',
    descriptionKey: 'reports.inventoryValuation.description',
    icon: 'mdi-chart-areaspline',
    permission: 'inventory.read',
    params: [
      { key: 'warehouseId', type: 'warehouse', labelKey: 'reports.params.warehouse' },
      { key: 'includeZero', type: 'bool', labelKey: 'reports.params.includeZeroStock', default: false },
    ],
    outputs: ['table', 'xlsx', 'pdf'],
    view: 'runner',
    route: '/inventory-valuation',
    handler: runInventoryValuation,
    drilldown: (row) => (row.productId ? `/inventory/products/${row.productId}/edit` : undefined),
  },

  // ── FR-07 (#16) — „Складови операции" ──
  {
    id: 'warehouse-operations',
    category: 'inventory',
    labelKey: 'reports.warehouseOps.label',
    descriptionKey: 'reports.warehouseOps.description',
    icon: 'mdi-swap-horizontal',
    permission: 'inventory.read',
    params: [
      { key: 'period', type: 'period', labelKey: 'reports.params.period', default: { preset: 'this_month' } },
      {
        key: 'operation', type: 'select', labelKey: 'reports.params.operation', required: true, default: 'sales',
        options: [
          { value: 'sales', labelKey: 'reports.params.operationSales' },
          { value: 'purchases', labelKey: 'reports.params.operationPurchases' },
        ],
      },
      { key: 'warehouseId', type: 'warehouse', labelKey: 'reports.params.warehouse' },
      {
        key: 'docTypes', type: 'multiselect', labelKey: 'reports.params.docTypes',
        options: [
          { value: 'invoice', labelKey: 'reports.docTypes.invoice' },
          { value: 'cash_sale', labelKey: 'reports.docTypes.cash_sale' },
          { value: 'credit_note', labelKey: 'reports.docTypes.credit_note' },
          { value: 'debit_note', labelKey: 'reports.docTypes.debit_note' },
          // Movements with no invoice at all — the regal majority on the purchase side.
          { value: 'receipt_note', labelKey: 'reports.docTypes.receipt_note' },
          { value: 'dispatch_note', labelKey: 'reports.docTypes.dispatch_note' },
        ],
      },
      { key: 'productId', type: 'product', labelKey: 'reports.params.product' },
      { key: 'categoryId', type: 'category', labelKey: 'reports.params.productGroup' },
      {
        key: 'contactId', type: 'contact', labelKey: 'reports.params.contact',
        // Sales list customers, purchases list suppliers — the docx's rule.
        contactSideFrom: { param: 'operation', map: { sales: 'customer', purchases: 'supplier' } },
      },
      {
        key: 'groupBy', type: 'select', labelKey: 'reports.params.groupBy', default: 'product',
        options: [
          { value: 'product', labelKey: 'reports.params.groupByProduct' },
          { value: 'document', labelKey: 'reports.params.groupByDocument' },
        ],
      },
      { key: 'withBatches', type: 'bool', labelKey: 'reports.params.withBatches', default: false },
    ],
    outputs: ['table', 'xlsx', 'pdf'],
    view: 'runner',
    route: '/warehouse-operations',
    handler: runWarehouseOperations,
    drilldown: (row) => (row.productId ? `/inventory/products/${row.productId}/edit` : undefined),
  },

  // ── FR-08 (#17) — „История на продажбите" ──
  {
    id: 'sales-history',
    category: 'sales',
    labelKey: 'reports.salesHistory.label',
    descriptionKey: 'reports.salesHistory.description',
    icon: 'mdi-cash-clock',
    permission: 'invoicing.read',
    params: [
      // The legacy screen opens on the current day — this is a day-end reconciliation tool.
      { key: 'period', type: 'period', labelKey: 'reports.params.period', default: { preset: 'today' } },
      {
        key: 'paymentMethods', type: 'multiselect', labelKey: 'reports.params.paymentMethods',
        default: ['cash', 'card'],
        options: [
          { value: 'cash', labelKey: 'pos.cash' },
          { value: 'card', labelKey: 'pos.card' },
          { value: 'other', labelKey: 'common.other' },
        ],
      },
      {
        key: 'source', type: 'select', labelKey: 'reports.params.source', default: 'all',
        options: [
          { value: 'all', labelKey: 'reports.params.sourceAll' },
          { value: 'documents', labelKey: 'reports.params.sourceDocuments' },
          { value: 'pos', labelKey: 'reports.params.sourcePos' },
        ],
      },
      { key: 'userId', type: 'user', labelKey: 'reports.params.user' },
      { key: 'warehouseId', type: 'warehouse', labelKey: 'reports.params.warehouse' },
      { key: 'contactId', type: 'contact', labelKey: 'reports.params.contact' },
      { key: 'includeNonRegister', type: 'bool', labelKey: 'reports.params.includeNonRegister', default: false },
    ],
    outputs: ['table', 'xlsx', 'pdf'],
    view: 'runner',
    route: '/sales-history',
    handler: runSalesHistory,
    drilldown: (row) =>
      row.rowType === 'pos'
        ? `/pos/orders/${row.posId}`
        : row.invoiceId
          ? `/invoicing/invoices/${row.invoiceId}/edit`
          : undefined,
  },
]

const byId = new Map(REPORT_REGISTRY.map(e => [e.id, e]))

export function reportById(id: string): ReportEntry | undefined {
  return byId.get(id)
}

/** The catalog (FR-6.7): the entries this caller may see, in registry order. */
export function listReportsFor(user: ReportCaller | null | undefined): ReportMeta[] {
  return REPORT_REGISTRY.filter(e => canAccessReport(e, user)).map(toReportMeta)
}
