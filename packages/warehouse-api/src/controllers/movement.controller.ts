import { Elysia, t } from 'elysia'
import { movementWarehouseRefusal } from 'config/movement-warehouses'
import { can } from 'services/biz/access/evaluate'
import { holdsArea } from 'config/constants'
import { AppAuthService } from '../auth/app-auth.service.js'
import { getRepos } from 'services/context'
import { confirmMovement, MovementClaimedError, MovementNotDraftError, unclaimedMovement } from 'services/biz/warehouse.service'
import { DocFile, Invoice, StockMovement } from 'db/models'
import { createMovementWithProductUpdates, updateMovementWithProductUpdates, GRValidationError } from 'services/biz/movement-with-update.service'
import { createAuditEntry } from 'services/biz/audit-log.service'
import { buildSearchFilter } from 'services/biz/search.utils'
import { buildProductListFilter, hasProductListFilter, productIdsMatching } from 'services/biz/product-list-filter'
import { findPageSortedBy } from 'services/biz/sorted-page'
import { billingByMovement, receiptBillingFor } from 'services/biz/receipt-bill.service'

/**
 * What the Movements list's columns sort by. Two print a field under another name; three print
 * the name of what the movement points at, which only an aggregation can order by.
 */
const MOVEMENT_SORT_FIELDS: Record<string, string> = { number: 'movementNumber', total: 'totalAmount' }
const refName = (from: string, localField: string, name: unknown) => [
  { $lookup: { from, localField, foreignField: '_id', as: '_ref' } },
  { $addFields: { sortKey: name } },
]
const MOVEMENT_SORT_BY_REF: Record<string, Record<string, unknown>[]> = {
  fromWarehouseName: refName('warehouses', 'fromWarehouseId', { $first: '$_ref.name' }),
  toWarehouseName: refName('warehouses', 'toWarehouseId', { $first: '$_ref.name' }),
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

async function getNextMovementNumber(orgId: string): Promise<string> {
  const r = getRepos()
  const year = new Date().getFullYear()
  const prefix = `SM-${year}-`
  const movements = await r.stockMovements.findMany(
    { orgId, movementNumber: { $regex: `^${prefix}` } } as any,
    { movementNumber: -1 },
  )
  if (!movements.length) return `${prefix}00001`
  const currentNum = parseInt(movements[0].movementNumber.replace(prefix, ''), 10)
  return `${prefix}${String(currentNum + 1).padStart(5, '0')}`
}

// Same max+1 scheme the inventory-count controller uses (deliberately duplicated, like
// getNextMovementNumber itself — these counters predate the Sequence registry).
async function getNextCountNumber(orgId: string): Promise<string> {
  const r = getRepos()
  const year = new Date().getFullYear()
  const prefix = `IC-${year}-`
  const counts = await r.inventoryCounts.findMany(
    { orgId, countNumber: { $regex: `^${prefix}` } } as any,
    { countNumber: -1 },
  )
  if (!counts.length) return `${prefix}00001`
  const currentNum = parseInt(counts[0].countNumber.replace(prefix, ''), 10)
  return `${prefix}${String(currentNum + 1).padStart(5, '0')}`
}

/**
 * FR-26.7: a session that writes movements through `inventory.transfer` alone (a Seller) writes
 * transfers and nothing else. `inventory.write` keeps every type; `admin` is refused nothing.
 */
function transferOnly(user: { role?: string; permissions?: readonly string[] }): boolean {
  return !can(user, 'movements.create')
}

const TRANSFER_ONLY = { code: 'transfer_only', message: 'Your role moves stock between warehouses only: a transfer.' } as const

/**
 * #493, FR-26.6 `purchases`: the incoming documents these movements point at, for a session
 * without the area; empty for one that has it (nothing is hidden from it). One query per call.
 */
async function hiddenBills(user: { role?: string; areas?: readonly string[] }, orgId: string, movements: any[]): Promise<Set<string>> {
  if (holdsArea(user, 'purchases')) return new Set()
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
      const searchFilter = buildSearchFilter(query.search as string, ['movementNumber', 'notes', 'reference'], { hasTextIndex: true })
      Object.assign(filter, searchFilter)
    }
    if (query.type) filter.type = query.type
    if (query.status) filter.status = query.status
    if (query.warehouseId) {
      filter.$or = [
        { fromWarehouseId: query.warehouseId },
        { toWarehouseId: query.warehouseId },
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
    const sortBy = (query.sortBy as string) || 'date'
    const sortOrder = (query.sortOrder as string) === 'asc' ? 1 : -1

    const byRef = MOVEMENT_SORT_BY_REF[sortBy]
    const result = byRef
      ? await findPageSortedBy(r.stockMovements, filter, byRef, sortOrder, page, size, { date: -1 })
      : await r.stockMovements.findAll(filter, { page, size, sort: { [MOVEMENT_SORT_FIELDS[sortBy] || sortBy]: sortOrder } })

    // Manual lookups to replace .populate()
    const fromWhIds = new Set<string>()
    const toWhIds = new Set<string>()
    const contactIds = new Set<string>()
    for (const m of result.items) {
      if (m.fromWarehouseId) fromWhIds.add(m.fromWarehouseId)
      if (m.toWarehouseId) toWhIds.add(m.toWarehouseId)
      if ((m as any).contactId) contactIds.add((m as any).contactId)
    }

    const allWhIds = new Set([...fromWhIds, ...toWhIds])
    const [warehouses, contacts] = await Promise.all([
      allWhIds.size > 0 ? r.warehouses.findMany({ id: { $in: [...allWhIds] } } as any) : [],
      contactIds.size > 0 ? r.contacts.findMany({ id: { $in: [...contactIds] } } as any) : [],
    ])

    const warehouseMap = new Map(warehouses.map(w => [w.id, w]))
    const contactMap = new Map(contacts.map(c => [c.id, c]))
    // FR-22.31: a receipt names the live bill that holds it (the list's „Фактурирана" marker).
    // #493: none for a session without `purchases`, and the bills it would name are hidden (`withoutBill`).
    const receipts = holdsArea(user, 'purchases') ? result.items.filter((m: any) => m.type === 'receipt' && m.invoiceId) : []
    const billing = receipts.length ? await billingByMovement(orgId, receipts) : new Map()
    const hidden = await hiddenBills(user, orgId, result.items)

    const stockMovements = result.items.map(m => {
      const fromWh = m.fromWarehouseId ? warehouseMap.get(m.fromWarehouseId) : null
      const toWh = m.toWarehouseId ? warehouseMap.get(m.toWarehouseId) : null
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
      return withoutBill(hidden, {
        ...rest,
        lineCount: lines?.length || 0,
        number: m.movementNumber,
        total: m.totalAmount,
        fromWarehouseName: fromWh?.name || '',
        toWarehouseName: toWh?.name || '',
        contactName,
        ...(productQuantity !== undefined ? { productQuantity } : {}),
        ...(bill && !['voided', 'cancelled'].includes(bill.status) ? { bill: { id: bill.id, number: bill.number } } : {}),
      })
    })

    return { stockMovements, total: result.total, page: result.page, size: result.size, totalPages: result.totalPages }
  }, { isSignIn: true })
  .post(
    '/',
    async ({ params: { orgId }, body, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })
      const r = getRepos()

      const notTransfer = transferRefusal(user, body, { warehouses: true })
      if (notTransfer) return status(notTransfer.status, notTransfer.body)
      if (transferOnly(user)) for (const l of body.lines) { delete (l as any).productUpdate; delete (l as any).priceTiers }

      const misfit = movementWarehouseRefusal(body)
      if (misfit) return status(422, misfit)

      const movementNumber = body.movementNumber || await getNextMovementNumber(orgId)

      const movement = await r.stockMovements.create({
        ...body,
        orgId,
        movementNumber,
        status: 'draft',
        createdBy: user.id,
      } as any)

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
    async ({ params: { orgId }, body, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })
      // FR-26.7: this route books receipts only.
      if (transferOnly(user)) return status(403, TRANSFER_ONLY)
      const misfit = movementWarehouseRefusal(body)
      if (misfit) return status(422, misfit)
      const movementNumber = body.movementNumber || await getNextMovementNumber(orgId)
      try {
        const { movementId, updatedProductIds } = await createMovementWithProductUpdates(
          { ...body, orgId, movementNumber, createdBy: user.id } as any,
          (body.productUpdates || []) as any,
        )
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
      ? await r.products.findMany({ id: { $in: [...productIds] } } as any)
      : []
    const productMap = new Map(products.map(p => [p.id, p]))

    const lines = movement.lines.map(l => ({
      ...l,
      productName: productMap.get(l.productId)?.name || '',
      productSku: productMap.get(l.productId)?.sku || '',
    }))

    // FR-22.31: the bill that holds this receipt, or whether one may be made from it.
    // #493: a session without `purchases` makes no bill and is told of none.
    const billing = movement.type === 'receipt' && holdsArea(user, 'purchases')
      ? await receiptBillingFor(orgId, { ...movement, _id: movement.id }, user.id)
      : { billable: false }

    const hidden = await hiddenBills(user, orgId, [movement])
    return { stockMovement: withoutBill(hidden, { ...movement, number: movement.movementNumber, lines, ...billing }) }
  }, { isSignIn: true })
  .put(
    '/:id',
    async ({ params: { orgId, id }, body, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })
      const r = getRepos()

      const existing = await r.stockMovements.findOne({ id, orgId } as any)
      if (!existing) return status(404, { message: 'Stock movement not found' })
      if (existing.status !== 'draft') return status(400, { message: 'Can only edit draft movements' })

      const notTransfer = transferRefusal(user, {
        type: existing.type,
        fromWarehouseId: body.fromWarehouseId === undefined ? existing.fromWarehouseId : body.fromWarehouseId,
        toWarehouseId: body.toWarehouseId === undefined ? existing.toWarehouseId : body.toWarehouseId,
      }, { warehouses: true })
      if (notTransfer) return status(notTransfer.status, notTransfer.body)

      // The movement as it would stand after this edit. A warehouse the body does not mention
      // stays; `null` clears it, which is how a draft saved with the wrong side gets repaired.
      const misfit = movementWarehouseRefusal({
        type: existing.type,
        fromWarehouseId: body.fromWarehouseId === undefined ? existing.fromWarehouseId : body.fromWarehouseId,
        toWarehouseId: body.toWarehouseId === undefined ? existing.toWarehouseId : body.toWarehouseId,
      })
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
    const misfit = movementWarehouseRefusal(movement)
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
        const countNumber = await getNextCountNumber(orgId)
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
