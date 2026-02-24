import { Elysia } from 'elysia'
import { AppAuthService } from '../auth/app-auth.service.js'
import { bankAccountDao } from 'services/dao/accounting/bank-account.dao'

export const bankAccountController = new Elysia({ prefix: '/org/:orgId/accounting/bank-account' })
  .use(AppAuthService)
  .get('/', async ({ params }) => {
    const items = await bankAccountDao.findAllByOrgId(params.orgId)
    return { bankAccounts: items }
  }, { isSignIn: true })
  .get('/:id', async ({ params }) => {
    const item = await bankAccountDao.findById(params.id)
    return { bankAccount: item }
  }, { isSignIn: true })
  .post('/', async ({ params, body }) => {
    const item = await bankAccountDao.create({ ...body, orgId: params.orgId })
    return { bankAccount: item }
  }, { isSignIn: true })
  .put('/:id', async ({ params, body }) => {
    const item = await bankAccountDao.update(params.id, body)
    return { bankAccount: item }
  }, { isSignIn: true })
  .delete('/:id', async ({ params }) => {
    await bankAccountDao.delete(params.id)
    return { success: true }
  }, { isSignIn: true })
