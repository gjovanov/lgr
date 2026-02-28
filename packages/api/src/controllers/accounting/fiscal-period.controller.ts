import { Elysia } from 'elysia'
import { AuthService } from '../../auth/auth.service.js'
import { fiscalPeriodDao } from 'services/dao/accounting/fiscal-period.dao'
import { FiscalPeriod } from 'db/models'
import { paginateQuery } from 'services/utils/pagination'

export const fiscalPeriodController = new Elysia({ prefix: '/org/:orgId/accounting/fiscal-period' })
  .use(AuthService)
  .get('/', async ({ params, query }) => {
    const filter: Record<string, any> = { orgId: params.orgId }
    const result = await paginateQuery(FiscalPeriod, filter, query)
    return { fiscalPeriods: result.items, ...result }
  }, { isSignIn: true })
  .get('/:id', async ({ params }) => {
    const item = await fiscalPeriodDao.findById(params.id)
    return { item }
  }, { isSignIn: true })
  .post('/', async ({ params, body }) => {
    const item = await fiscalPeriodDao.create({ ...body, orgId: params.orgId })
    return { item }
  }, { isSignIn: true })
  .put('/:id', async ({ params, body }) => {
    const item = await fiscalPeriodDao.update(params.id, body)
    return { item }
  }, { isSignIn: true })
  .delete('/:id', async ({ params }) => {
    await fiscalPeriodDao.delete(params.id)
    return { success: true }
  }, { isSignIn: true })
