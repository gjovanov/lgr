import { Elysia } from 'elysia'
import { AppAuthService } from '../auth/app-auth.service.js'
import { LeaveBalance } from 'db/models'
import { paginateQuery } from 'services/utils/pagination'

export const leaveBalanceController = new Elysia({ prefix: '/org/:orgId/hr/leave-balance' })
  .use(AppAuthService)
  .get('/', async ({ params: { orgId }, query }) => {
    const filter: Record<string, any> = { orgId }
    const result = await paginateQuery(LeaveBalance, filter, query)
    return { leaveBalances: result.items, ...result }
  }, { isSignIn: true })
