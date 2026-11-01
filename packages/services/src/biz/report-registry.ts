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
import { makeDocumentsReport, DOCUMENT_STATUS_OPTIONS } from './reports/documents.report.js'
import { runContactLedger } from './reports/contact-ledger.report.js'
import { runProductLedger } from './reports/product-ledger.report.js'
import { runStockLevels } from './reports/stock-levels.report.js'
import { runStockMovements, MOVEMENT_TYPE_OPTIONS, MOVEMENT_STATUS_OPTIONS } from './reports/stock-movements.report.js'
import { runOrderSheet, ORDER_STATUS_OPTIONS } from './reports/order-sheet.report.js'
import { SUPTO_TABLES, SUPTO_ROLES, SUPTO_PERMISSION } from './reports/supto.report.js'
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
        ? `/invoicing/cash-sales/${row.posId}/view`
        : row.invoiceId
          // A cash sale opens on its own page; the invoice form would show it as an invoice (FR-21.3),
          // and a storno on the journal's, where it reads as a storno.
          ? row.docType === 'cash_sale'
            ? `/invoicing/cash-sales/${row.invoiceId}/edit`
            : row.docType === 'cash_storno'
              ? `/invoicing/cash-sales/${row.invoiceId}/view`
              : `/invoicing/invoices/${row.invoiceId}/edit`
          : undefined,
  },

  // ── P2: the document registers ──
  // Same three populations as `POST /invoicing/export/kind/:kind`, as runnable tables.
  ...(['outgoing', 'incoming', 'cash_register'] as const).map<ReportEntry>(kind => {
    const spec = {
      outgoing: {
        id: 'sales-documents', category: 'sales' as const, icon: 'mdi-file-document-outline',
        i18n: 'salesDocuments', drilldownApp: '/invoicing/invoices',
        contactSide: 'customer' as const,
      },
      incoming: {
        id: 'purchase-documents', category: 'purchase' as const, icon: 'mdi-file-import-outline',
        i18n: 'purchaseDocuments', drilldownApp: '/invoicing/bills',
        contactSide: 'supplier' as const,
      },
      cash_register: {
        id: 'cash-register', category: 'sales' as const, icon: 'mdi-cash-register',
        i18n: 'cashRegister', drilldownApp: '/invoicing/cash-sales',
        contactSide: 'customer' as const,
      },
    }[kind]

    return {
      id: spec.id,
      category: spec.category,
      labelKey: `reports.${spec.i18n}.label`,
      descriptionKey: `reports.${spec.i18n}.description`,
      icon: spec.icon,
      permission: 'invoicing.read',
      params: [
        { key: 'period', type: 'period', labelKey: 'reports.params.period', default: { preset: 'this_month' } },
        {
          key: 'contactId',
          type: 'contact',
          labelKey: spec.contactSide === 'supplier' ? 'reports.params.supplier' : 'reports.params.contact',
          // Fixed side, unlike warehouse-operations where a sibling param flips it.
          contactSide: spec.contactSide,
        },
        {
          key: 'statuses', type: 'multiselect', labelKey: 'reports.params.statuses',
          options: DOCUMENT_STATUS_OPTIONS.map(s => ({ value: s, labelKey: `invoicing.status.${s}` })),
        },
        { key: 'currency', type: 'text', labelKey: 'common.currency' },
      ],
      outputs: ['table', 'xlsx', 'pdf'],
      view: 'runner',
      route: `/${spec.id}`,
      handler: makeDocumentsReport(kind),
      // A storno reads as a storno on the journal's page; the cash-sale form would show a sale.
      drilldown: (row) => (!row.invoiceId
        ? undefined
        : row.docType === 'cash_storno'
          ? `/invoicing/cash-sales/${row.invoiceId}/view`
          : `${spec.drilldownApp}/${row.invoiceId}/edit`),
    }
  }),

  // ── P2: ledgers ──
  {
    id: 'contact-ledger',
    category: 'receivables',
    labelKey: 'reports.contactLedger.label',
    descriptionKey: 'reports.contactLedger.description',
    icon: 'mdi-account-details-outline',
    permission: 'invoicing.read',
    params: [
      // Required: a ledger without a counterparty is the document register, not a ledger.
      { key: 'contactId', type: 'contact', labelKey: 'reports.params.contact', required: true },
      { key: 'period', type: 'period', labelKey: 'reports.params.period', default: { preset: 'this_year' } },
      {
        key: 'docTypes', type: 'multiselect', labelKey: 'reports.params.docTypes',
        options: [
          { value: 'invoice', labelKey: 'reports.docTypes.invoice' },
          { value: 'cash_sale', labelKey: 'reports.docTypes.cash_sale' },
          { value: 'credit_note', labelKey: 'reports.docTypes.credit_note' },
          { value: 'debit_note', labelKey: 'reports.docTypes.debit_note' },
          { value: 'proforma', labelKey: 'reports.docTypes.proforma' },
        ],
      },
    ],
    outputs: ['table', 'xlsx', 'pdf'],
    view: 'runner',
    route: '/contact-ledger',
    handler: runContactLedger,
    drilldown: (row) => (row.documentId ? `/invoicing/invoices/${row.documentId}/edit` : undefined),
  },
  {
    id: 'product-ledger',
    category: 'inventory',
    labelKey: 'reports.productLedger.label',
    descriptionKey: 'reports.productLedger.description',
    icon: 'mdi-book-open-variant',
    permission: 'inventory.read',
    params: [
      { key: 'productId', type: 'product', labelKey: 'reports.params.product', required: true },
      { key: 'period', type: 'period', labelKey: 'reports.params.period', default: { preset: 'this_year' } },
      { key: 'warehouseId', type: 'warehouse', labelKey: 'reports.params.warehouse' },
      { key: 'contactId', type: 'contact', labelKey: 'reports.params.contact' },
    ],
    outputs: ['table', 'xlsx', 'pdf'],
    view: 'runner',
    route: '/product-ledger',
    handler: runProductLedger,
    drilldown: (row) =>
      row.invoiceId
        ? `/invoicing/invoices/${row.invoiceId}/edit`
        : row.documentId
          ? `/inventory/movements/${row.documentId}`
          : undefined,
  },

  // ── P2: stock ──
  {
    id: 'stock-levels',
    category: 'inventory',
    labelKey: 'reports.stockLevels.label',
    descriptionKey: 'reports.stockLevels.description',
    icon: 'mdi-warehouse',
    permission: 'inventory.read',
    params: [
      { key: 'warehouseId', type: 'warehouse', labelKey: 'reports.params.warehouse' },
      { key: 'productId', type: 'product', labelKey: 'reports.params.product' },
      { key: 'categoryId', type: 'category', labelKey: 'reports.params.productGroup' },
      {
        key: 'groupBy', type: 'select', labelKey: 'reports.params.groupBy', default: 'warehouse',
        options: [
          { value: 'warehouse', labelKey: 'reports.params.groupByWarehouse' },
          { value: 'product', labelKey: 'reports.params.groupByProduct' },
        ],
      },
      { key: 'belowMin', type: 'bool', labelKey: 'reports.params.belowMin', default: false },
      { key: 'includeZero', type: 'bool', labelKey: 'reports.params.includeZeroStock', default: false },
    ],
    outputs: ['table', 'xlsx', 'pdf'],
    view: 'runner',
    route: '/stock-levels',
    handler: runStockLevels,
    drilldown: (row) => (row.productId ? `/inventory/products/${row.productId}/levels` : undefined),
  },
  {
    id: 'stock-movements',
    category: 'inventory',
    labelKey: 'reports.stockMovements.label',
    descriptionKey: 'reports.stockMovements.description',
    icon: 'mdi-transfer',
    permission: 'inventory.read',
    params: [
      { key: 'period', type: 'period', labelKey: 'reports.params.period', default: { preset: 'this_month' } },
      {
        key: 'types', type: 'multiselect', labelKey: 'reports.params.movementTypes',
        options: MOVEMENT_TYPE_OPTIONS.map(t => ({ value: t, labelKey: `reports.movementTypes.${t}` })),
      },
      {
        key: 'statuses', type: 'multiselect', labelKey: 'reports.params.statuses',
        options: MOVEMENT_STATUS_OPTIONS.map(s => ({ value: s, labelKey: `invoicing.status.${s}` })),
      },
      { key: 'warehouseId', type: 'warehouse', labelKey: 'reports.params.warehouse' },
      { key: 'productId', type: 'product', labelKey: 'reports.params.product' },
      { key: 'contactId', type: 'contact', labelKey: 'reports.params.contact' },
      {
        key: 'groupBy', type: 'select', labelKey: 'reports.params.groupBy', default: 'line',
        options: [
          { value: 'line', labelKey: 'reports.params.groupByLine' },
          { value: 'document', labelKey: 'reports.params.groupByDocument' },
        ],
      },
    ],
    outputs: ['table', 'xlsx', 'pdf'],
    view: 'runner',
    route: '/stock-movements',
    handler: runStockMovements,
    drilldown: (row) => (row.movementId ? `/inventory/movements/${row.movementId}` : undefined),
  },

  // ── P2: purchasing ──
  {
    id: 'order-sheet',
    category: 'purchase',
    labelKey: 'reports.orderSheet.label',
    descriptionKey: 'reports.orderSheet.description',
    icon: 'mdi-clipboard-list-outline',
    permission: 'invoicing.read',
    params: [
      { key: 'period', type: 'period', labelKey: 'reports.params.period', default: { preset: 'this_quarter' } },
      { key: 'contactId', type: 'contact', labelKey: 'reports.params.supplier' },
      {
        key: 'statuses', type: 'multiselect', labelKey: 'reports.params.statuses',
        options: ORDER_STATUS_OPTIONS.map(s => ({ value: s, labelKey: `invoicing.status.${s}` })),
      },
      { key: 'productId', type: 'product', labelKey: 'reports.params.product' },
      { key: 'onlyOutstanding', type: 'bool', labelKey: 'reports.params.onlyOutstanding', default: false },
    ],
    outputs: ['table', 'xlsx', 'pdf'],
    view: 'runner',
    route: '/order-sheet',
    handler: runOrderSheet,
    drilldown: (row) => (row.orderId ? `/invoicing/orders/${row.orderId}` : undefined),
  },

  // ── P2: SUPTO / НАП (Приложение 29), tables 18.1–18.9 ──
  // `view: 'custom'` on purpose — see reports/supto.report.ts: the workbooks are legally
  // prescribed and must keep coming from the existing generator, not the generic renderer.
  ...SUPTO_TABLES.map<ReportEntry>(t => ({
    id: t.id,
    category: 'fiscal',
    labelKey: t.labelKey,
    descriptionKey: t.descriptionKey,
    icon: 'mdi-shield-check-outline',
    permission: SUPTO_PERMISSION,
    roles: SUPTO_ROLES,
    params: t.needsPeriod
      ? [{ key: 'period', type: 'period', labelKey: 'reports.params.period', default: { preset: 'last_month' } }]
      : [],
    outputs: ['xlsx'],
    view: 'custom',
    route: `/supto/${t.tableId}`,
  })),
]

const byId = new Map(REPORT_REGISTRY.map(e => [e.id, e]))

export function reportById(id: string): ReportEntry | undefined {
  return byId.get(id)
}

/** The catalog (FR-6.7): the entries this caller may see, in registry order. */
export function listReportsFor(user: ReportCaller | null | undefined): ReportMeta[] {
  return REPORT_REGISTRY.filter(e => canAccessReport(e, user)).map(toReportMeta)
}
