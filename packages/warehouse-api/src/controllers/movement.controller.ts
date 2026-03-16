import { Elysia, t } from 'elysia'
import { AppAuthService } from '../auth/app-auth.service.js'
import { getRepos } from 'services/context'
import { confirmMovement } from 'services/biz/warehouse.service'
import { createAuditEntry } from 'services/biz/audit-log.service'

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

export const movementController = new Elysia({ prefix: '/org/:orgId/warehouse/movement' })
  .use(AppAuthService)
  .get('/', async ({ params: { orgId }, query, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    const r = getRepos()

    const filter: Record<string, any> = { orgId }
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

    const stockMovements = result.items.map(m => {
      const fromWh = m.fromWarehouseId ? warehouseMap.get(m.fromWarehouseId) : null
      const toWh = m.toWarehouseId ? warehouseMap.get(m.toWarehouseId) : null
      const contact = (m as any).contactId ? contactMap.get((m as any).contactId) : null
      const contactName = contact
        ? (contact as any).companyName || [(contact as any).firstName, (contact as any).lastName].filter(Boolean).join(' ') || ''
        : ''

      // Strip lines from list response (not needed for table, reduces payload)
      const { lines, ...rest } = m as any
      return {
        ...rest,
        lineCount: lines?.length || 0,
        number: m.movementNumber,
        total: m.totalAmount,
        fromWarehouseName: fromWh?.name || '',
        toWarehouseName: toWh?.name || '',
        contactName,
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

      createAuditEntry({ orgId, userId: user.id, action: 'create', module: 'warehouse', entityType: 'stock_movement', entityId: movement.id })

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
        })),
        totalAmount: t.Number(),
        notes: t.Optional(t.String()),
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

    return { stockMovement: { ...movement, lines } }
  }, { isSignIn: true })
  .put(
    '/:id',
    async ({ params: { orgId, id }, body, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })
      const r = getRepos()

      const existing = await r.stockMovements.findOne({ id, orgId } as any)
      if (!existing) return status(404, { message: 'Stock movement not found' })
      if (existing.status !== 'draft') return status(400, { message: 'Can only edit draft movements' })

      const updated = await r.stockMovements.update(id, body as any)
      return { stockMovement: updated }
    },
    {
      isSignIn: true,
      body: t.Object({
        date: t.Optional(t.String()),
        fromWarehouseId: t.Optional(t.String()),
        toWarehouseId: t.Optional(t.String()),
        lines: t.Optional(t.Array(t.Object({
          productId: t.String(),
          quantity: t.Number({ minimum: 0 }),
          unitCost: t.Number({ minimum: 0 }),
          totalCost: t.Number({ minimum: 0 }),
          batchNumber: t.Optional(t.String()),
          serialNumbers: t.Optional(t.Array(t.String())),
        }))),
        totalAmount: t.Optional(t.Number()),
        notes: t.Optional(t.String()),
      }),
    },
  )
  .post('/:id/confirm', async ({ params: { orgId, id }, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    const r = getRepos()

    const movement = await r.stockMovements.findOne({ id, orgId } as any)
    if (!movement) return status(404, { message: 'Stock movement not found' })
    if (movement.status !== 'draft') return status(400, { message: 'Movement is not in draft status' })

    // Use the business service which already handles stock level updates via DAL
    const confirmed = await confirmMovement(id, r)

    createAuditEntry({ orgId, userId: user.id, action: 'confirm', module: 'warehouse', entityType: 'stock_movement', entityId: id })

    return { stockMovement: confirmed }
  }, { isSignIn: true })
