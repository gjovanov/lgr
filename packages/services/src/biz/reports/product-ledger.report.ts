/**
 * FR-06 (#14) P2 — `product-ledger`: one article's stock history, movement by movement,
 * with the running balance.
 *
 * Adapter over `getProductLedger`, for the same reason the contact ledger is one: that
 * service already backs `/inventory/products/:id/ledger` and carries the running-balance
 * arithmetic (start/end quantity per row), which is the entire point of a ledger and is not
 * something to re-derive in a second place.
 */

import { getProductLedger } from '../product-ledger.service.js'
import {
  rowCapFor,
  ReportParamError,
  type ReportColumn,
  type ReportHandlerContext,
  type ReportResult,
} from '../report-registry.types.js'

const COLUMNS: ReportColumn[] = [
  { key: 'date',           labelKey: 'reports.columns.date',        type: 'date' },
  { key: 'documentRef',    labelKey: 'reports.columns.document' },
  { key: 'eventType',      labelKey: 'reports.columns.operation' },
  { key: 'warehouseName',  labelKey: 'reports.columns.warehouse' },
  { key: 'contactName',    labelKey: 'reports.columns.contact' },
  { key: 'startQty',       labelKey: 'reports.columns.startQty',    type: 'quantity', align: 'end' },
  { key: 'quantityChange', labelKey: 'reports.columns.change',      type: 'quantity', align: 'end' },
  { key: 'endQty',         labelKey: 'reports.columns.endQty',      type: 'quantity', align: 'end' },
  { key: 'unitCost',       labelKey: 'reports.columns.avgCost',     type: 'money',    align: 'end' },
  { key: 'lineTotalCost',  labelKey: 'reports.columns.value',       type: 'money',    align: 'end' },
]

export async function runProductLedger(ctx: ReportHandlerContext): Promise<ReportResult> {
  const productId = ctx.params.productId ? String(ctx.params.productId) : ''
  if (!productId) throw new ReportParamError('A product is required for the product ledger', 'productId')

  const cap = rowCapFor(ctx.output)
  const period = (ctx.params.period || {}) as { from?: string; to?: string }

  const result = await getProductLedger(ctx.orgId, productId, {
    warehouseId: ctx.params.warehouseId ? String(ctx.params.warehouseId) : undefined,
    contactId: ctx.params.contactId ? String(ctx.params.contactId) : undefined,
    dateFrom: period.from,
    dateTo: period.to,
    eventTypes: ctx.params.eventTypes as string[] | undefined,
    page: 0,
    size: cap + 1,
  })

  const truncated = result.entries.length > cap
  const entries = truncated ? result.entries.slice(0, cap) : result.entries

  const rows = entries.map(e => ({
    ...e,
    // `runningQty` duplicates `endQty` (the service says so); only one goes on screen.
    quantityChange: +(e.quantityChange || 0).toFixed(3),
    startQty: +(e.startQty || 0).toFixed(3),
    endQty: +(e.endQty || 0).toFixed(3),
    unitCost: +(e.unitCost || 0).toFixed(4),
    lineTotalCost: +(e.lineTotalCost || 0).toFixed(2),
  }))

  return {
    columns: COLUMNS,
    rows,
    // No balance total: summing a running balance is meaningless. The IN/OUT sums are the
    // numbers that reconcile, and they live in the summary card.
    totals: {
      lineTotalCost: +rows.reduce((s, r) => s + (r.lineTotalCost || 0), 0).toFixed(2),
    },
    meta: {
      truncated,
      cap,
      rowCount: rows.length,
      ledgerSummary: result.summary,
      totalEntries: result.total,
    },
  }
}
