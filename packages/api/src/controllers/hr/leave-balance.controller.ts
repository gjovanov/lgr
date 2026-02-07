import { Elysia } from 'elysia'
import { AuthService } from '../../auth/auth.service.js'
import { leaveBalanceDao } from 'services/dao/hr/leave-balance.dao'

export const leaveBalanceController = new Elysia({ prefix: '/org/:orgId/hr/leave-balance' })
  .use(AuthService)
  .get('/', async ({ params }) => {
    const items = await leaveBalanceDao.findByOrgId(params.orgId)
    return { leaveBalances: items }
  }, { isSignIn: true })
