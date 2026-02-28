import { Elysia } from 'elysia'
import { AuthService } from '../../auth/auth.service.js'
import { bankAccountDao } from 'services/dao/accounting/bank-account.dao'
import { BankAccount } from 'db/models'
import { paginateQuery } from 'services/utils/pagination'

export const bankAccountController = new Elysia({ prefix: '/org/:orgId/accounting/bank-account' })
  .use(AuthService)
  .get('/', async ({ params, query }) => {
    const filter: Record<string, any> = { orgId: params.orgId }
    const result = await paginateQuery(BankAccount, filter, query)
    return { bankAccounts: result.items, ...result }
  }, { isSignIn: true })
  .get('/:id', async ({ params }) => {
    const item = await bankAccountDao.findById(params.id)
    return { item }
  }, { isSignIn: true })
  .post('/', async ({ params, body }) => {
    const item = await bankAccountDao.create({ ...body, orgId: params.orgId })
    return { item }
  }, { isSignIn: true })
  .put('/:id', async ({ params, body }) => {
    const item = await bankAccountDao.update(params.id, body)
    return { item }
  }, { isSignIn: true })
  .delete('/:id', async ({ params }) => {
    await bankAccountDao.delete(params.id)
    return { success: true }
  }, { isSignIn: true })
