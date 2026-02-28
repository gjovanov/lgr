import { Elysia } from 'elysia'
import { AppAuthService } from '../auth/app-auth.service.js'
import { bankReconciliationDao } from 'services/dao/accounting/bank-reconciliation.dao'
import { BankReconciliation } from 'db/models'
import { paginateQuery } from 'services/utils/pagination'

export const reconciliationController = new Elysia({ prefix: '/org/:orgId/accounting/reconciliation' })
  .use(AppAuthService)
  .get('/', async ({ params, query }) => {
    const filter: Record<string, any> = { orgId: params.orgId }
    const result = await paginateQuery(BankReconciliation, filter, query)
    return { reconciliations: result.items, ...result }
  }, { isSignIn: true })
  .get('/:id', async ({ params }) => {
    const item = await bankReconciliationDao.findById(params.id)
    return { bankReconciliation: item }
  }, { isSignIn: true })
  .post('/', async ({ params, body }) => {
    const item = await bankReconciliationDao.create({ ...body, orgId: params.orgId })
    return { bankReconciliation: item }
  }, { isSignIn: true })
  .put('/:id', async ({ params, body }) => {
    const item = await bankReconciliationDao.update(params.id, body)
    return { bankReconciliation: item }
  }, { isSignIn: true })
  .delete('/:id', async ({ params }) => {
    await bankReconciliationDao.delete(params.id)
    return { success: true }
  }, { isSignIn: true })
