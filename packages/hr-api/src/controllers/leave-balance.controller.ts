import { Elysia } from 'elysia'
import { AppAuthService } from '../auth/app-auth.service.js'
import { leaveBalanceDao } from 'services/dao/hr/leave-balance.dao'

export const leaveBalanceController = new Elysia({ prefix: '/org/:orgId/hr/leave-balance' })
  .use(AppAuthService)
  .get('/', async ({ params }) => {
    const items = await leaveBalanceDao.findByOrgId(params.orgId)
    return { leaveBalances: items }
  }, { isSignIn: true })
