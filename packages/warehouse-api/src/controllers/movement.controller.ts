import { Elysia, t } from 'elysia'
import { AppAuthService } from '../auth/app-auth.service.js'
import { getRepos } from 'services/context'
import { confirmMovement } from 'services/biz/warehouse.service'
import { createMovementWithProductUpdates, updateMovementWithProductUpdates, GRValidationError } from 'services/biz/movement-with-update.service'
import { createAuditEntry } from 'services/biz/audit-log.service'
import { buildSearchFilter } from 'services/biz/search.utils'
import { billingByMovement, receiptBillingFor } from 'services/biz/receipt-bill.service'

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
    if (query.productId) {
      const ids = (query.productId as string).split(',').map(id => id.trim()).filter(Boolean)
      filter['lines.productId'] = ids.length === 1 ? ids[0] : { $in: ids }
    }
    if (query.dateFrom || query.dateTo) {
      filter.date = {} as any
      if (query.dateFrom) filter.date.$gte = new Date(query.dateFrom as string)
      if (query.dateTo) filter.date.$lte = new Date(query.dateTo as string)
    }

    const page = Math.max(0, Number(query.page) || 0)
    const size = query.size !== undefined ? Number(query.size) : 10
    const sortBy = (query.sortBy as string) || 'date'
    const sortOrder = (query.sortOrder as string) === 'asc' ? 1 : -1

    const result = await r.stockMovements.findAll(filter, { page, size, sort: { [sortBy]: sortOrder } })

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
    const receipts = result.items.filter((m: any) => m.type === 'receipt' && m.invoiceId)
    const billing = receipts.length ? await billingByMovement(orgId, receipts) : new Map()

    const stockMovements = result.items.map(m => {
      const fromWh = m.fromWarehouseId ? warehouseMap.get(m.fromWarehouseId) : null
      const toWh = m.toWarehouseId ? warehouseMap.get(m.toWarehouseId) : null
      const contact = (m as any).contactId ? contactMap.get((m as any).contactId) : null
      const contactName = contact
        ? (contact as any).companyName || [(contact as any).firstName, (contact as any).lastName].filter(Boolean).join(' ') || ''
        : ''

      // FR-04 (#11): when the list is filtered to ONE product (product page's documents
      // tab), report that product's summed line quantity, signed by the movement's
      // direction — adjustments carry their sign on the line already; a pure-from doc
      // took stock out; transfers stay unsigned (the ledger tab is the per-WH view).
      let productQuantity: number | undefined
      const singleProductId = query.productId && !(query.productId as string).includes(',')
        ? (query.productId as string).trim()
        : undefined
      if (singleProductId) {
        const qty = ((m as any).lines || [])
          .filter((l: any) => String(l.productId) === singleProductId)
          .reduce((s: number, l: any) => s + (Number(l.quantity) || 0), 0)
        const sign = m.type === 'adjustment' ? 1 : (m.fromWarehouseId && !m.toWarehouseId ? -1 : 1)
        productQuantity = qty * sign
      }

      // Strip lines from list response (not needed for table, reduces payload)
      const { lines, ...rest } = m as any
      const bill = billing.get(String(m.id))?.invoice
      return {
        ...rest,
        lineCount: lines?.length || 0,
        number: m.movementNumber,
        total: m.totalAmount,
        fromWarehouseName: fromWh?.name || '',
        toWarehouseName: toWh?.name || '',
        contactName,
        ...(productQuantity !== undefined ? { productQuantity } : {}),
        ...(bill && !['voided', 'cancelled'].includes(bill.status) ? { bill: { id: bill.id, number: bill.number } } : {}),
      }
    })

    return { stockMovements, total: result.total, page: result.page, size: result.size, totalPages: result.totalPages }
  }, { isSignIn: true })
  .post(
    '/',
    async ({ params: { orgId }, body, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })
      const r = getRepos()

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
        return status(500, { message: e?.message || 'GR-with-update failed' })
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
    const billing = movement.type === 'receipt'
      ? await receiptBillingFor(orgId, { ...movement, _id: movement.id })
      : { billable: false }

    return { stockMovement: { ...movement, number: movement.movementNumber, lines, ...billing } }
  }, { isSignIn: true })
  .put(
    '/:id',
    async ({ params: { orgId, id }, body, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })
      const r = getRepos()

      const existing = await r.stockMovements.findOne({ id, orgId } as any)
      if (!existing) return status(404, { message: 'Stock movement not found' })
      if (existing.status !== 'draft') return status(400, { message: 'Can only edit draft movements' })

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
        fromWarehouseId: t.Optional(t.String()),
        toWarehouseId: t.Optional(t.String()),
        contactId: t.Optional(t.String()),
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
    const confirmed = await confirmMovement(id, r)

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
