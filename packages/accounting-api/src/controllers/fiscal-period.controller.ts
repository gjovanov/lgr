import { Elysia } from 'elysia'
import { AppAuthService } from '../auth/app-auth.service.js'
import { fiscalPeriodDao } from 'services/dao/accounting/fiscal-period.dao'

export const fiscalPeriodController = new Elysia({ prefix: '/org/:orgId/accounting/fiscal-period' })
  .use(AppAuthService)
  .get('/', async ({ params }) => {
    const items = await fiscalPeriodDao.findByOrgId(params.orgId)
    return { fiscalPeriods: items }
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
