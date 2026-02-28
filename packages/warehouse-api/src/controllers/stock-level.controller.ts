import { Elysia } from 'elysia'
import { AppAuthService } from '../auth/app-auth.service.js'
import { StockLevel } from 'db/models'
import { paginateQuery } from 'services/utils/pagination'

export const stockLevelController = new Elysia({ prefix: '/org/:orgId/warehouse/stock-level' })
  .use(AppAuthService)
  .get('/', async ({ params: { orgId }, query }) => {
    const filter: Record<string, any> = { orgId }
    const result = await paginateQuery(StockLevel, filter, query)
    return { stockLevels: result.items, ...result }
  }, { isSignIn: true })
