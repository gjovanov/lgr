import { Invoice } from 'db/models'
import { mongoose } from 'db/connection'
const { Types } = mongoose

export interface ContactLedgerEntry {
  date: string
  documentNumber: string
  documentId: string
  documentType: string
  productId?: string
  productName?: string
  quantity: number
  unitPrice: number
  taxRate: number
  warehouseId?: string
  warehouseName?: string
  lineTotal: number
}

export interface ContactLedgerResult {
  entries: ContactLedgerEntry[]
  total: number
  page: number
  size: number
  totalPages: number
  summary: {
    totalSales: number
    totalPurchases: number
    balance: number
  }
}

export interface ContactLedgerOptions {
  dateFrom?: string
  dateTo?: string
  documentTypes?: string[]
  page?: number
  size?: number
}

export async function getContactLedger(
  orgId: string,
  contactId: string,
  options: ContactLedgerOptions = {},
): Promise<ContactLedgerResult> {
  const orgOid = new Types.ObjectId(orgId)
  const contactOid = new Types.ObjectId(contactId)
  const page = options.page ?? 0
  const size = options.size ?? 25

  const matchStage: Record<string, any> = {
    orgId: orgOid,
    contactId: contactOid,
    status: { $nin: ['draft', 'cancelled', 'voided'] },
  }

  if (options.documentTypes?.length) {
    matchStage.type = { $in: options.documentTypes }
  }
  if (options.dateFrom || options.dateTo) {
    matchStage.issueDate = {} as any
    if (options.dateFrom) matchStage.issueDate.$gte = new Date(options.dateFrom)
    if (options.dateTo) matchStage.issueDate.$lte = new Date(options.dateTo)
  }

  const pipeline: any[] = [
    { $match: matchStage },
    { $unwind: '$lines' },
    { $sort: { issueDate: -1, _id: -1 } },
    {
      $lookup: {
        from: 'products',
        localField: 'lines.productId',
        foreignField: '_id',
        as: '_product',
      },
    },
    {
      $lookup: {
        from: 'warehouses',
        localField: 'lines.warehouseId',
        foreignField: '_id',
        as: '_warehouse',
      },
    },
    {
      $project: {
        issueDate: 1,
        invoiceNumber: 1,
        type: 1,
        direction: 1,
        productId: '$lines.productId',
        productName: { $arrayElemAt: ['$_product.name', 0] },
        quantity: '$lines.quantity',
        unitPrice: '$lines.unitPrice',
        taxRate: '$lines.taxRate',
        warehouseId: '$lines.warehouseId',
        warehouseName: { $arrayElemAt: ['$_warehouse.name', 0] },
        lineTotal: '$lines.lineTotal',
      },
    },
  ]

  // Get total count
  const countPipeline = [...pipeline, { $count: 'total' }]
  const countResult = await Invoice.aggregate(countPipeline)
  const total = countResult[0]?.total ?? 0

  // Paginate
  if (size > 0) {
    pipeline.push({ $skip: page * size })
    pipeline.push({ $limit: size })
  }

  const docs = await Invoice.aggregate(pipeline)

  const entries: ContactLedgerEntry[] = docs.map(d => ({
    date: d.issueDate?.toISOString() || '',
    documentNumber: d.invoiceNumber || '',
    documentId: String(d._id),
    documentType: d.type || '',
    productId: d.productId ? String(d.productId) : undefined,
    productName: d.productName || '',
    quantity: d.quantity || 0,
    unitPrice: d.unitPrice || 0,
    taxRate: d.taxRate || 0,
    warehouseId: d.warehouseId ? String(d.warehouseId) : undefined,
    warehouseName: d.warehouseName || '',
    lineTotal: d.lineTotal || 0,
  }))

  // Compute summary from all matching invoices (not paginated)
  const summaryPipeline: any[] = [
    { $match: matchStage },
    {
      $group: {
        _id: '$direction',
        total: { $sum: '$total' },
      },
    },
  ]

  const summaryResult = await Invoice.aggregate(summaryPipeline)
  let totalSales = 0
  let totalPurchases = 0
  for (const r of summaryResult) {
    if (r._id === 'outgoing') totalSales = r.total
    else if (r._id === 'incoming') totalPurchases = r.total
  }

  return {
    entries,
    total,
    page,
    size,
    totalPages: size > 0 ? Math.ceil(total / size) : 1,
    summary: {
      totalSales,
      totalPurchases,
      balance: totalSales - totalPurchases,
    },
  }
}
