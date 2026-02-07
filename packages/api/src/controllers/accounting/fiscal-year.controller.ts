import { Elysia } from 'elysia'
import { AuthService } from '../../auth/auth.service.js'
import { fiscalYearDao } from 'services/dao/accounting/fiscal-year.dao'

export const fiscalYearController = new Elysia({ prefix: '/org/:orgId/accounting/fiscal-year' })
  .use(AuthService)
  .get('/', async ({ params }) => {
    const items = await fiscalYearDao.findByOrgId(params.orgId)
    return { fiscalYears: items }
  }, { isSignIn: true })
  .get('/:id', async ({ params }) => {
    const item = await fiscalYearDao.findById(params.id)
    return { item }
  }, { isSignIn: true })
  .post('/', async ({ params, body }) => {
    const item = await fiscalYearDao.create({ ...body, orgId: params.orgId })
    return { item }
  }, { isSignIn: true })
  .put('/:id', async ({ params, body }) => {
    const item = await fiscalYearDao.update(params.id, body)
    return { item }
  }, { isSignIn: true })
  .delete('/:id', async ({ params }) => {
    await fiscalYearDao.delete(params.id)
    return { success: true }
  }, { isSignIn: true })
