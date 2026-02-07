import { Elysia } from 'elysia'
import { AuthService } from '../../auth/auth.service.js'
import { taxReturnDao } from 'services/dao/accounting/tax-return.dao'

export const taxReturnController = new Elysia({ prefix: '/org/:orgId/accounting/tax-return' })
  .use(AuthService)
  .get('/', async ({ params }) => {
    const items = await taxReturnDao.findByOrgId(params.orgId)
    return { taxReturns: items }
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
