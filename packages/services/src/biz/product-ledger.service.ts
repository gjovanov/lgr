import { StockMovement, InventoryCount, Warehouse, Invoice } from 'db/models'
import { NOT_UNPROVED_STORNO, saleScopeFilter } from './sale-counting.js'
import { mongoose } from 'db/connection'
const { Types } = mongoose

export interface ProductLedgerEntry {
  date: string
  documentRef: string
  documentId: string
  documentType: 'movement' | 'inventory_count'
  eventType: string
  warehouseId: string
  warehouseName: string
  contactId?: string
  contactName?: string
  quantityChange: number
  unitCost: number
  lineTotalCost: number
  /** Balance immediately before this movement was applied. */
  startQty: number
  /** Balance immediately after — identical to `runningQty`, which it supersedes in the UI. */
  endQty: number
  runningQty: number
  runningValue: number
  invoiceId?: string
  invoiceNumber?: string
  /** Source document the movement was booked from, e.g. "sklrazp_0000012698". */
  reference?: string
  movementType?: string
}

export interface ProductLedgerResult {
  entries: ProductLedgerEntry[]
  total: number
  page: number
  size: number
  totalPages: number
  summary: {
    totalIn: number
    totalOut: number
    currentQty: number
    currentValue: number
    totalCashRegisterSales: number
    totalInvoiceSales: number
    totalSales: number
  }
}

export interface ProductLedgerOptions {
  warehouseId?: string
  dateFrom?: string
  dateTo?: string
  contactId?: string
  eventTypes?: string[]
  /** One of `LEDGER_SORT_KEYS`; unset or unknown: the booking order, oldest first. */
  sortBy?: string
  sortOrder?: 'asc' | 'desc'
  page?: number
  size?: number
}

const TEXT_SORT_KEYS = ['documentRef', 'contactName', 'eventType', 'warehouseName', 'invoiceNumber', 'reference']
const NUMBER_SORT_KEYS = ['startQty', 'quantityChange', 'endQty', 'runningQty', 'unitCost', 'lineTotalCost', 'runningValue']
/** Every column the ledger can be sorted by. */
export const LEDGER_SORT_KEYS = ['date', ...TEXT_SORT_KEYS, ...NUMBER_SORT_KEYS]

/** „SM-2026-00010" after „SM-2026-00009", and Cyrillic in its own alphabet. */
const collator = new Intl.Collator('bg', { numeric: true, sensitivity: 'base' })

/**
 * The ledger in the asked order. `entries` arrive in booking order, which breaks every tie, so a
 * group of equal values still reads oldest → newest. A row without a value (no contact, no
 * invoice) goes last either way: sorting by invoice shows the invoices.
 */
export function sortLedgerEntries(entries: ProductLedgerEntry[], sortBy?: string, sortOrder?: string): ProductLedgerEntry[] {
  const desc = sortOrder === 'desc'
  if (sortBy === 'date') return desc ? [...entries].reverse() : entries
  if (!sortBy || !LEDGER_SORT_KEYS.includes(sortBy)) return entries
  const numeric = NUMBER_SORT_KEYS.includes(sortBy)
  const value = (e: ProductLedgerEntry): string | number | null => {
    const v = (e as any)[sortBy]
    if (numeric) return typeof v === 'number' && Number.isFinite(v) ? v : null
    return v === undefined || v === null || v === '' ? null : String(v)
  }
  return entries
    .map((e, i) => ({ e, i, v: value(e) }))
    .sort((a, b) => {
      if (a.v === null || b.v === null) return a.v === b.v ? a.i - b.i : a.v === null ? 1 : -1
      const c = numeric ? (a.v as number) - (b.v as number) : collator.compare(a.v as string, b.v as string)
      return (desc ? -c : c) || a.i - b.i
    })
    .map(x => x.e)
}

/** A bare `YYYY-MM-DD` upper bound runs to the end of that day: an invoice books its dispatch at the time it was issued. */
function endOfPeriod(dateTo: string): number {
  const t = new Date(dateTo).getTime()
  return /^\d{4}-\d{2}-\d{2}$/.test(dateTo) ? t + 86_400_000 - 1 : t
}

export async function getProductLedger(
  orgId: string,
  productId: string,
  options: ProductLedgerOptions = {},
): Promise<ProductLedgerResult> {
  const productOid = new Types.ObjectId(productId)
  const orgOid = new Types.ObjectId(orgId)
  const page = options.page ?? 0
  const size = options.size ?? 25

  // The product's whole history: the period and the contact are applied to the rows only after
  // the running balance (below), so a row's start/end quantity is the stock on either side of it
  // and not a sum that restarts at the period's first day.
  const matchFilter: Record<string, any> = {
    orgId: orgOid,
    'lines.productId': productOid,
    status: { $in: ['confirmed', 'completed'] },
  }

  // Aggregation: unwind lines, filter by productId, sort by date
  const movements = await StockMovement.aggregate([
    { $match: matchFilter },
    { $unwind: '$lines' },
    { $match: { 'lines.productId': productOid } },
    { $sort: { date: 1, _id: 1 } },
    {
      $lookup: {
        from: 'warehouses',
        localField: 'fromWarehouseId',
        foreignField: '_id',
        as: '_fromWh',
      },
    },
    {
      $lookup: {
        from: 'warehouses',
        localField: 'toWarehouseId',
        foreignField: '_id',
        as: '_toWh',
      },
    },
    {
      $lookup: {
        from: 'invoices',
        localField: 'invoiceId',
        foreignField: '_id',
        as: '_invoice',
      },
    },
    {
      $lookup: {
        from: 'contacts',
        localField: 'contactId',
        foreignField: '_id',
        as: '_contact',
      },
    },
    {
      // Also look up contact from invoice as fallback
      $lookup: {
        from: 'contacts',
        let: { invContactId: { $arrayElemAt: ['$_invoice.contactId', 0] } },
        pipeline: [
          { $match: { $expr: { $eq: ['$_id', '$$invContactId'] } } },
          { $project: { companyName: 1, firstName: 1, lastName: 1 } },
        ],
        as: '_invoiceContact',
      },
    },
    {
      $project: {
        date: 1,
        movementNumber: 1,
        type: 1,
        fromWarehouseId: 1,
        toWarehouseId: 1,
        contactId: 1,
        invoiceId: 1,
        reference: 1,
        fromWarehouseName: { $arrayElemAt: ['$_fromWh.name', 0] },
        toWarehouseName: { $arrayElemAt: ['$_toWh.name', 0] },
        invoiceNumber: { $arrayElemAt: ['$_invoice.invoiceNumber', 0] },
        contactCompanyName: { $arrayElemAt: ['$_contact.companyName', 0] },
        contactFirstName: { $arrayElemAt: ['$_contact.firstName', 0] },
        contactLastName: { $arrayElemAt: ['$_contact.lastName', 0] },
        invoiceContactCompanyName: { $arrayElemAt: ['$_invoiceContact.companyName', 0] },
        invoiceContactFirstName: { $arrayElemAt: ['$_invoiceContact.firstName', 0] },
        invoiceContactLastName: { $arrayElemAt: ['$_invoiceContact.lastName', 0] },
        invoiceContactId: { $arrayElemAt: ['$_invoice.contactId', 0] },
        quantity: '$lines.quantity',
        unitCost: '$lines.unitCost',
        totalCost: '$lines.totalCost',
      },
    },
  ])

  function buildContactName(m: any): { contactId?: string; contactName?: string } {
    // Direct contact on movement
    if (m.contactId) {
      const name = m.contactCompanyName || [m.contactFirstName, m.contactLastName].filter(Boolean).join(' ') || ''
      return { contactId: String(m.contactId), contactName: name }
    }
    // Fallback: contact from linked invoice
    if (m.invoiceContactId) {
      const name = m.invoiceContactCompanyName || [m.invoiceContactFirstName, m.invoiceContactLastName].filter(Boolean).join(' ') || ''
      return { contactId: String(m.invoiceContactId), contactName: name }
    }
    return {}
  }

  // Build ledger entries — transfers produce two rows
  const rawEntries: Omit<ProductLedgerEntry, 'runningQty' | 'runningValue'>[] = []

  for (const m of movements) {
    const docRef = m.movementNumber
    const docId = String(m._id)
    const contact = buildContactName(m)
    const base = {
      date: m.date.toISOString(),
      documentRef: docRef,
      documentId: docId,
      documentType: 'movement' as const,
      unitCost: m.unitCost,
      invoiceId: m.invoiceId ? String(m.invoiceId) : undefined,
      invoiceNumber: m.invoiceNumber || undefined,
      reference: m.reference || undefined,
      movementType: m.type,
      ...contact,
    }

    if (m.type === 'transfer') {
      // Two rows: out from source, in to destination
      const outEntry = {
        ...base,
        eventType: 'transferred_out',
        warehouseId: String(m.fromWarehouseId),
        warehouseName: m.fromWarehouseName || '',
        quantityChange: -m.quantity,
        lineTotalCost: m.totalCost,
      }
      const inEntry = {
        ...base,
        eventType: 'transferred_in',
        warehouseId: String(m.toWarehouseId),
        warehouseName: m.toWarehouseName || '',
        quantityChange: m.quantity,
        lineTotalCost: m.totalCost,
      }
      if (options.warehouseId) {
        if (options.warehouseId === String(m.fromWarehouseId)) rawEntries.push(outEntry)
        if (m.toWarehouseId && options.warehouseId === String(m.toWarehouseId)) rawEntries.push(inEntry)
      } else {
        if (m.fromWarehouseId) rawEntries.push(outEntry)
        // Only emit the in-row when the destination is a real, tracked warehouse. Transfers to an
        // untracked external store (no toWarehouseId) leave the org — the phantom in-row would
        // cancel the out-row and make the running balance ignore the dispatch.
        if (m.toWarehouseId) rawEntries.push(inEntry)
      }
    } else {
      // Determine sign and warehouse based on movement type
      const isIncoming = ['receipt', 'return', 'production_in'].includes(m.type)

      // Bug fix: adjustment movements may only have toWarehouseId (from inventory count)
      let warehouseId: string
      let warehouseName: string
      if (m.type === 'adjustment') {
        warehouseId = String(m.toWarehouseId || m.fromWarehouseId || '')
        warehouseName = (m.toWarehouseName || m.fromWarehouseName || '')
      } else {
        warehouseId = isIncoming ? String(m.toWarehouseId) : String(m.fromWarehouseId)
        warehouseName = isIncoming ? (m.toWarehouseName || '') : (m.fromWarehouseName || '')
      }

      const eventTypeMap: Record<string, string> = {
        receipt: 'received',
        dispatch: 'dispatched',
        return: 'returned',
        adjustment: 'adjusted',
        production_in: 'produced_in',
        production_out: 'produced_out',
      }

      // For adjustments, mirror the stock engine (warehouse.service.ts): a `fromWarehouseId`
      // reduces, a `toWarehouseId` adds. Inventory-count adjustments carry an already-signed
      // quantity on the to-side; book-corrections write-offs carry a positive absolute on the
      // from-side. Using the raw value (old behaviour) flipped the sign of every from-side
      // adjustment in the ledger view (the stock itself was always correct).
      let quantityChange: number
      if (m.type === 'adjustment') {
        quantityChange = m.fromWarehouseId ? -Math.abs(m.quantity) : m.quantity
      } else {
        quantityChange = isIncoming ? m.quantity : -m.quantity
      }

      const entry = {
        ...base,
        eventType: eventTypeMap[m.type] || m.type,
        warehouseId,
        warehouseName,
        quantityChange,
        lineTotalCost: m.totalCost,
      }

      if (!options.warehouseId || options.warehouseId === warehouseId) {
        rawEntries.push(entry)
      }
    }
  }

  // Also check for completed inventory counts without adjustment movements (legacy)
  const icFilter: Record<string, any> = {
    orgId: orgOid,
    'lines.productId': productOid,
    status: 'completed',
    adjustmentMovementId: { $exists: false },
  }
  if (options.warehouseId) icFilter.warehouseId = new Types.ObjectId(options.warehouseId)

  const legacyCounts = await InventoryCount.find(icFilter).sort({ date: 1 }).lean().exec()

  // Load warehouse names for legacy counts
  const whIds = [...new Set(legacyCounts.map(ic => String(ic.warehouseId)))]
  const whDocs = whIds.length ? await Warehouse.find({ _id: { $in: whIds } }).select('name').lean().exec() : []
  const whMap = new Map(whDocs.map(w => [String(w._id), (w as any).name]))

  for (const ic of legacyCounts) {
    for (const line of ic.lines) {
      if (String(line.productId) !== productId) continue
      if (line.variance === 0) continue

      rawEntries.push({
        date: ic.date.toISOString(),
        documentRef: ic.countNumber,
        documentId: String(ic._id),
        documentType: 'inventory_count',
        eventType: 'count_adjusted',
        warehouseId: String(ic.warehouseId),
        warehouseName: whMap.get(String(ic.warehouseId)) || '',
        quantityChange: line.variance,
        unitCost: line.varianceCost !== 0 && line.variance !== 0 ? Math.abs(line.varianceCost / line.variance) : 0,
        lineTotalCost: Math.abs(line.varianceCost),
      })
    }
  }

  // Sort all entries by date
  rawEntries.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime())

  // Compute running totals on FULL dataset (for running qty/value columns). Each row also
  // carries the balance on either side of it, so the ledger reads as start → change → end
  // even when the filters below hide the neighbouring rows.
  let runningQty = 0
  let runningValue = 0

  const allEntries: ProductLedgerEntry[] = rawEntries.map(e => {
    const startQty = runningQty
    runningQty += e.quantityChange
    runningValue += e.quantityChange * e.unitCost
    return { ...e, startQty, endQty: runningQty, runningQty, runningValue }
  })

  // Period, contact and event type AFTER the running totals (they stay absolute). The contact is
  // the row's own, so a movement whose customer is on its invoice counts too.
  const from = options.dateFrom ? new Date(options.dateFrom).getTime() : -Infinity
  const to = options.dateTo ? endOfPeriod(options.dateTo) : Infinity
  const filteredEntries = allEntries.filter(e => {
    const t = new Date(e.date).getTime()
    if (t < from || t > to) return false
    if (options.contactId && e.contactId !== options.contactId) return false
    if (options.eventTypes?.length && !options.eventTypes.includes(e.eventType)) return false
    return true
  })

  // Summary is computed from FILTERED entries (reflects current view)
  let totalIn = 0
  let totalOut = 0
  let filteredQty = 0
  let filteredValue = 0
  for (const e of filteredEntries) {
    if (e.quantityChange > 0) totalIn += e.quantityChange
    else totalOut += Math.abs(e.quantityChange)
    filteredQty += e.quantityChange
    filteredValue += e.quantityChange * e.unitCost
  }

  const totalEntries = filteredEntries.length

  // Sorted across every filtered row, then paginated (size=0 means return all)
  const sortedEntries = sortLedgerEntries(filteredEntries, options.sortBy, options.sortOrder)
  let paginatedEntries: ProductLedgerEntry[]
  if (size > 0) {
    const start = page * size
    paginatedEntries = sortedEntries.slice(start, start + size)
  } else {
    paginatedEntries = sortedEntries
  }

  // Compute sales summary from invoices (pass all filters)
  const salesSummary = await computeSalesSummary(orgId, productId, options.warehouseId, options.dateFrom, options.dateTo, options.contactId)

  return {
    entries: paginatedEntries,
    total: totalEntries,
    page,
    size,
    totalPages: size > 0 ? Math.ceil(totalEntries / size) : 1,
    summary: {
      totalIn,
      totalOut,
      currentQty: filteredQty,
      currentValue: filteredValue,
      ...salesSummary,
    },
  }
}

async function computeSalesSummary(
  orgId: string,
  productId: string,
  warehouseId?: string,
  dateFrom?: string,
  dateTo?: string,
  contactId?: string,
): Promise<{ totalCashRegisterSales: number; totalInvoiceSales: number; totalSales: number }> {
  const orgOid = new Types.ObjectId(orgId)
  const productOid = new Types.ObjectId(productId)

  const matchStage: Record<string, any> = {
    orgId: orgOid,
    // A cash-sale storno takes its sale back (FR-21.9).
    type: { $in: ['cash_sale', 'cash_storno', 'invoice'] },
    direction: 'outgoing',
    status: { $nin: ['draft', 'cancelled', 'voided'] },
    'lines.productId': productOid,
    ...NOT_UNPROVED_STORNO,
  }

  if (contactId) {
    matchStage.contactId = new Types.ObjectId(contactId)
  }
  // #171: a sale invoiced from a cash sale counts once (`sale-counting.ts`).
  Object.assign(matchStage, await saleScopeFilter(orgId, contactId))
  if (dateFrom || dateTo) {
    matchStage.issueDate = {} as any
    if (dateFrom) matchStage.issueDate.$gte = new Date(dateFrom)
    if (dateTo) matchStage.issueDate.$lte = new Date(dateTo)
  }

  const pipeline: any[] = [
    { $match: matchStage },
    { $unwind: '$lines' },
    { $match: { 'lines.productId': productOid } },
  ]

  if (warehouseId) {
    pipeline.push({ $match: { 'lines.warehouseId': new Types.ObjectId(warehouseId) } })
  }

  pipeline.push({
    $group: {
      _id: '$type',
      total: { $sum: '$lines.lineTotal' },
    },
  })

  try {
    const results = await Invoice.aggregate(pipeline)
    let totalCashRegisterSales = 0
    let totalInvoiceSales = 0
    for (const r of results) {
      if (r._id === 'cash_sale') totalCashRegisterSales += r.total
      else if (r._id === 'cash_storno') totalCashRegisterSales -= r.total
      else if (r._id === 'invoice') totalInvoiceSales = r.total
    }
    return {
      totalCashRegisterSales,
      totalInvoiceSales,
      totalSales: totalCashRegisterSales + totalInvoiceSales,
    }
  } catch {
    return { totalCashRegisterSales: 0, totalInvoiceSales: 0, totalSales: 0 }
  }
}
