import { Elysia, t } from 'elysia'
import { AppAuthService } from '../auth/app-auth.service.js'
import { getRepos } from 'services/context'
import { getInventoryValuation, initializeCostLayers } from 'services/biz/costing.service'
import { can } from 'services/biz/access/evaluate'

/** FR-27.6 (A.4 note 8): a product's cost layers are its cost figures; a role without `products.costs` is refused. */
const costsRefused = { code: 'capability_required', capabilities: ['products.costs'], message: 'Cost figures are not part of your role.' }

export const costLayerController = new Elysia({ prefix: '/org/:orgId/warehouse/cost-layer' })
  .use(AppAuthService)
  .onBeforeHandle(({ user, status }: any) => {
    if (user && !can(user, 'products.costs')) return status(403, costsRefused)
  })
  .get('/', async ({ params: { orgId }, query, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    const r = getRepos()

    const filter: Record<string, any> = { orgId }
    if (query.productId) filter.productId = query.productId
    if (query.warehouseId) filter.warehouseId = query.warehouseId
    if (query.isExhausted === 'false') filter.isExhausted = false
    if (query.isExhausted === 'true') filter.isExhausted = true

    const page = Math.max(0, Number(query.page) || 0)
    const size = query.size !== undefined ? Number(query.size) : 25
    const sortBy = (query.sortBy as string) || 'receivedAt'
    const sortOrder = (query.sortOrder as string) === 'asc' ? 1 : -1

    const result = await r.costLayers.findAll(filter, { page, size, sort: { [sortBy]: sortOrder } })
    return { costLayers: result.items, ...result }
  }, { isSignIn: true })
  .get('/valuation', async ({ params: { orgId }, query, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    return getInventoryValuation(orgId, query.warehouseId as string, query.productId as string)
  }, { isSignIn: true })
  .get('/product/:productId', async ({ params: { orgId, productId }, query, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    const r = getRepos()

    const filter: Record<string, any> = { orgId, productId }
    if (query.warehouseId) filter.warehouseId = query.warehouseId
    if (query.isExhausted === 'false') filter.isExhausted = false

    const layers = await r.costLayers.findMany(filter, { receivedAt: 1 })
    return { costLayers: layers }
  }, { isSignIn: true })
  .post(
    '/initialize/:productId',
    async ({ params: { orgId, productId }, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })
      const created = await initializeCostLayers(orgId, productId)
      return { message: `${created} cost layers initialized`, layersCreated: created }
    },
    { isSignIn: true },
  )
