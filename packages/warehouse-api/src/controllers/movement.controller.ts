import { Elysia, t } from 'elysia'
import { movementWarehouseRefusal } from 'config/movement-warehouses'
import { sideIsExternal } from 'config/external-warehouse'
import { chooseListSort } from 'config/list-sorts'
import { listProjection } from 'config/list-rows'
import { can, grantOf } from 'services/biz/access/evaluate'
import { seesBills } from 'services/biz/access/partition'
import { redactMovementLine, redactMovementTotals, seesCosts, sortsByMovementTotal } from 'config/access'
import { AppAuthService } from '../auth/app-auth.service.js'
import { writesTransfersOnly } from '../lib/movement-access.js'
import { getRepos } from 'services/context'
import { confirmMovement, MovementClaimedError, MovementNotDraftError, unclaimedMovement } from 'services/biz/warehouse.service'
import { DocFile, Invoice, StockMovement } from 'db/models'
import { createMovementWithProductUpdates, updateMovementWithProductUpdates, GRValidationError } from 'services/biz/movement-with-update.service'
import { createNumberedMovement, withMovementNumber } from 'services/biz/movement-number'
import { nextCountNumber } from 'services/biz/count-number'
import { createAuditEntry } from 'services/biz/audit-log.service'
import { isRequestIdTaken, readCreateRequestId } from 'services/biz/create-request-id'
import { IdempotencyError } from 'services/biz/hot-path-key'
import { buildSearchFilter } from 'services/biz/search.utils'
import { buildProductListFilter, hasProductListFilter, productIdsMatching } from 'services/biz/product-list-filter'
import { findPageSortedBy } from 'services/biz/sorted-page'
import { billingByMovement, receiptBillingFor } from 'services/biz/receipt-bill.service'
import { dispatchInvoicingFor, invoicingByMovement } from 'services/biz/dispatch-invoice.service'
import { movementExternalSides } from 'services/biz/external-warehouses'
import { renderStockMovementPdf } from 'services/biz/stock-movement-document.service'

/** FR-22.61: the live sales invoice that holds a dispatch, as a list row and the movement page name it. */
function saleOf(holder: { id: string; number: string; status: string; type: string; direction: string } | undefined): { id: string; number: string } | undefined {
  if (!holder || holder.type !== 'invoice' || holder.direction !== 'outgoing' || ['voided', 'cancelled'].includes(holder.status)) return undefined
  return { id: holder.id, number: holder.number }
}

/**
 * What the Movements list's columns sort by: `config/list-sorts` (FR-30.2), where two print a field under another
 * name. Three print the name of what the movement points at, which only an aggregation can order by.
 */
const refName = (from: string, localField: string, name: unknown) => [
  { $lookup: { from, localField, foreignField: '_id', as: '_ref' } },
  { $addFields: { sortKey: name } },
]
/** A side's warehouse as the list names it: the one whose stock moved, else the external one a completed movement keeps apart. */
const sideName = (stock: string, external: string) => [
  { $addFields: { _side: { $ifNull: [`$${stock}`, `$${external}`] } } },
  ...refName('warehouses', '_side', { $first: '$_ref.name' }),
]
const MOVEMENT_SORT_BY_REF: Record<string, Record<string, unknown>[]> = {
  fromWarehouseName: sideName('fromWarehouseId', 'externalFromWarehouseId'),
  toWarehouseName: sideName('toWarehouseId', 'externalToWarehouseId'),
  // As the list prints it: the company, else the person's first and last name.
  contactName: refName('contacts', 'contactId', {
    $let: {
      vars: { c: { $first: '$_ref' } },
      in: {
        $cond: [
          { $gt: [{ $strLenCP: { $ifNull: ['$$c.companyName', ''] } }, 0] },
          '$$c.companyName',
          { $trim: { input: { $concat: [{ $ifNull: ['$$c.firstName', ''] }, ' ', { $ifNull: ['$$c.lastName', ''] }] } } },
        ],
      },
    },
  }),
}

/** An id no contact has: what a `contactId` that is no id is read as, so it finds nothing. */
const NO_CONTACT = '000000000000000000000000'

/**
 * FR-26.7: a session that writes movements through `inventory.transfer` alone (a Seller) writes
 * transfers and nothing else. `inventory.write` keeps every type; `admin` is refused nothing.
 * The rule itself is `lib/movement-access.ts#writesTransfersOnly`, which the list's mail asks too.
 */
function transferOnly(user: { role?: string; permissions?: readonly string[] }): boolean {
  return writesTransfersOnly(grantOf(user as any))
}

const TRANSFER_ONLY = { code: 'transfer_only', message: 'Your role moves stock between warehouses only: a transfer.' } as const

/**
 * FR-29.13: the request's id (`Idempotency-Key`), or the refusal of a malformed one (a 400). `{}` when none was sent:
 * the create is today's.
 */
function requestIdOf(headers: Record<string, string | undefined>): { id?: string; refusal?: { code: string; message: string } } {
  try {
    return { id: readCreateRequestId(headers) }
  } catch (e) {
    if (e instanceof IdempotencyError) return { refusal: { code: e.code, message: e.message } }
    throw e
  }
}

/**
 * #493, FR-26.6 `purchases`: the incoming documents these movements point at, for a session
 * without the area; empty for one that has it (nothing is hidden from it). One query per call.
 */
async function hiddenBills(user: { role?: string; areas?: readonly string[] }, orgId: string, movements: any[]): Promise<Set<string>> {
  if (seesBills(user as any)) return new Set()
  const ids = [...new Set(movements.map(m => m.invoiceId).filter(Boolean).map(String))].filter(id => /^[0-9a-f]{24}$/i.test(id))
  if (!ids.length) return new Set()
  const bills = await Invoice.find({ _id: { $in: ids }, orgId, direction: 'incoming' } as any, { _id: 1 }).lean().exec()
  return new Set(bills.map((b: any) => String(b._id)))
}

/**
 * A bill does not exist for a session without `purchases`, so a movement it reads names none: no
 * `invoiceId` when that is a bill's, and no `bill`. The bill itself already answers 404 to such a
 * session, and its number should not show here either. A link to a sales document stays.
 */
function withoutBill<T extends Record<string, any>>(hidden: Set<string>, m: T): T {
  if (!m.invoiceId || !hidden.has(String(m.invoiceId))) return m
  const { invoiceId: _bill, bill: _named, ...rest } = m
  return rest as T
}

/** Why a transfer-only session may not write this movement, with its status, or null. */
function transferRefusal(
  user: { role?: string; permissions?: readonly string[] },
  m: { type?: string; fromWarehouseId?: unknown; toWarehouseId?: unknown },
  opts: { warehouses?: boolean } = {},
): { status: 403 | 422; body: { code: string; message: string } } | null {
  if (!transferOnly(user)) return null
  if (m.type !== 'transfer') return { status: 403, body: TRANSFER_ONLY }
  if (opts.warehouses && (!m.fromWarehouseId || !m.toWarehouseId)) {
    return { status: 422, body: { code: 'transfer_needs_both_warehouses', message: 'A transfer moves goods from one warehouse to another: choose both.' } }
  }
  return null
}

export const movementController = new Elysia({ prefix: '/org/:orgId/warehouse/movement' })
  .use(AppAuthService)
  .get('/', async ({ params: { orgId }, query, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    const r = getRepos()

    const filter: Record<string, any> = { orgId }
    if (query.search) {
      const searchFilter = buildSearchFilter(query.search as string, ['movementNumber', 'notes', 'reference'])
      Object.assign(filter, searchFilter)
    }
    if (query.type) filter.type = query.type
    if (query.status) filter.status = query.status
    // The movements that name one contact (the contact form's Movements button). What is no id finds nothing: the
    // button counts by the same field, and a list of everybody's movements under one contact's name is the wrong answer.
    if (query.contactId !== undefined) filter.contactId = /^[0-9a-f]{24}$/i.test(String(query.contactId)) ? String(query.contactId) : NO_CONTACT
    if (query.warehouseId) {
      // An external warehouse sits in the external pair once the movement is completed.
      filter.$or = [
        { fromWarehouseId: query.warehouseId },
        { toWarehouseId: query.warehouseId },
        { externalFromWarehouseId: query.warehouseId },
        { externalToWarehouseId: query.warehouseId },
      ]
    }
    // The movements carrying any article the Products list's search and filters find (`product*`,
    // `buildProductListFilter`); articles picked by id (`productId`) narrow that further.
    const productQuery = {
      search: query.productSearch as string | undefined,
      category: query.productCategory as string | undefined,
      type: query.productType as string | undefined,
      tags: query.productTags as string | string[] | undefined,
      isActive: query.productActive as string | undefined,
    }
    let productIds: string[] | null = query.productId
      ? (query.productId as string).split(',').map(id => id.trim()).filter(Boolean)
      : null
    if (hasProductListFilter(productQuery)) {
      const matching = new Set(await productIdsMatching(r.products, buildProductListFilter(orgId, productQuery)))
      productIds = productIds ? productIds.filter(id => matching.has(id)) : [...matching]
    }
    if (productIds) filter['lines.productId'] = productIds.length === 1 ? productIds[0] : { $in: productIds }
    if (query.dateFrom || query.dateTo) {
      filter.date = {} as any
      if (query.dateFrom) filter.date.$gte = new Date(query.dateFrom as string)
      if (query.dateTo) filter.date.$lte = new Date(query.dateTo as string)
    }

    const page = Math.max(0, Number(query.page) || 0)
    const size = query.size !== undefined ? Number(query.size) : 10
    // FR-27.11.C.2/C.3: a movement's total is its lines' costs summed. A role without the costs is sent none, and
    // does not order the list by it: asked to, the list comes in its usual order.
    const grant = grantOf(user as any)
    const usual = !seesCosts(grant) && sortsByMovementTotal(query.sortBy as string)
    // FR-30.2: a sort the list declares, else the list's default (the newest first).
    const sort = usual ? chooseListSort('movements', undefined, undefined) : chooseListSort('movements', query.sortBy, query.sortOrder)

    const byRef = MOVEMENT_SORT_BY_REF[sort.key]
    // FR-30.7: `fields=list` (the grid) reads a line's article and quantity only; the lines never leave the server.
    const select = listProjection('movements', query.fields)
    const result = byRef
      ? await findPageSortedBy(r.stockMovements, filter, byRef, sort.order, page, size, { date: -1 }, select)
      : await r.stockMovements.findAll(filter, { page, size, sort: { [sort.field]: sort.order } }, { select })

    // Manual lookups to replace .populate()
    const fromWhIds = new Set<string>()
    const toWhIds = new Set<string>()
    const contactIds = new Set<string>()
    for (const m of result.items) {
      const from = m.fromWarehouseId || m.externalFromWarehouseId
      const to = m.toWarehouseId || m.externalToWarehouseId
      if (from) fromWhIds.add(from)
      if (to) toWhIds.add(to)
      if ((m as any).contactId) contactIds.add((m as any).contactId)
    }

    const allWhIds = new Set([...fromWhIds, ...toWhIds])
    const [warehouses, contacts] = await Promise.all([
      allWhIds.size > 0 ? r.warehouses.findMany({ orgId, id: { $in: [...allWhIds] } } as any, undefined, { select: ['name', 'isExternal'] }) : [],
      contactIds.size > 0 ? r.contacts.findMany({ orgId, id: { $in: [...contactIds] } } as any, undefined, { select: ['companyName', 'firstName', 'lastName'] }) : [],
    ])

    const warehouseMap = new Map(warehouses.map(w => [w.id, w]))
    const contactMap = new Map(contacts.map(c => [c.id, c]))
    // FR-22.31: a receipt names the live bill that holds it (the list's „Фактурирана" marker).
    // #493: none for a session without `purchases`, and the bills it would name are hidden (`withoutBill`).
    const receipts = seesBills(user as any) ? result.items.filter((m: any) => m.type === 'receipt' && m.invoiceId) : []
    const billing = receipts.length ? await billingByMovement(orgId, receipts) : new Map()
    // FR-22.61: a dispatch names the live sales invoice that holds it, for a session that reads sales documents.
    const dispatches = can(user, 'sales-docs.view') ? result.items.filter((m: any) => m.type === 'dispatch' && m.invoiceId) : []
    const invoicing = dispatches.length ? await invoicingByMovement(orgId, dispatches) : new Map()
    const hidden = await hiddenBills(user, orgId, result.items)

    /** A side as the list shows it: the warehouse's name, and whether it is an external one (`sideIsExternal`). */
    const sideOf = (m: any, stockId?: string, externalId?: string) => {
      const id = stockId || externalId
      const wh: any = id ? warehouseMap.get(id) : null
      return { name: wh?.name || '', external: sideIsExternal(m, stockId, externalId, !!wh?.isExternal) }
    }

    const stockMovements = result.items.map(m => {
      const from = sideOf(m, m.fromWarehouseId, m.externalFromWarehouseId)
      const to = sideOf(m, m.toWarehouseId, m.externalToWarehouseId)
      const contact = (m as any).contactId ? contactMap.get((m as any).contactId) : null
      const contactName = contact
        ? (contact as any).companyName || [(contact as any).firstName, (contact as any).lastName].filter(Boolean).join(' ') || ''
        : ''

      // FR-04 (#11): when the list is filtered to ONE product (product page's documents
      // tab), report that product's summed line quantity, signed by the movement's
      // direction: a pure-from doc took stock out, whatever its type and however its line is
      // stored (a write-off kept positive read as a green +2); a pure-to doc keeps the sign on
      // its line; transfers stay unsigned (the ledger tab is the per-WH view).
      let productQuantity: number | undefined
      const singleProductId = query.productId && !(query.productId as string).includes(',')
        ? (query.productId as string).trim()
        : undefined
      if (singleProductId) {
        const qty = ((m as any).lines || [])
          .filter((l: any) => String(l.productId) === singleProductId)
          .reduce((s: number, l: any) => s + (Number(l.quantity) || 0), 0)
        productQuantity = m.fromWarehouseId && !m.toWarehouseId ? -Math.abs(qty) : qty
      }

      // Strip lines from list response (not needed for table, reduces payload)
      const { lines, ...rest } = m as any
      const bill = billing.get(String(m.id))?.invoice
      const sale = saleOf(invoicing.get(String(m.id))?.invoice)
      return redactMovementTotals(grant, withoutBill(hidden, {
        ...rest,
        lineCount: lines?.length || 0,
        number: m.movementNumber,
        total: m.totalAmount,
        fromWarehouseName: from.name,
        toWarehouseName: to.name,
        fromExternal: from.external,
        toExternal: to.external,
        contactName,
        ...(productQuantity !== undefined ? { productQuantity } : {}),
        ...(bill && !['voided', 'cancelled'].includes(bill.status) ? { bill: { id: bill.id, number: bill.number } } : {}),
        ...(sale ? { sale } : {}),
      }))
    })

    return { stockMovements, total: result.total, page: result.page, size: result.size, totalPages: result.totalPages, ...(result.truncated ? { truncated: true } : {}) }
  }, { isSignIn: true })
  .post(
    '/',
    async ({ params: { orgId }, body, user, status, headers }) => {
      if (!user) return status(401, { message: 'Unauthorized' })
      const r = getRepos()

      // FR-29.13: a request repeated with its id is answered with the movement the first one made.
      const request = requestIdOf(headers)
      if (request.refusal) return status(400, request.refusal)
      const requestId = request.id
      const made = async () => (requestId ? r.stockMovements.findOne({ orgId, requestId }) : null)
      const first = await made()
      if (first) return { stockMovement: first, replayed: true }

      const notTransfer = transferRefusal(user, body, { warehouses: true })
      if (notTransfer) return status(notTransfer.status, notTransfer.body)
      if (transferOnly(user)) for (const l of body.lines) { delete (l as any).productUpdate; delete (l as any).priceTiers }

      const misfit = movementWarehouseRefusal({ ...body, ...await movementExternalSides(orgId, body) })
      if (misfit) return status(422, misfit)

      // A number the caller chose is saved or refused as it is. Otherwise the org's next one, and when another
      // movement took that at the same moment, the one after it (`createNumberedMovement`).
      const draft = { ...body, status: 'draft', createdBy: user.id, ...(requestId ? { requestId } : {}) }
      let movement
      try {
        movement = body.movementNumber
          ? await r.stockMovements.create({ ...draft, orgId } as any)
          : await createNumberedMovement(r, orgId, draft)
      } catch (e) {
        // The same request at the same moment: the one that saved first made the movement.
        const won = isRequestIdTaken(e) ? await made() : null
        if (won) return { stockMovement: won, replayed: true }
        throw e
      }
      const movementNumber = movement.movementNumber

      createAuditEntry({ orgId, userId: user.id, action: 'create', module: 'warehouse', entityType: 'stock_movement', entityId: movement.id, entityName: movementNumber })

      return { stockMovement: movement }
    },
    {
      isSignIn: true,
      body: t.Object({
        movementNumber: t.Optional(t.String()),
        type: t.Union([
          t.Literal('receipt'),
          t.Literal('dispatch'),
          t.Literal('transfer'),
          t.Literal('adjustment'),
          t.Literal('return'),
          t.Literal('production_in'),
          t.Literal('production_out'),
        ]),
        date: t.String(),
        fromWarehouseId: t.Optional(t.String()),
        toWarehouseId: t.Optional(t.String()),
        contactId: t.Optional(t.String()),
        invoiceId: t.Optional(t.String()),
        lines: t.Array(t.Object({
          productId: t.String(),
          quantity: t.Number({ minimum: 0 }),
          unitCost: t.Number({ minimum: 0 }),
          totalCost: t.Number({ minimum: 0 }),
          batchNumber: t.Optional(t.String()),
          serialNumbers: t.Optional(t.Array(t.String())),
          productUpdate: t.Optional(t.Any()),
          priceTiers: t.Optional(t.Array(t.Any())),
        })),
        totalAmount: t.Number(),
        reference: t.Optional(t.String()),
        notes: t.Optional(t.String()),
      }),
    },
  )
  // Goods-receipt with inline product updates. Atomic via Mongo transaction (requires replset).
  .post(
    '/with-update',
    async ({ params: { orgId }, body, user, status, headers }) => {
      if (!user) return status(401, { message: 'Unauthorized' })
      // FR-26.7: this route books receipts only.
      if (transferOnly(user)) return status(403, TRANSFER_ONLY)
      // FR-29.13: a request repeated with its id is answered with the movement the first one made, in this route's
      // shape. Its product updates were applied by the first request, with the movement, and are not applied again.
      const request = requestIdOf(headers)
      if (request.refusal) return status(400, request.refusal)
      const requestId = request.id
      const replay = async () => {
        const first = requestId ? await getRepos().stockMovements.findOne({ orgId, requestId }, { select: ['movementNumber'] }) : null
        return first ? { stockMovement: { _id: first.id, movementNumber: first.movementNumber }, updatedProductIds: [] as string[], replayed: true } : null
      }
      const first = await replay()
      if (first) return first
      const misfit = movementWarehouseRefusal({ ...body, ...await movementExternalSides(orgId, body) })
      if (misfit) return status(422, misfit)
      // The product updates and the movement are one transaction, so a number another movement took at the same
      // moment undoes both, and both are written again under the next number.
      const write = async (movementNumber: string) => ({
        movementNumber,
        ...await createMovementWithProductUpdates(
          { ...body, orgId, movementNumber, createdBy: user.id, ...(requestId ? { requestId } : {}) } as any,
          (body.productUpdates || []) as any,
        ),
      })
      try {
        const { movementId, movementNumber, updatedProductIds } = body.movementNumber
          ? await write(body.movementNumber)
          : await withMovementNumber(orgId, write)
        // Audit log: one entry per product update, all tied to the movement via correlationId.
        for (const pid of updatedProductIds) {
          createAuditEntry({
            orgId, userId: user.id, action: 'update', module: 'warehouse',
            entityType: 'product', entityId: pid,
            correlationId: movementId,
          })
        }
        createAuditEntry({
          orgId, userId: user.id, action: 'create', module: 'warehouse',
          entityType: 'stock_movement', entityId: movementId, entityName: movementNumber,
          correlationId: movementId,
        })
        return { stockMovement: { _id: movementId, movementNumber }, updatedProductIds }
      } catch (e: any) {
        if (e instanceof GRValidationError) return status(422, { message: e.message })
        // The same request at the same moment: the one that committed first made the movement.
        const won = isRequestIdTaken(e) ? await replay() : null
        if (won) return won
        // To the app's error handler, which logs it and says only what S-12 lets through. Answered
        // here, a failed transaction's driver error reached the caller verbatim and the log not at all.
        throw e
      }
    },
    {
      isSignIn: true,
      body: t.Object({
        movementNumber: t.Optional(t.String()),
        type: t.Literal('receipt'),
        date: t.String(),
        fromWarehouseId: t.Optional(t.String()),
        toWarehouseId: t.Optional(t.String()),
        contactId: t.Optional(t.String()),
        lines: t.Array(t.Object({
          productId: t.String(),
          quantity: t.Number({ minimum: 0 }),
          unitCost: t.Number({ minimum: 0 }),
          totalCost: t.Number({ minimum: 0 }),
          batchNumber: t.Optional(t.String()),
          serialNumbers: t.Optional(t.Array(t.String())),
        })),
        totalAmount: t.Number(),
        reference: t.Optional(t.String()),
        notes: t.Optional(t.String()),
        productUpdates: t.Optional(t.Array(t.Any())),
      }),
    },
  )
  .get('/:id', async ({ params: { orgId, id }, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    const r = getRepos()

    const movement = await r.stockMovements.findOne({ id, orgId } as any)
    if (!movement) return status(404, { message: 'Stock movement not found' })

    // Lookup product names for lines
    const productIds = new Set<string>()
    for (const l of movement.lines) {
      if (l.productId) productIds.add(l.productId)
    }
    const products = productIds.size > 0
      ? await r.products.findMany({ orgId, id: { $in: [...productIds] } } as any)
      : []
    const productMap = new Map(products.map(p => [p.id, p]))

    // FR-27.11.C.1: no line's cost, and a receipt line's product update by the product's rule, for a role without them.
    // C.2: nor the movement's total, which is those costs summed.
    const grant = grantOf(user as any)
    const lines = movement.lines.map(l => redactMovementLine(grant, {
      ...l,
      productName: productMap.get(l.productId)?.name || '',
      productSku: productMap.get(l.productId)?.sku || '',
    }))

    // FR-22.31: the bill that holds this receipt, or whether one may be made from it.
    // #493: a session without `purchases` makes no bill and is told of none.
    const billing = movement.type === 'receipt' && seesBills(user as any)
      ? await receiptBillingFor(orgId, { ...movement, _id: movement.id }, user.id)
      : { billable: false }

    // FR-22.61: the sales invoice that holds this dispatch, or whether one may be made from it. A session that reads
    // no sales documents is told of none, and one that may not create them is offered none.
    const noted = movement.type === 'dispatch' && can(user, 'sales-docs.view')
      ? await dispatchInvoicingFor(orgId, { ...movement, _id: movement.id }, user.id)
      : null
    const invoicing = noted
      ? (({ sale, invoiceable, ...rest }) => ({
          ...rest,
          invoiceable: invoiceable && can(user, 'sales-docs.create'),
          ...(saleOf(sale) ? { sale: saleOf(sale) } : {}),
        }))(noted)
      : {}

    // Which side is an external warehouse (`sideIsExternal`): only a draft's choice needs the flag as it is now.
    const live = movement.status === 'draft' ? await movementExternalSides(orgId, movement) : { fromExternal: false, toExternal: false }
    const externalSides = {
      fromExternal: sideIsExternal(movement, movement.fromWarehouseId, movement.externalFromWarehouseId, live.fromExternal),
      toExternal: sideIsExternal(movement, movement.toWarehouseId, movement.externalToWarehouseId, live.toExternal),
    }

    const hidden = await hiddenBills(user, orgId, [movement])
    return { stockMovement: redactMovementTotals(grant, withoutBill(hidden, { ...movement, number: movement.movementNumber, lines, ...externalSides, ...billing, ...invoicing })) }
  }, { isSignIn: true })
  /**
   * The movement as a printed document (`reporting/pdf/stock-movement.pdf`), for whoever may read it. It
   * carries no price: a line's `unitCost` is a cost figure not every role sees, and the sheet leaves the org.
   */
  .get('/:id/export', async ({ params: { orgId, id }, query, user, status, set }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    const rendered = await renderStockMovementPdf(orgId, id, { locale: (query.locale as string) || 'en' })
    if (!rendered.ok) return status(rendered.status, { message: rendered.message, ...(rendered.detail ? { detail: rendered.detail } : {}) })
    set.headers['content-type'] = 'application/pdf'
    set.headers['content-disposition'] = `attachment; filename="${rendered.filename}"`
    return new Response(rendered.buffer as any)
  }, { isSignIn: true })
  .put(
    '/:id',
    async ({ params: { orgId, id }, body, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })
      const r = getRepos()

      const existing = await r.stockMovements.findOne({ id, orgId } as any)
      if (!existing) return status(404, { message: 'Stock movement not found' })
      if (existing.status !== 'draft') return status(400, { message: 'Can only edit draft movements' })

      // The movement as it would stand after this edit. A warehouse the body does not mention
      // stays; `null` clears it, which is how a draft saved with the wrong side gets repaired.
      const after = {
        type: existing.type,
        fromWarehouseId: body.fromWarehouseId === undefined ? existing.fromWarehouseId : body.fromWarehouseId,
        toWarehouseId: body.toWarehouseId === undefined ? existing.toWarehouseId : body.toWarehouseId,
      }
      const notTransfer = transferRefusal(user, after, { warehouses: true })
      if (notTransfer) return status(notTransfer.status, notTransfer.body)

      const misfit = movementWarehouseRefusal({ ...after, ...await movementExternalSides(orgId, after) })
      if (misfit) return status(422, misfit)

      // Inline product-master updates (receipts only) ride the edit in one transaction.
      const productUpdates = (body as any).productUpdates as any[] | undefined
      delete (body as any).productUpdates

      let updated: any
      if (Array.isArray(productUpdates) && productUpdates.length > 0) {
        if (existing.type !== 'receipt') {
          return status(422, { message: 'productUpdates is only supported for goods receipts' })
        }
        let updatedProductIds: string[] = []
        try {
          const res = await updateMovementWithProductUpdates({ orgId, movementId: id, update: body as any, productUpdates })
          updatedProductIds = res.updatedProductIds
        } catch (e: any) {
          if (e instanceof GRValidationError) return status(422, { message: e.message })
          throw e
        }
        updated = await r.stockMovements.findOne({ id, orgId } as any)
        for (const pid of updatedProductIds) {
          createAuditEntry({
            orgId, userId: user.id, action: 'update', module: 'warehouse',
            entityType: 'product', entityId: pid, correlationId: id,
          })
        }
      } else {
        updated = await r.stockMovements.updateInOrg(id, orgId, body as any)
      }
      return { stockMovement: updated }
    },
    {
      isSignIn: true,
      body: t.Object({
        date: t.Optional(t.String()),
        // `null` clears the warehouse or the partner; left out, it stays as it is.
        fromWarehouseId: t.Optional(t.Union([t.String(), t.Null()])),
        toWarehouseId: t.Optional(t.Union([t.String(), t.Null()])),
        contactId: t.Optional(t.Union([t.String(), t.Null()])),
        lines: t.Optional(t.Array(t.Object({
          productId: t.String(),
          quantity: t.Number({ minimum: 0 }),
          unitCost: t.Number({ minimum: 0 }),
          totalCost: t.Number({ minimum: 0 }),
          batchNumber: t.Optional(t.String()),
          serialNumbers: t.Optional(t.Array(t.String())),
        }))),
        totalAmount: t.Optional(t.Number()),
        reference: t.Optional(t.String()),
        notes: t.Optional(t.String()),
        // Goods receipts only: inline product-master updates applied atomically with the edit.
        productUpdates: t.Optional(t.Array(t.Any())),
      }),
    },
  )
  .post('/:id/confirm', async ({ params: { orgId, id }, body, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    const r = getRepos()

    const movement = await r.stockMovements.findOne({ id, orgId } as any)
    if (!movement) return status(404, { message: 'Stock movement not found' })
    if (movement.status !== 'draft') return status(400, { message: 'Movement is not in draft status' })

    const notTransfer = transferRefusal(user, movement, { warehouses: true })
    if (notTransfer) return status(notTransfer.status, notTransfer.body)

    // A draft saved before the rule existed reaches the stock through here: this is the last door.
    // So does one whose warehouse became external after it was saved: the flag is read now.
    const misfit = movementWarehouseRefusal({
      type: movement.type,
      fromWarehouseId: movement.fromWarehouseId,
      toWarehouseId: movement.toWarehouseId,
      ...await movementExternalSides(orgId, movement),
    })
    if (misfit) return status(422, misfit)

    // FR-04 (#11): confirming a MANUAL adjustment can auto-create its completed inventory
    // count (the reverse of count-complete → adjustment). Opt-in via createCount — the UI
    // sends true; imports/skills that POST+confirm through the API stay count-free.
    // Count-born adjustments carry inventoryCountId already (loop guard), and adjustments
    // with BOTH warehouses set are ambiguous for a single-warehouse count — skipped.
    const wantCount = (body as any)?.createCount === true
      && movement.type === 'adjustment'
      && !(movement as any).inventoryCountId
      && !!(movement.fromWarehouseId || movement.toWarehouseId)
      && !(movement.fromWarehouseId && movement.toWarehouseId)

    // System quantities must be captured BEFORE the confirm mutates the stock.
    const countWarehouseId = movement.toWarehouseId || movement.fromWarehouseId
    let preLevels: Map<string, number> | null = null
    if (wantCount) {
      preLevels = new Map()
      const productIds = [...new Set((movement.lines || []).map((l: any) => String(l.productId)))]
      const levels = await r.stockLevels.findMany(
        { orgId, warehouseId: countWarehouseId, productId: { $in: productIds } } as any,
      )
      for (const sl of levels) preLevels.set(String(sl.productId), sl.quantity || 0)
    }

    // Use the business service which already handles stock level updates via DAL
    let confirmed: Awaited<ReturnType<typeof confirmMovement>>
    try {
      confirmed = await confirmMovement(id, r)
    } catch (e) {
      // Another confirm, or a delete, holds it (#448).
      if (e instanceof MovementClaimedError) return status(409, { code: e.code, message: e.message })
      // The other one finished between the check above and this one's claim.
      if (e instanceof MovementNotDraftError) return status(400, { message: 'Movement is not in draft status' })
      throw e
    }

    let inventoryCountId: string | undefined
    if (wantCount && preLevels) {
      // Signed delta: to-side adjustment lines carry their sign (count-born convention);
      // from-side adjustments (write-offs) subtract their positive quantities.
      const sign = movement.toWarehouseId ? 1 : -1
      const lines = (movement.lines || [])
        .filter((l: any) => Number(l.quantity) !== 0)
        .map((l: any) => {
          const delta = sign * Number(l.quantity)
          const systemQuantity = preLevels!.get(String(l.productId)) ?? 0
          return {
            productId: l.productId,
            systemQuantity,
            countedQuantity: systemQuantity + delta,
            variance: delta,
            varianceCost: +(delta * (Number(l.unitCost) || 0)).toFixed(2),
          }
        })
      if (lines.length) {
        const countNumber = await nextCountNumber(orgId)
        const count = await r.inventoryCounts.create({
          orgId,
          countNumber,
          warehouseId: countWarehouseId,
          date: new Date(),
          type: 'partial',
          status: 'completed',
          lines,
          adjustmentMovementId: id,
          completedAt: new Date(),
          completedBy: user.id,
          createdBy: user.id,
        } as any)
        await r.stockMovements.updateInOrg(id, orgId, { inventoryCountId: count.id } as any)
        inventoryCountId = count.id
        createAuditEntry({ orgId, userId: user.id, action: 'create', module: 'warehouse', entityType: 'inventory_count', entityId: count.id, entityName: countNumber, correlationId: id })
      }
    }

    createAuditEntry({ orgId, userId: user.id, action: 'confirm', module: 'warehouse', entityType: 'stock_movement', entityId: id, entityName: (movement as any)?.movementNumber })

    return { stockMovement: inventoryCountId ? { ...(confirmed as any), inventoryCountId } : confirmed }
  }, {
    isSignIn: true,
    body: t.Optional(t.Object({ createCount: t.Optional(t.Boolean()) })),
  })
  /**
   * #448: a draft saved by mistake, or left behind by a field test, can go. It never moved anything,
   * and confirming it would. Only a DRAFT, and only one nothing else names: those are taken off by
   * whatever drew them up (a sale's or an issue's transfers, a bill's receipts, a Files import), and
   * removing one under them would leave that document pointing at nothing.
   */
  .delete('/:id', async ({ params: { orgId, id }, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    const r = getRepos()

    const existing = await r.stockMovements.findOne({ id, orgId } as any)
    if (!existing) return status(404, { message: 'Stock movement not found' })
    if (existing.status !== 'draft') return status(400, { message: 'Can only delete draft movements' })

    const notTransfer = transferRefusal(user, existing)
    if (notTransfer) return status(notTransfer.status, notTransfer.body)

    const name = (existing as any).movementNumber
    if ((existing as any).invoiceId || (existing as any).productionOrderId) {
      return status(409, { code: 'movement_referenced', message: `${name} was drawn up for another document — remove it there` })
    }
    const [doc, file] = await Promise.all([
      Invoice.findOne({
        orgId,
        $or: [
          { pendingTransferIds: id },
          { 'register.transfersToConfirm': id },
          { 'register.movementId': id },
          { 'stockSource.movementIds': id },
        ],
      }, { invoiceNumber: 1 }).lean().exec(),
      DocFile.findOne({ orgId, committedIds: id }, { originalName: 1 }).lean().exec(),
    ])
    if (doc) {
      return status(409, { code: 'movement_referenced', message: `${name} belongs to ${(doc as any).invoiceNumber || 'a document'} — remove it there` })
    }
    if (file) {
      return status(409, { code: 'movement_referenced', message: `${name} was booked from ${(file as any).originalName || 'a file'} in Files — roll it back there` })
    }

    // ⚠ Atomic, and only past the hold a confirm takes: one under way has moved stock by now.
    const gone = await StockMovement.deleteOne({ _id: id, orgId, status: 'draft', ...unclaimedMovement() }).exec()
    if (!gone.deletedCount) {
      const now: any = await StockMovement.findOne({ _id: id, orgId }, { status: 1 }).lean().exec()
      if (!now) return status(404, { message: 'Stock movement not found' })
      if (now.status !== 'draft') return status(400, { message: 'Can only delete draft movements' })
      return status(409, { code: 'movement_busy', message: new MovementClaimedError(name).message })
    }

    createAuditEntry({ orgId, userId: user.id, action: 'delete', module: 'warehouse', entityType: 'stock_movement', entityId: id, entityName: name })
    return { message: 'Stock movement deleted' }
  }, { isSignIn: true })
