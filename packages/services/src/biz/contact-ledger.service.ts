import { MOVEMENT_TYPES, QUOTE_TYPES, isQuoteType } from 'config/constants'
import { Invoice, Product, StockMovement } from 'db/models'
import { isDateOnly, localDayEnd, localDayStart } from './local-day.js'
import { NOT_PAYMENT_RECEIPT, NOT_UNPROVED_STORNO, saleScopeFilter } from './sale-counting.js'
import { buildProductSearchFilter, buildSearchFilter } from './search.utils.js'
import { mongoose } from 'db/connection'
const { Types } = mongoose

/**
 * A contact's ledger: every line of every document traded with them, and the stock movements behind those lines.
 *
 * A stock movement is listed one of two ways, never both:
 *   - **with its document.** The line of an invoice, a bill, a cash sale or a note names the movements that moved its
 *     goods (`movements`): the ones the document booked itself (`invoiceId`), and the ones it stands for
 *     (`stockSource.movementIds`: the receipts a bill was made from, the stock note an invoice was issued for, the
 *     dispatch of the cash sale an invoice was issued for);
 *   - **on a row of its own** (`documentType: 'stock_movement'`), when it names the contact and no document carries
 *     it: goods handed over on a stock note not invoiced yet, a delivery no bill has come for.
 *
 * The summary counts documents, as it always has: a movement owes nobody anything.
 */

/** The type a stock movement no document carries is listed under: a value of `documentTypes`, and its rows' own. */
export const STOCK_MOVEMENT_TYPE = 'stock_movement'

/** A movement that moved stock: a draft never did, and a cancelled one never will. */
const BOOKED = ['confirmed', 'completed']

export interface ContactLedgerMovement {
  id: string
  number: string
  /** What the movement is (`MOVEMENT_TYPES`): a receipt, a dispatch, a transfer, a return… */
  type: string
  /** The source document it was booked from (`sklrazp_0000615698`), when it names one. */
  reference?: string
}

export interface ContactLedgerEntry {
  date: string
  /** The document's number; empty on a `stock_movement` row, which has no document. */
  documentNumber: string
  /** The document's id; on a `stock_movement` row, the movement's. */
  documentId: string
  /** The document's type, or `stock_movement`. */
  documentType: string
  /** On a `stock_movement` row: what the movement is (`MOVEMENT_TYPES`). */
  movementType?: string
  /** The stock movements behind the row: those that moved a document line's goods, or the movement itself. */
  movements: ContactLedgerMovement[]
  productId?: string
  productName?: string
  quantity: number
  /** On a `stock_movement` row: the line's unit cost. A cost figure, absent for a role without them. */
  unitPrice?: number
  /** Absent on a `stock_movement` row: a movement carries no tax. */
  taxRate?: number
  warehouseId?: string
  warehouseName?: string
  /** On a `stock_movement` row: the line's value at cost. A cost figure, absent for a role without them. */
  lineTotal?: number
  /**
   * On a `stock_movement` row: a completed dispatch no document holds, which an invoice can be made from or linked to
   * (FR-22.62). A hint for the row's tick box: the link itself is decided by `dispatch-invoice.service.ts`.
   */
  invoiceable?: boolean
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

/**
 * FR-27.11.C.2: the ledger for a role without the cost figures. The profitability is the sales less the total cost,
 * which gives the cost back, and a row's purchase price is one. So are a stock movement's unit cost and value, which
 * its own row carries where a document's row carries a price (FR-27.11.C.1). All absent, never blank. One
 * definition, for the ledger's route and the report that reads it.
 */
export function withoutLedgerCosts<T extends { entries: any[]; summary: any }>(result: T): T {
  const { profitabilityNet: _net, profitabilityGross: _gross, ...summary } = result.summary
  const entries = result.entries.map(({ purchasePrice: _cost, ...e }: any) => {
    if (e.documentType !== STOCK_MOVEMENT_TYPE) return e
    const { unitPrice: _unit, lineTotal: _value, ...row } = e
    return row
  })
  return { ...result, entries, summary }
}

export interface ContactLedgerOptions {
  /** A calendar date (`YYYY-MM-DD`) bounds a whole day, in the shop's time; anything else is an instant. */
  dateFrom?: string
  dateTo?: string
  /** Document types, and `stock_movement` for the movements no document carries. None: everything. */
  documentTypes?: string[]
  /**
   * FR-26.6: a session without `purchases` sees the contact's outgoing documents only, and of the movements no
   * document carries, none of the purchase side: no goods receipt, and no return to the supplier.
   */
  outgoingOnly?: boolean
  /**
   * #526: only the lines of the products this text finds, matched as the Products page matches it
   * (`buildProductSearchFilter`). The rows and the summary both count those lines alone.
   */
  productSearch?: string
  /**
   * #526: only the documents whose number contains this text, case-insensitive, as the invoice list matches it. A
   * stock movement is found by its number or by the document it was booked from (`reference`), and brings the
   * document that carries it.
   */
  documentNumber?: string
  page?: number
  size?: number
}

/**
 * A period as the instants it covers. A calendar date bounds a whole day in the shop's time (`local-day.ts`): a
 * till document and a stock movement keep the moment they were made, and as the END of a period `new Date('…-12')`
 * is that day's first instant, which dropped everything made during it.
 */
function periodOf(from?: string, to?: string): { $gte?: Date; $lte?: Date } | null {
  // What is no date bounds nothing, as a filter left empty.
  const instant = (value: string) => {
    const at = new Date(value)
    return Number.isNaN(at.getTime()) ? undefined : at
  }
  const w: { $gte?: Date; $lte?: Date } = {}
  const start = from ? (isDateOnly(from) ? localDayStart(from) : instant(from)) : undefined
  const end = to ? (isDateOnly(to) ? localDayEnd(to) : instant(to)) : undefined
  if (start) w.$gte = start
  if (end) w.$lte = end
  return start || end ? w : null
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

/**
 * The documents a number search reaches through a stock movement: the ones a matching movement was booked by, and
 * the ones that stand for it. Searched among the contact's own movements and the ones its documents stand for
 * (a till sale invoiced to this customer names another contact, or none), so a text every movement number holds
 * reads only this ledger's.
 */
async function documentsOfMovementsNumbered(
  orgOid: unknown,
  contactOid: unknown,
  ledgerMatch: Record<string, any>,
  numberQuery: string,
): Promise<Record<string, any>[]> {
  const stoodFor = await Invoice.distinct('stockSource.movementIds', ledgerMatch).exec()
  const numbered = { status: { $in: BOOKED }, ...buildSearchFilter(numberQuery, ['movementNumber', 'reference']) }
  // Two reads, each bounded by an index of its own: the contact's (`orgId, type, contactId`), and those ids.
  const [own, others]: any[][] = await Promise.all([
    StockMovement.find({ orgId: orgOid, type: { $in: MOVEMENT_TYPES }, contactId: contactOid, ...numbered } as any, { invoiceId: 1 }).lean().exec(),
    stoodFor.length ? StockMovement.find({ _id: { $in: stoodFor }, orgId: orgOid, ...numbered } as any, { invoiceId: 1 }).lean().exec() : [],
  ])
  const found = [...new Map([...own, ...others].map(m => [String(m._id), m])).values()]
  if (!found.length) return []
  const bookedBy = found.map(m => m.invoiceId).filter(Boolean)
  return [
    ...(bookedBy.length ? [{ _id: { $in: bookedBy } }] : []),
    { 'stockSource.movementIds': { $in: found.map(m => m._id) } },
  ]
}

/** A movement as a row names it. */
function movementRef(m: any): ContactLedgerMovement {
  return { id: String(m._id), number: m.movementNumber || '', type: m.type || '', ...(m.reference ? { reference: m.reference } : {}) }
}

/**
 * The movements behind each document line of a page: those the document booked (`invoiceId`) and those it stands for
 * (`stockSource.movementIds`), which carry the line's article. Where some of them moved the line's own warehouse,
 * those: a document selling from two warehouses books a movement for each. Oldest first.
 */
async function movementsOfLines(orgOid: unknown, rows: any[]): Promise<(row: any) => ContactLedgerMovement[]> {
  const documents = [...new Map(rows.map(r => [String(r._id), r._id])).values()]
  const stoodFor = [...new Map(rows.flatMap(r => r.stockSource?.movementIds ?? []).map((id: unknown) => [String(id), id])).values()]
  if (!documents.length) return () => []
  const found: any[] = await StockMovement.find(
    {
      orgId: orgOid,
      status: { $in: BOOKED },
      recordOnly: { $ne: true },
      $or: [{ invoiceId: { $in: documents } }, ...(stoodFor.length ? [{ _id: { $in: stoodFor } }] : [])],
    } as any,
    { movementNumber: 1, type: 1, reference: 1, invoiceId: 1, fromWarehouseId: 1, toWarehouseId: 1, date: 1, 'lines.productId': 1 },
  ).sort({ date: 1, _id: 1 }).lean().exec()

  return (row) => {
    if (!row.productId) return []
    const product = String(row.productId)
    const named = new Set((row.stockSource?.movementIds ?? []).map(String))
    const carrying = found.filter(m =>
      (String(m.invoiceId ?? '') === String(row._id) || named.has(String(m._id)))
      && (m.lines || []).some((l: any) => String(l.productId) === product))
    const warehouse = row.warehouseId ? String(row.warehouseId) : ''
    const there = warehouse
      ? carrying.filter(m => String(m.fromWarehouseId ?? '') === warehouse || String(m.toWarehouseId ?? '') === warehouse)
      : []
    return (there.length ? there : carrying).map(movementRef)
  }
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
  const types = options.documentTypes?.length ? options.documentTypes : null
  const period = periodOf(options.dateFrom, options.dateTo)

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

  if (types) matchStage.type = { $in: types.filter(t => t !== STOCK_MOVEMENT_TYPE) }
  if (options.outgoingOnly) matchStage.direction = 'outgoing'
  if (period) matchStage.issueDate = period

  // The movements no document carries. One claimed by a bill still in draft is among them: a draft is no row of the
  // ledger, and the delivery it will pay for happened. So is a stock note claimed by a draft invoice (FR-22.61).
  // ⚠ Only a claim (`movement:`, `dispatch:`): a draft invoice for a cash sale lists that sale's own dispatch, which
  // the sale's row carries.
  const listsMovements = !types || types.includes(STOCK_MOVEMENT_TYPE)
  const heldByDrafts = listsMovements
    ? await Invoice.distinct('stockSource.movementIds', {
        orgId: orgOid, contactId: contactOid, type: 'invoice', status: 'draft',
        'stockSource.marker': { $regex: '^(movement|dispatch):' },
        ...(options.outgoingOnly ? { direction: 'outgoing' } : {}),
      } as any).exec()
    : []
  const movementMatch: Record<string, any> = {
    orgId: orgOid,
    // Every type by name, so the supplier index (`orgId, type, contactId`) bounds the read.
    type: { $in: MOVEMENT_TYPES.filter(t => !(options.outgoingOnly && t === 'receipt')) },
    contactId: contactOid,
    status: { $in: BOOKED },
    // A record of goods another movement moved (FR-21.4), and one rolled back with its document: neither holds goods.
    recordOnly: { $ne: true },
    reversedBy: null,
    $or: [{ invoiceId: null }, ...(heldByDrafts.length ? [{ _id: { $in: heldByDrafts } }] : [])],
  }
  // FR-26.6: with the receipts (left out by type above), goods sent back to the supplier are the purchase side.
  if (options.outgoingOnly) movementMatch.$nor = [{ type: 'return', fromWarehouseId: { $ne: null } }]
  if (period) movementMatch.date = period

  // #526: the two searches only narrow what the filters above let through. They go in an `$and`, never under a key of
  // their own, so they cannot replace one: a session limited to outgoing documents finds no bill by either.
  const narrowing: Record<string, any>[] = []
  const movementNarrowing: Record<string, any>[] = []
  const numberQuery = options.documentNumber?.trim()
  if (numberQuery) {
    // Read before the narrowing joins `matchStage`: the documents of this ledger, whatever is searched for.
    const throughMovement = await documentsOfMovementsNumbered(orgOid, contactOid, matchStage, numberQuery)
    const byNumber = buildSearchFilter(numberQuery, ['invoiceNumber'])
    narrowing.push(throughMovement.length ? { $or: [byNumber, ...throughMovement] } : byNumber)
    movementNarrowing.push(buildSearchFilter(numberQuery, ['movementNumber', 'reference']))
  }
  let productIds: unknown[] | null = null
  const productQuery = options.productSearch?.trim()
  if (productQuery) {
    // The tenant plugin filters nothing: the org is named here.
    const found = await Product.find({ orgId: orgOid, ...buildProductSearchFilter(productQuery) }, { _id: 1 }).lean().exec()
    productIds = found.map((p: any) => p._id)
    narrowing.push({ 'lines.productId': { $in: productIds } })
    movementNarrowing.push({ 'lines.productId': { $in: productIds } })
  }
  if (narrowing.length) matchStage.$and = [...(matchStage.$and ?? []), ...narrowing]
  if (movementNarrowing.length) movementMatch.$and = movementNarrowing
  // A row is a line: with a product search, a line of a product it found.
  const lineMatch: any[] = productIds ? [{ $match: { 'lines.productId': { $in: productIds } } }] : []

  const rows: any[] = [
    { $match: matchStage },
    // The line's place in its document breaks the sort's ties, so a page ends on the same line every time.
    { $unwind: { path: '$lines', includeArrayIndex: '_line' } },
    ...lineMatch,
    // Only what a row is made of goes on to the sort: a contact's whole history is sorted for one page of it, and
    // an unwound line carried its whole document along (a movement's line its staged prices too).
    {
      $project: {
        issueDate: 1, invoiceNumber: 1, type: 1, _line: 1, 'stockSource.movementIds': 1,
        'lines.productId': 1, 'lines.quantity': 1, 'lines.unitPrice': 1, 'lines.taxRate': 1, 'lines.lineTotal': 1, 'lines.warehouseId': 1,
      },
    },
    // The movements no document carries join the documents' lines, each line a row, at the day it was booked.
    ...(listsMovements ? [{
      $unionWith: {
        coll: StockMovement.collection.name,
        pipeline: [
          { $match: movementMatch },
          { $unwind: { path: '$lines', includeArrayIndex: '_line' } },
          ...lineMatch,
          {
            $project: {
              issueDate: '$date', _movement: { $literal: true }, type: 1, _line: 1, movementNumber: 1, reference: 1,
              fromWarehouseId: 1, toWarehouseId: 1, status: 1, invoiceId: 1,
              'lines.productId': 1, 'lines.quantity': 1, 'lines.unitCost': 1, 'lines.totalCost': 1,
            },
          },
        ],
      },
    }] : []),
  ]

  const pipeline: any[] = [
    ...rows,
    { $sort: { issueDate: -1, _id: -1, _line: 1 } },
    // The page is cut before the lookups, which then run for its rows alone.
    ...(size > 0 ? [{ $skip: page * size }, { $limit: size }] : []),
    // A document's line names its warehouse; a movement is out of one, or into one.
    { $addFields: { _warehouseId: { $ifNull: ['$lines.warehouseId', { $ifNull: ['$fromWarehouseId', '$toWarehouseId'] }] } } },
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
        localField: '_warehouseId',
        foreignField: '_id',
        as: '_warehouse',
      },
    },
    {
      $project: {
        issueDate: 1,
        invoiceNumber: 1,
        type: 1,
        _movement: 1,
        movementNumber: 1,
        reference: 1,
        // Of a movement's row: whether it is a stock note an invoice can still take (`invoiceable`).
        _held: { $cond: ['$_movement', { $ifNull: ['$invoiceId', null] }, '$$REMOVE'] },
        _completed: { $cond: ['$_movement', { $eq: ['$status', 'completed'] }, '$$REMOVE'] },
        _from: { $cond: ['$_movement', { $ifNull: ['$fromWarehouseId', null] }, '$$REMOVE'] },
        'stockSource.movementIds': 1,
        productId: '$lines.productId',
        productName: { $arrayElemAt: ['$_product.name', 0] },
        quantity: '$lines.quantity',
        unitPrice: '$lines.unitPrice',
        taxRate: '$lines.taxRate',
        lineTotal: '$lines.lineTotal',
        // A movement's line is valued at cost.
        unitCost: '$lines.unitCost',
        totalCost: '$lines.totalCost',
        warehouseId: '$_warehouseId',
        warehouseName: { $arrayElemAt: ['$_warehouse.name', 0] },
      },
    },
  ]

  const countPipeline = [...rows, { $count: 'total' }]
  const countResult = await Invoice.aggregate(countPipeline)
  const total = countResult[0]?.total ?? 0

  const docs = await Invoice.aggregate(pipeline)
  const movementsOf = await movementsOfLines(orgOid, docs.filter(d => !d._movement))

  const entries: ContactLedgerEntry[] = docs.map(d => {
    const line = {
      productId: d.productId ? String(d.productId) : undefined,
      productName: d.productName || '',
      quantity: d.quantity || 0,
    }
    const warehouse = {
      warehouseId: d.warehouseId ? String(d.warehouseId) : undefined,
      warehouseName: d.warehouseName || '',
    }
    if (d._movement) {
      // Goods that come back take their value back, as a credit note's line does.
      const sign = d.type === 'return' ? -1 : 1
      return {
        date: d.issueDate?.toISOString() || '',
        documentNumber: '',
        documentId: String(d._id),
        documentType: STOCK_MOVEMENT_TYPE,
        movementType: d.type || '',
        movements: [movementRef(d)],
        ...line,
        unitPrice: sign * (d.unitCost || 0) || 0,
        ...warehouse,
        lineTotal: sign * (d.totalCost || 0) || 0,
        ...(d.type === 'dispatch' && d._completed && d._from && !d._held ? { invoiceable: true } : {}),
      }
    }
    // Credit notes and cash-sale stornos (FR-21.9) give money back: negative sign
    const sign = d.type === 'credit_note' || d.type === 'cash_storno' ? -1 : 1
    return {
      date: d.issueDate?.toISOString() || '',
      documentNumber: d.invoiceNumber || '',
      documentId: String(d._id),
      documentType: d.type || '',
      movements: movementsOf(d),
      ...line,
      unitPrice: sign * (d.unitPrice || 0) || 0,
      taxRate: d.taxRate || 0,
      ...warehouse,
      lineTotal: sign * (d.lineTotal || 0) || 0,
    }
  })

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
    // A quote (a proforma, an offer) is listed, and is no sale (FR-22.22): an offer converted into a proforma and
    // that into an invoice counted the same deal three times.
    if (isQuoteType(r._id.type)) continue
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
        $and: [...(matchStage.$and ?? []), { type: { $nin: ['credit_note', 'payment_receipt', 'payment_storno', ...QUOTE_TYPES] } }],
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
