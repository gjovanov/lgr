import { Elysia } from 'elysia'
import { AppAuthService } from '../auth/app-auth.service.js'
import { stockLevelDao } from 'services/dao/warehouse/stock-level.dao'

export const stockLevelController = new Elysia({ prefix: '/org/:orgId/warehouse/stock-level' })
  .use(AppAuthService)
  .get('/', async ({ params }) => {
    const items = await stockLevelDao.findByOrgId(params.orgId)
    return { stockLevels: items }
  }, { isSignIn: true })
