import { Elysia } from 'elysia'
import { AppAuthService } from '../auth/app-auth.service.js'
import { taxReturnDao } from 'services/dao/accounting/tax-return.dao'

export const taxReturnController = new Elysia({ prefix: '/org/:orgId/accounting/tax-return' })
  .use(AppAuthService)
  .get('/', async ({ params }) => {
    const items = await taxReturnDao.findByOrgId(params.orgId)
    return { taxReturns: items }
  }, { isSignIn: true })
  .get('/:id', async ({ params }) => {
    const item = await taxReturnDao.findById(params.id)
    return { taxReturn: item }
  }, { isSignIn: true })
  .post('/', async ({ params, body }) => {
    const item = await taxReturnDao.create({ ...body, orgId: params.orgId })
    return { taxReturn: item }
  }, { isSignIn: true })
  .put('/:id', async ({ params, body }) => {
    const item = await taxReturnDao.update(params.id, body)
    return { taxReturn: item }
  }, { isSignIn: true })
  .delete('/:id', async ({ params }) => {
    await taxReturnDao.delete(params.id)
    return { success: true }
  }, { isSignIn: true })
