import { Elysia } from 'elysia'
import { AuthService } from '../../auth/auth.service.js'
import { taxReturnDao } from 'services/dao/accounting/tax-return.dao'
import { TaxReturn } from 'db/models'
import { paginateQuery } from 'services/utils/pagination'

export const taxReturnController = new Elysia({ prefix: '/org/:orgId/accounting/tax-return' })
  .use(AuthService)
  .get('/', async ({ params, query }) => {
    const filter: Record<string, any> = { orgId: params.orgId }
    const result = await paginateQuery(TaxReturn, filter, query)
    return { taxReturns: result.items, ...result }
  }, { isSignIn: true })
  .get('/:id', async ({ params }) => {
    const item = await taxReturnDao.findById(params.id)
    return { item }
  }, { isSignIn: true })
  .post('/', async ({ params, body }) => {
    const item = await taxReturnDao.create({ ...body, orgId: params.orgId })
    return { item }
  }, { isSignIn: true })
  .put('/:id', async ({ params, body }) => {
    const item = await taxReturnDao.update(params.id, body)
    return { item }
  }, { isSignIn: true })
  .delete('/:id', async ({ params }) => {
    await taxReturnDao.delete(params.id)
    return { success: true }
  }, { isSignIn: true })
