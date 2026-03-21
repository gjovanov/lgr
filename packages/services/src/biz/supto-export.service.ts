/**
 * SUPTO Export Service — Appendix 29, Tables 18.1–18.9
 *
 * Provides query functions for each of the 9 mandatory export tables
 * required by Bulgarian Ordinance Н-18 for NRA audit.
 */

import type { RepositoryRegistry } from 'dal'
import { getRepos } from '../context.js'

export interface SuptoExportFilters {
  orgId: string
  dateFrom: Date
  dateTo: Date
  warehouseId?: string
  fiscalDeviceNumber?: string
  workstationId?: string
  operatorCode?: string
}

/** 18.1 — Summarized sales (POS + cash sales) */
export async function exportSummarizedSales(filters: SuptoExportFilters, repos?: RepositoryRegistry) {
  const r = repos ?? getRepos()
  const query: any = {
    orgId: filters.orgId,
    createdAt: { $gte: filters.dateFrom, $lte: filters.dateTo },
    type: { $in: ['sale', 'return', 'exchange'] },
  }
  if (filters.fiscalDeviceNumber) query.fiscalDeviceNumber = filters.fiscalDeviceNumber
  if (filters.operatorCode) query['lines.0'] = { $exists: true } // ensure has lines

  const transactions = await r.posTransactions.findMany(query, { createdAt: 1 })

  // Also include cash_sale invoices
  const invoiceQuery: any = {
    orgId: filters.orgId,
    type: 'cash_sale',
    issueDate: { $gte: filters.dateFrom, $lte: filters.dateTo },
  }
  const cashSales = await r.invoices.findMany(invoiceQuery, { issueDate: 1 })

  return { transactions, cashSales }
}

/** 18.2 — Payment details */
export async function exportPaymentDetails(filters: SuptoExportFilters, repos?: RepositoryRegistry) {
  const r = repos ?? getRepos()
  const query: any = {
    orgId: filters.orgId,
    createdAt: { $gte: filters.dateFrom, $lte: filters.dateTo },
  }
  if (filters.fiscalDeviceNumber) query.fiscalDeviceNumber = filters.fiscalDeviceNumber

  return r.posTransactions.findMany(query, { createdAt: 1 })
}

/** 18.3 — Itemized sales (line-level detail) */
export async function exportItemizedSales(filters: SuptoExportFilters, repos?: RepositoryRegistry) {
  const r = repos ?? getRepos()
  const query: any = {
    orgId: filters.orgId,
    createdAt: { $gte: filters.dateFrom, $lte: filters.dateTo },
    type: { $in: ['sale', 'return', 'exchange'] },
  }
  if (filters.fiscalDeviceNumber) query.fiscalDeviceNumber = filters.fiscalDeviceNumber

  return r.posTransactions.findMany(query, { createdAt: 1 })
}

/** 18.4 — Reversed (storno) sales */
export async function exportReversedSales(filters: SuptoExportFilters, repos?: RepositoryRegistry) {
  const r = repos ?? getRepos()
  const query: any = {
    orgId: filters.orgId,
    createdAt: { $gte: filters.dateFrom, $lte: filters.dateTo },
    type: 'storno',
  }
  if (filters.fiscalDeviceNumber) query.fiscalDeviceNumber = filters.fiscalDeviceNumber

  return r.posTransactions.findMany(query, { createdAt: 1 })
}

/** 18.5 — Cancelled sales */
export async function exportCancelledSales(filters: SuptoExportFilters, repos?: RepositoryRegistry) {
  const r = repos ?? getRepos()
  const query: any = {
    orgId: filters.orgId,
    createdAt: { $gte: filters.dateFrom, $lte: filters.dateTo },
    status: 'cancelled',
  }

  return r.posTransactions.findMany(query, { createdAt: 1 })
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
