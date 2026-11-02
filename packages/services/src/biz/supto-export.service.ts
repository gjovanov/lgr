/**
 * SUPTO Export Service — Appendix 29, Tables 18.1–18.9
 *
 * Provides query functions for each of the 9 mandatory export tables
 * required by Bulgarian Ordinance Н-18 for NRA audit.
 */

import type { RepositoryRegistry } from 'dal'
import { getRepos } from '../context.js'
import { isDateOnly, localDayEnd, localDayStart } from './local-day.js'
import { loadPosRows, PAYMENT_RECEIPT, PAYMENT_STORNO } from './cash-register/pos-union.js'
import { receiptTookMoney, refundGaveMoney, stornoUnproved } from './cash-register/counting.js'
import { originOf } from './cash-register/register.service.js'
import { Invoice, User } from 'db/models'

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
  const rows = await loadPosRows({ orgId: filters.orgId, from: filters.dateFrom, to: filters.dateTo, withReceipts: true })
  return rows.filter(t =>
    keep(t)
    && (!byDevice || !filters.fiscalDeviceNumber || t.fiscalDeviceNumber === filters.fiscalDeviceNumber),
  )
}

const SALE_TYPES = ['sale', 'return', 'exchange']

/**
 * FR-23: what the device sold, for the tables that list receipts. A payment's receipt is one: an
 * inspector reads the device's journal against them. It lists under its own type, and only once it
 * printed or may have; one that failed took nothing, and 18.5 accounts for its number and УНП. The
 * invoice it paid is in none of these tables, so none of them holds the money twice.
 */
const onTheDevice = (t: any) => (t.type === PAYMENT_RECEIPT ? receiptTookMoney(t) : SALE_TYPES.includes(t.type))

/** 18.1 — Summarized sales (POS + cash sales) */
export async function exportSummarizedSales(filters: SuptoExportFilters, repos?: RepositoryRegistry) {
  const r = repos ?? getRepos()
  const transactions = await tillRows(filters, t =>
    onTheDevice(t)
    && (!filters.operatorCode || t.operatorCode === filters.operatorCode))

  // Also include cash_sale invoices — but not the till's own documents, already listed above.
  const invoiceQuery: any = {
    orgId: filters.orgId,
    type: 'cash_sale',
    issueDate: { $gte: filters.dateFrom, $lte: filters.dateTo },
    'register.origin': { $ne: 'pos' },
  }
  const found = await r.invoices.findMany(invoiceQuery, { issueDate: 1 })

  // #323: the operator of a back-office cash sale. A joined sale stores it (it is the till's, above);
  // a sessionless one names its author, whose code it is. An imported day has none: its author is
  // whoever ran the import, not who sold.
  const authors = [...new Set(found.filter((d: any) => !d.register?.operatorCode && originOf(d) !== 'import' && d.createdBy).map((d: any) => String(d.createdBy)))]
  const codeOf = new Map(authors.length
    ? (await User.find({ _id: { $in: authors }, orgId: filters.orgId }, { operatorCode: 1 }).lean().exec()).map((u: any) => [String(u._id), u.operatorCode as string | undefined])
    : [])
  const cashSales = found
    .map((d: any) => ({
      ...d,
      register: {
        ...(d.register || {}),
        operatorCode: d.register?.operatorCode || (originOf(d) === 'import' ? undefined : codeOf.get(String(d.createdBy))),
      },
    }))
    .filter((d: any) => !filters.operatorCode || d.register.operatorCode === filters.operatorCode)

  return { transactions, cashSales }
}

/**
 * 18.2 — Payment details: a receipt or a refund's storno once its money moved. A storno nothing has
 * proved paid nothing back yet, and lists once it is settled.
 */
export async function exportPaymentDetails(filters: SuptoExportFilters, _repos?: RepositoryRegistry) {
  return tillRows(filters, t => (t.type === PAYMENT_RECEIPT ? receiptTookMoney(t) : t.type === PAYMENT_STORNO ? refundGaveMoney(t) : true) && !stornoUnproved(t))
}

/** 18.3 — Itemized sales (line-level detail) */
export async function exportItemizedSales(filters: SuptoExportFilters, _repos?: RepositoryRegistry) {
  return tillRows(filters, onTheDevice)
}

/**
 * 18.4 — Reversed (storno) sales: the till's, and the storno of a refund on a credit note (FR-23 R2),
 * citing the receipt it reverses. One nothing has proved lists once it is settled, and one that failed
 * is 18.5's.
 */
export async function exportReversedSales(filters: SuptoExportFilters, _repos?: RepositoryRegistry) {
  return tillRows(filters, t => (t.type === 'storno' && !stornoUnproved(t)) || refundGaveMoney(t))
}

/**
 * 18.5 — Cancelled sales. A sale whose storno nothing has proved is claimed, not cancelled: it may yet
 * be given back, and the storno's own day can be outside the period asked for, so it is asked for here.
 */
export async function exportCancelledSales(filters: SuptoExportFilters, _repos?: RepositoryRegistry) {
  const claimed = new Set((await Invoice.distinct('relatedInvoiceId', {
    orgId: filters.orgId, type: 'cash_storno', status: { $ne: 'voided' }, 'register.fiscal.state': { $in: ['pending', 'unknown'] },
  } as any).exec()).map(String))
  return tillRows(filters, t => t.status === 'cancelled' && !claimed.has(String(t._id)), false)
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
