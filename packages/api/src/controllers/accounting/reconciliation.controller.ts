import { Elysia } from 'elysia'
import { AuthService } from '../../auth/auth.service.js'
import { bankReconciliationDao } from 'services/dao/accounting/bank-reconciliation.dao'

export const reconciliationController = new Elysia({ prefix: '/org/:orgId/accounting/reconciliation' })
  .use(AuthService)
  .get('/', async ({ params }) => {
    const items = await bankReconciliationDao.findByOrgId(params.orgId)
    return { reconciliations: items }
  }, { isSignIn: true })
  .get('/:id', async ({ params }) => {
    const item = await bankReconciliationDao.findById(params.id)
    return { item }
  }, { isSignIn: true })
  .post('/', async ({ params, body }) => {
    const item = await bankReconciliationDao.create({ ...body, orgId: params.orgId })
    return { item }
  }, { isSignIn: true })
  .put('/:id', async ({ params, body }) => {
    const item = await bankReconciliationDao.update(params.id, body)
    return { item }
  }, { isSignIn: true })
  .delete('/:id', async ({ params }) => {
    await bankReconciliationDao.delete(params.id)
    return { success: true }
  }, { isSignIn: true })
