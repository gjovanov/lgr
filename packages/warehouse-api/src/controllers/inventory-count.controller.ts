import { Elysia } from 'elysia'
import { AppAuthService } from '../auth/app-auth.service.js'
import { getRepos } from 'services/context'
import { confirmMovement } from 'services/biz/warehouse.service'

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

export const inventoryCountController = new Elysia({ prefix: '/org/:orgId/warehouse/inventory-count' })
  .use(AppAuthService)
  .get('/', async ({ params: { orgId }, query }) => {
    const r = getRepos()

    const filter: Record<string, any> = { orgId }
    if (query.productId) filter['lines.productId'] = query.productId

    const page = Math.max(0, Number(query.page) || 0)
    const size = query.size !== undefined ? Number(query.size) : 10
    const sortBy = (query.sortBy as string) || 'createdAt'
    const sortOrder = (query.sortOrder as string) === 'asc' ? 1 : -1

    const result = await r.inventoryCounts.findAll(filter, { page, size, sort: { [sortBy]: sortOrder } })

    // Lookup warehouse names
    const whIds = new Set<string>()
    for (const ic of result.items) if (ic.warehouseId) whIds.add(ic.warehouseId)
    const warehouses = whIds.size > 0 ? await r.warehouses.findMany({ id: { $in: [...whIds] } } as any) : []
    const whMap = new Map(warehouses.map(w => [w.id, w]))

    const inventoryCounts = result.items.map(ic => ({
      ...ic,
      number: ic.countNumber,
      warehouseName: whMap.get(ic.warehouseId)?.name || '',
      itemCount: ic.lines?.length || 0,
      varianceCount: ic.lines?.filter(l => l.variance !== 0).length || 0,
    }))

    return { inventoryCounts, total: result.total, page: result.page, size: result.size, totalPages: result.totalPages }
  }, { isSignIn: true })
  .get('/:id', async ({ params }) => {
    const r = getRepos()

    const doc = await r.inventoryCounts.findById(params.id)
    if (!doc) return { inventoryCount: null }

    // Lookup product names for lines
    const productIds = new Set<string>()
    for (const l of doc.lines) if (l.productId) productIds.add(l.productId)
    const products = productIds.size > 0
      ? await r.products.findMany({ id: { $in: [...productIds] } } as any)
      : []
    const productMap = new Map(products.map(p => [p.id, p]))

    const lines = doc.lines.map(l => ({
      ...l,
      productName: productMap.get(l.productId)?.name || '',
      productSku: productMap.get(l.productId)?.sku || '',
    }))

    return { inventoryCount: { ...doc, lines } }
  }, { isSignIn: true })
  .post('/', async ({ params, body, user }) => {
    const r = getRepos()
    const countNumber = await getNextCountNumber(params.orgId)
    const item = await r.inventoryCounts.create({ ...body, orgId: params.orgId, createdBy: user.id, countNumber } as any)
    return { inventoryCount: item }
  }, { isSignIn: true })
  .put('/:id', async ({ params, body }) => {
    const r = getRepos()
    const item = await r.inventoryCounts.update(params.id, body as any)
    return { inventoryCount: item }
  }, { isSignIn: true })
  .delete('/:id', async ({ params }) => {
    const r = getRepos()
    await r.inventoryCounts.delete(params.id)
    return { success: true }
  }, { isSignIn: true })
  .post('/:id/complete', async ({ params: { orgId, id }, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    const r = getRepos()

    const doc = await r.inventoryCounts.findOne({ id, orgId } as any)
    if (!doc) return status(404, { message: 'Inventory count not found' })
    if (doc.status === 'completed') return status(400, { message: 'Already completed' })

    // Build adjustment lines for products with non-zero variance
    const varianceLines = doc.lines.filter(line => line.variance !== 0)

    let adjustmentMovementId: string | undefined
    if (varianceLines.length > 0) {
      const movementNumber = await getNextMovementNumber(orgId)
      const totalAmount = varianceLines.reduce((s, l) => s + Math.abs(l.varianceCost), 0)

      const movement = await r.stockMovements.create({
        orgId,
        movementNumber,
        type: 'adjustment',
        status: 'draft',
        date: new Date(),
        toWarehouseId: doc.warehouseId,
        lines: varianceLines.map(l => {
          const absCost = l.varianceCost !== 0 && l.variance !== 0
            ? Math.abs(l.varianceCost / l.variance)
            : 0
          return {
            productId: l.productId,
            quantity: l.variance,
            unitCost: absCost,
            totalCost: Math.abs(l.varianceCost),
          }
        }),
        totalAmount,
        notes: `Inventory count adjustment for ${doc.countNumber}`,
        createdBy: user.id,
      } as any)

      await confirmMovement(movement.id, r)
      adjustmentMovementId = movement.id
    } else {
      // No variance — update lastCountDate on stock levels
      for (const line of doc.lines) {
        const sl = await r.stockLevels.findOne({ orgId, productId: line.productId, warehouseId: doc.warehouseId } as any)
        if (sl) {
          await r.stockLevels.update(sl.id, { lastCountDate: new Date() } as any)
        }
      }
    }

    const completed = await r.inventoryCounts.update(id, {
      status: 'completed',
      completedAt: new Date(),
      completedBy: user.id,
      ...(adjustmentMovementId ? { adjustmentMovementId } : {}),
    } as any)

    return { inventoryCount: completed }
  }, { isSignIn: true })
