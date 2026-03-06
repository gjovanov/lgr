import { StockMovement, InventoryCount, Warehouse } from 'db/models'
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
  summary: {
    totalIn: number
    totalOut: number
    currentQty: number
    currentValue: number
  }
}

export async function getProductLedger(
  orgId: string,
  productId: string,
  options: { warehouseId?: string; dateFrom?: string; dateTo?: string } = {},
): Promise<ProductLedgerResult> {
  const productOid = new Types.ObjectId(productId)

  // Build match filter
  const matchFilter: Record<string, any> = {
    orgId: new Types.ObjectId(orgId),
    'lines.productId': productOid,
    status: { $in: ['confirmed', 'completed'] },
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
      $project: {
        date: 1,
        movementNumber: 1,
        type: 1,
        fromWarehouseId: 1,
        toWarehouseId: 1,
        invoiceId: 1,
        fromWarehouseName: { $arrayElemAt: ['$_fromWh.name', 0] },
        toWarehouseName: { $arrayElemAt: ['$_toWh.name', 0] },
        invoiceNumber: { $arrayElemAt: ['$_invoice.invoiceNumber', 0] },
        quantity: '$lines.quantity',
        unitCost: '$lines.unitCost',
        totalCost: '$lines.totalCost',
      },
    },
  ])

  // Build ledger entries — transfers produce two rows
  const rawEntries: Omit<ProductLedgerEntry, 'runningQty' | 'runningValue'>[] = []

  for (const m of movements) {
    const docRef = m.movementNumber
    const docId = String(m._id)
    const base = {
      date: m.date.toISOString(),
      documentRef: docRef,
      documentId: docId,
      documentType: 'movement' as const,
      unitCost: m.unitCost,
      invoiceId: m.invoiceId ? String(m.invoiceId) : undefined,
      invoiceNumber: m.invoiceNumber || undefined,
      movementType: m.type,
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
      const warehouseId = isIncoming ? String(m.toWarehouseId) : String(m.fromWarehouseId)
      const warehouseName = isIncoming ? (m.toWarehouseName || '') : (m.fromWarehouseName || '')

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
    orgId: new Types.ObjectId(orgId),
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

  // Compute running totals
  let runningQty = 0
  let runningValue = 0
  let totalIn = 0
  let totalOut = 0

  const entries: ProductLedgerEntry[] = rawEntries.map(e => {
    runningQty += e.quantityChange
    runningValue += e.quantityChange * e.unitCost
    if (e.quantityChange > 0) totalIn += e.quantityChange
    else totalOut += Math.abs(e.quantityChange)

    return {
      ...e,
      runningQty,
      runningValue,
    }
  })

  return {
    entries,
    total: entries.length,
    summary: {
      totalIn,
      totalOut,
      currentQty: runningQty,
      currentValue: runningValue,
    },
  }
}
