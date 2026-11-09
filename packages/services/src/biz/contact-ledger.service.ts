import { Invoice, Product } from 'db/models'
import { NOT_PAYMENT_RECEIPT, NOT_UNPROVED_STORNO, saleScopeFilter } from './sale-counting.js'
import { buildProductSearchFilter, buildSearchFilter } from './search.utils.js'
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

export interface ContactLedgerSummary {
  totalSales: number
  totalPurchases: number
  balance: number
  totalSalesNet: number
  totalTax: number
  totalSalesGross: number
  totalCreditNotes: number
  profitabilityNet: number
  profitabilityGross: number
}

export interface ContactLedgerResult {
  entries: ContactLedgerEntry[]
  total: number
  page: number
  size: number
  totalPages: number
  summary: ContactLedgerSummary
}

export interface ContactLedgerOptions {
  dateFrom?: string
  dateTo?: string
  documentTypes?: string[]
  /** FR-26.6: a session without `purchases` sees the contact's outgoing documents only. */
  outgoingOnly?: boolean
  /**
   * #526: only the lines of the products this text finds, matched as the Products page matches it
   * (`buildProductSearchFilter`). The rows and the summary both count those lines alone.
   */
  productSearch?: string
  /** #526: only the documents whose number contains this text, case-insensitive, as the invoice list matches it. */
  documentNumber?: string
  page?: number
  size?: number
}

/**
 * A line's money from its terms, as the document forms reckon it (`config/line-amounts`): what it weighs among its
 * document's lines. `l` is the line's path in the pipeline (`$lines`, `$$l`).
 */
function lineWeights(l: string): { net: any; tax: any; gross: any } {
  const n = (field: string) => ({ $ifNull: [`${l}.${field}`, 0] })
  const net = { $multiply: [n('quantity'), n('unitPrice')] }
  const taxable = { $multiply: [net, { $subtract: [1, { $divide: [n('discount'), 100] }] }] }
  const rate = { $divide: [n('taxRate'), 100] }
  return { net, tax: { $multiply: [taxable, rate] }, gross: { $multiply: [taxable, { $add: [1, rate] }] } }
}

/**
 * #526: the summary rows of the lines a product search found, in the shape of the documents' own
 * (`{ _id: { direction, type }, subtotal, taxTotal, total }`).
 *
 * Each line takes the share of its document's net, VAT and gross that its terms weigh among all the document's
 * lines. The stored line amounts are not read, because they do not mean one thing: an imported line's `lineTotal`
 * is net where a form's is gross (`document-amounts.ts`). So a document whose every line matches counts exactly as
 * the unfiltered summary counts it, and the rest of the document's money stays out.
 */
function productLinesSummary(matchStage: Record<string, any>, productIds: unknown[]): any[] {
  const all = (k: 'net' | 'tax' | 'gross') => ({ $sum: { $map: { input: '$lines', as: 'l', in: lineWeights('$$l')[k] } } })
  const share = (k: 'net' | 'tax' | 'gross', amount: string) => ({
    $cond: [
      { $eq: [`$_weights.${k}`, 0] },
      0,
      { $multiply: [{ $ifNull: [amount, 0] }, { $divide: [lineWeights('$lines')[k], `$_weights.${k}`] }] },
    ],
  })
  return [
    { $match: matchStage },
    { $addFields: { _weights: { net: all('net'), tax: all('tax'), gross: all('gross') } } },
    { $unwind: '$lines' },
    { $match: { 'lines.productId': { $in: productIds } } },
    {
      $group: {
        _id: { direction: '$direction', type: '$type' },
        subtotal: { $sum: share('net', '$subtotal') },
        taxTotal: { $sum: share('tax', '$taxTotal') },
        total: { $sum: share('gross', '$total') },
      },
    },
  ]
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
    // #171: the sale is this customer's on the invoice issued to them; a cash sale of theirs that
    // was invoiced (to them or anyone) no longer counts here.
    ...(await saleScopeFilter(orgId, contactId)),
    // FR-23: nor does the receipt of a payment on an invoice: the invoice is that sale.
    ...NOT_PAYMENT_RECEIPT,
    ...NOT_UNPROVED_STORNO,
  }

  if (options.documentTypes?.length) {
    matchStage.type = { $in: options.documentTypes }
  }
  if (options.outgoingOnly) matchStage.direction = 'outgoing'
  if (options.dateFrom || options.dateTo) {
    matchStage.issueDate = {} as any
    if (options.dateFrom) matchStage.issueDate.$gte = new Date(options.dateFrom)
    if (options.dateTo) matchStage.issueDate.$lte = new Date(options.dateTo)
  }

  // #526: the two searches only narrow what the filters above let through. They go in an `$and`, never under a key of
  // their own, so they cannot replace one: a session limited to outgoing documents finds no bill by either.
  const narrowing: Record<string, any>[] = []
  const numberQuery = options.documentNumber?.trim()
  if (numberQuery) narrowing.push(buildSearchFilter(numberQuery, ['invoiceNumber']))
  let productIds: unknown[] | null = null
  const productQuery = options.productSearch?.trim()
  if (productQuery) {
    // The tenant plugin filters nothing: the org is named here.
    const found = await Product.find({ orgId: orgOid, ...buildProductSearchFilter(productQuery) }, { _id: 1 }).lean().exec()
    productIds = found.map((p: any) => p._id)
    narrowing.push({ 'lines.productId': { $in: productIds } })
  }
  if (narrowing.length) matchStage.$and = [...(matchStage.$and ?? []), ...narrowing]
  // A row is a line: with a product search, a line of a product it found.
  const lineMatch: any[] = productIds ? [{ $match: { 'lines.productId': { $in: productIds } } }] : []

  const rows: any[] = [
    { $match: matchStage },
    // The line's place in its document breaks the sort's ties, so a page ends on the same line every time.
    { $unwind: { path: '$lines', includeArrayIndex: '_line' } },
    ...lineMatch,
  ]

  const pipeline: any[] = [
    ...rows,
    { $sort: { issueDate: -1, _id: -1, _line: 1 } },
    // The page is cut before the lookups, which then run for its rows alone.
    ...(size > 0 ? [{ $skip: page * size }, { $limit: size }] : []),
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
      $addFields: {
        // Credit notes and cash-sale stornos (FR-21.9) give money back: negative sign
        _sign: { $cond: [{ $in: ['$type', ['credit_note', 'cash_storno']] }, -1, 1] },
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
        purchasePrice: { $arrayElemAt: ['$_product.purchasePrice', 0] },
        quantity: '$lines.quantity',
        unitPrice: { $multiply: ['$lines.unitPrice', '$_sign'] },
        taxRate: '$lines.taxRate',
        warehouseId: '$lines.warehouseId',
        warehouseName: { $arrayElemAt: ['$_warehouse.name', 0] },
        lineTotal: { $multiply: ['$lines.lineTotal', '$_sign'] },
      },
    },
  ]

  const countPipeline = [...rows, { $count: 'total' }]
  const countResult = await Invoice.aggregate(countPipeline)
  const total = countResult[0]?.total ?? 0

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

  // Compute expanded summary from all matching invoices (not paginated); with a product search, from their lines of it.
  const summaryPipeline: any[] = productIds ? productLinesSummary(matchStage, productIds) : [
    { $match: matchStage },
    {
      $group: {
        _id: { direction: '$direction', type: '$type' },
        subtotal: { $sum: '$subtotal' },
        taxTotal: { $sum: '$taxTotal' },
        total: { $sum: '$total' },
      },
    },
  ]

  const summaryResult = await Invoice.aggregate(summaryPipeline)

  let totalSalesNet = 0
  let totalTax = 0
  let totalSalesGross = 0
  let totalCreditNotes = 0
  let totalPurchases = 0

  for (const r of summaryResult) {
    if (r._id.direction === 'outgoing') {
      if (r._id.type === 'credit_note') {
        totalCreditNotes += r.total
      } else if (r._id.type === 'cash_storno') {
        // A cash-sale storno takes its sale back, exactly (FR-21.9).
        totalSalesNet -= r.subtotal
        totalTax -= r.taxTotal
        totalSalesGross -= r.total
      } else {
        totalSalesNet += r.subtotal
        totalTax += r.taxTotal
        totalSalesGross += r.total
      }
    } else if (r._id.direction === 'incoming') {
      // Incoming credit notes reduce what we owe/bought, mirroring the outgoing side.
      if (r._id.type === 'credit_note') totalPurchases -= r.total
      else totalPurchases += r.total
    }
  }

  // Subtract credit notes from sales
  totalSalesGross -= totalCreditNotes
  totalSalesNet -= totalCreditNotes // approximation: credit note subtotal not tracked separately

  // Compute profitability based on purchasePrice of products sold
  const costPipeline: any[] = [
    // The receipts and the credit notes in an `$and`, beside the `type` `matchStage` carries: a `type` key of its own
    // here replaced that one, so under a Type filter the cost was the cost of every type sold.
    {
      $match: {
        ...matchStage,
        direction: 'outgoing',
        $and: [...(matchStage.$and ?? []), { type: { $nin: ['credit_note', 'payment_receipt', 'payment_storno'] } }],
      },
    },
    { $unwind: '$lines' },
    ...lineMatch,
    {
      $lookup: {
        from: 'products',
        localField: 'lines.productId',
        foreignField: '_id',
        as: '_product',
      },
    },
    {
      $project: {
        cost: {
          $multiply: [
            // A cash-sale storno brings the goods back (FR-21.9).
            { $cond: [{ $eq: ['$type', 'cash_storno'] }, -1, 1] },
            '$lines.quantity',
            { $ifNull: [{ $arrayElemAt: ['$_product.purchasePrice', 0] }, 0] },
          ],
        },
      },
    },
    { $group: { _id: null, totalCost: { $sum: '$cost' } } },
  ]

  const costResult = await Invoice.aggregate(costPipeline)
  const totalCost = costResult[0]?.totalCost ?? 0

  const totalSales = totalSalesGross
  const balance = totalSales - totalPurchases

  return {
    entries,
    total,
    page,
    size,
    totalPages: size > 0 ? Math.ceil(total / size) : 1,
    summary: {
      totalSales,
      totalPurchases,
      balance,
      totalSalesNet,
      totalTax,
      totalSalesGross,
      totalCreditNotes,
      profitabilityNet: totalSalesNet - totalCost,
      profitabilityGross: totalSalesGross - totalCost,
    },
  }
}
