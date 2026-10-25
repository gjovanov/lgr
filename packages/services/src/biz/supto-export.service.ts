/**
 * SUPTO Export Service — Appendix 29, Tables 18.1–18.9
 *
 * Provides query functions for each of the 9 mandatory export tables
 * required by Bulgarian Ordinance Н-18 for NRA audit.
 */

import type { RepositoryRegistry } from 'dal'
import { getRepos } from '../context.js'
import { isDateOnly, localDayEnd, localDayStart } from './local-day.js'
import { loadPosRows } from './cash-register/pos-union.js'

/**
 * The period the tables cover, from the query's `dateFrom` / `dateTo` (FR-21 B-7).
 *
 * The UI sends calendar dates. They are Bulgarian days — the ordinance's, and the fiscal devices'
 * — so a period runs from Bulgarian midnight on `dateFrom` to the last millisecond of `dateTo`.
 * Read as `new Date('YYYY-MM-DD')` they were 00:00 UTC, which made `dateTo` the START of its day:
 * the POS tables, windowed on `createdAt`, dropped the whole last day, and a one-day export of
 * them was empty. A full timestamp is taken as it is, for an API caller that sends one.
 */
export function suptoPeriod(dateFrom?: string, dateTo?: string, now: Date = new Date()): { dateFrom: Date; dateTo: Date } {
  return {
    dateFrom: !dateFrom ? now : isDateOnly(dateFrom) ? localDayStart(dateFrom) : new Date(dateFrom),
    dateTo: !dateTo ? now : isDateOnly(dateTo) ? localDayEnd(dateTo) : new Date(dateTo),
  }
}

export interface SuptoExportFilters {
  orgId: string
  dateFrom: Date
  dateTo: Date
  warehouseId?: string
  fiscalDeviceNumber?: string
  workstationId?: string
  operatorCode?: string
}

/**
 * The till rows of the period, from both stores, each once (FR-21.8): a till sale is a POS row
 * until R2 and a cash-register document after it, and these tables list it either way. The
 * device and operator filters apply here, after the union.
 */
async function tillRows(filters: SuptoExportFilters, keep: (t: any) => boolean, byDevice = true) {
  const rows = await loadPosRows({ orgId: filters.orgId, from: filters.dateFrom, to: filters.dateTo })
  return rows.filter(t =>
    keep(t)
    && (!byDevice || !filters.fiscalDeviceNumber || t.fiscalDeviceNumber === filters.fiscalDeviceNumber),
  )
}

const SALE_TYPES = ['sale', 'return', 'exchange']

/** 18.1 — Summarized sales (POS + cash sales) */
export async function exportSummarizedSales(filters: SuptoExportFilters, repos?: RepositoryRegistry) {
  const r = repos ?? getRepos()
  const transactions = await tillRows(filters, t =>
    SALE_TYPES.includes(t.type)
    && (!filters.operatorCode || String(t.unpNumber || '').includes(`-${filters.operatorCode}-`)))

  // Also include cash_sale invoices — but not the till's own documents, already listed above.
  const invoiceQuery: any = {
    orgId: filters.orgId,
    type: 'cash_sale',
    issueDate: { $gte: filters.dateFrom, $lte: filters.dateTo },
    'register.origin': { $ne: 'pos' },
  }
  const cashSales = await r.invoices.findMany(invoiceQuery, { issueDate: 1 })

  return { transactions, cashSales }
}

/** 18.2 — Payment details */
export async function exportPaymentDetails(filters: SuptoExportFilters, _repos?: RepositoryRegistry) {
  return tillRows(filters, () => true)
}

/** 18.3 — Itemized sales (line-level detail) */
export async function exportItemizedSales(filters: SuptoExportFilters, _repos?: RepositoryRegistry) {
  return tillRows(filters, t => SALE_TYPES.includes(t.type))
}

/** 18.4 — Reversed (storno) sales */
export async function exportReversedSales(filters: SuptoExportFilters, _repos?: RepositoryRegistry) {
  return tillRows(filters, t => t.type === 'storno')
}

/** 18.5 — Cancelled sales */
export async function exportCancelledSales(filters: SuptoExportFilters, _repos?: RepositoryRegistry) {
  return tillRows(filters, t => t.status === 'cancelled', false)
}

/** 18.6 — Delivery summary (incoming stock movements) */
export async function exportDeliverySummary(filters: SuptoExportFilters, repos?: RepositoryRegistry) {
  const r = repos ?? getRepos()
  const query: any = {
    orgId: filters.orgId,
    type: 'receipt',
    date: { $gte: filters.dateFrom, $lte: filters.dateTo },
  }
  if (filters.warehouseId) query.toWarehouseId = filters.warehouseId

  const movements = await r.stockMovements.findMany(query, { date: 1 })

  // Batch load contacts for supplier names
  const contactIds = [...new Set(movements.filter(m => m.contactId).map(m => m.contactId!))]
  const contacts = contactIds.length > 0
    ? await r.contacts.findMany({ orgId: filters.orgId, id: { $in: contactIds } } as any)
    : []
  const contactMap = new Map(contacts.map(c => [c.id, c]))

  return { movements, contactMap }
}

/** 18.7 — Delivery details (line-level for receipts) */
export async function exportDeliveryDetails(filters: SuptoExportFilters, repos?: RepositoryRegistry) {
  const r = repos ?? getRepos()
  const query: any = {
    orgId: filters.orgId,
    type: 'receipt',
    date: { $gte: filters.dateFrom, $lte: filters.dateTo },
  }
  if (filters.warehouseId) query.toWarehouseId = filters.warehouseId

  const movements = await r.stockMovements.findMany(query, { date: 1 })

  // Batch load products for names
  const productIds = [...new Set(movements.flatMap(m => m.lines.map(l => l.productId)))]
  const products = productIds.length > 0
    ? await r.products.findMany({ orgId: filters.orgId, id: { $in: productIds } } as any)
    : []
  const productMap = new Map(products.map(p => [p.id, p]))

  return { movements, productMap }
}

/** 18.8 — Stock movement summary (opening/closing balances by product) */
export async function exportStockMovementSummary(filters: SuptoExportFilters, repos?: RepositoryRegistry) {
  const r = repos ?? getRepos()

  // Get all stock levels as current state
  const slFilter: any = { orgId: filters.orgId }
  if (filters.warehouseId) slFilter.warehouseId = filters.warehouseId
  const stockLevels = await r.stockLevels.findMany(slFilter)

  // Get movements in period for debit/credit calculation
  const mvFilter: any = {
    orgId: filters.orgId,
    date: { $gte: filters.dateFrom, $lte: filters.dateTo },
    // A record-only movement repeats goods another movement moved (FR-21.4).
    recordOnly: { $ne: true },
  }
  if (filters.warehouseId) {
    mvFilter.$or = [{ fromWarehouseId: filters.warehouseId }, { toWarehouseId: filters.warehouseId }]
  }
  const movements = await r.stockMovements.findMany(mvFilter, { date: 1 })

  // Batch load products
  const productIds = [...new Set(stockLevels.map(sl => sl.productId))]
  const products = productIds.length > 0
    ? await r.products.findMany({ orgId: filters.orgId, id: { $in: productIds } } as any)
    : []
  const productMap = new Map(products.map(p => [p.id, p]))

  return { stockLevels, movements, productMap }
}

/** 18.9 — Nomenclature tables (products, contacts, warehouses, operators, roles) */
export async function exportNomenclature(orgId: string, repos?: RepositoryRegistry) {
  const r = repos ?? getRepos()

  const [products, contacts, warehouses, users, workstations] = await Promise.all([
    r.products.findMany({ orgId } as any, { name: 1 }),
    r.contacts.findMany({ orgId } as any, { companyName: 1 }),
    r.warehouses.findMany({ orgId } as any, { name: 1 }),
    r.users.findMany({ orgId } as any, { lastName: 1 }),
    r.workstations.findMany({ orgId } as any, { code: 1 }),
  ])

  return { products, contacts, warehouses, users, workstations }
}
