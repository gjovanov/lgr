import { StockMovement, InventoryCount, Warehouse, Invoice } from 'db/models'
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
  runningQty: number
  runningValue: number
  invoiceId?: string
  invoiceNumber?: string
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
  page?: number
  size?: number
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

  // Build match filter
  const matchFilter: Record<string, any> = {
    orgId: orgOid,
    'lines.productId': productOid,
    status: { $in: ['confirmed', 'completed'] },
  }
  if (options.contactId) {
    matchFilter.contactId = new Types.ObjectId(options.contactId)
  }
  if (options.dateFrom || options.dateTo) {
    matchFilter.date = {}
    if (options.dateFrom) matchFilter.date.$gte = new Date(options.dateFrom)
    if (options.dateTo) matchFilter.date.$lte = new Date(options.dateTo)
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
        if (options.warehouseId === String(m.toWarehouseId)) rawEntries.push(inEntry)
      } else {
        rawEntries.push(outEntry, inEntry)
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

      // For adjustments, quantity can be positive or negative already
      let quantityChange: number
      if (m.type === 'adjustment') {
        quantityChange = m.quantity // signed as-is
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
  if (options.dateFrom || options.dateTo) {
    icFilter.date = {}
    if (options.dateFrom) icFilter.date.$gte = new Date(options.dateFrom)
    if (options.dateTo) icFilter.date.$lte = new Date(options.dateTo)
  }

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

  // Compute running totals on FULL dataset (for running qty/value columns)
  let runningQty = 0
  let runningValue = 0

  const allEntries: ProductLedgerEntry[] = rawEntries.map(e => {
    runningQty += e.quantityChange
    runningValue += e.quantityChange * e.unitCost
    return { ...e, runningQty, runningValue }
  })

  // Apply event type filter AFTER computing running totals (preserves absolute running totals)
  let filteredEntries = allEntries
  if (options.eventTypes?.length) {
    filteredEntries = allEntries.filter(e => options.eventTypes!.includes(e.eventType))
  }

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

  // Paginate (size=0 means return all)
  let paginatedEntries: ProductLedgerEntry[]
  if (size > 0) {
    const start = page * size
    paginatedEntries = filteredEntries.slice(start, start + size)
  } else {
    paginatedEntries = filteredEntries
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
    type: { $in: ['cash_sale', 'invoice'] },
    direction: 'outgoing',
    status: { $nin: ['draft', 'cancelled', 'voided'] },
    'lines.productId': productOid,
  }

  if (contactId) {
    matchStage.contactId = new Types.ObjectId(contactId)
  }
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
      if (r._id === 'cash_sale') totalCashRegisterSales = r.total
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
