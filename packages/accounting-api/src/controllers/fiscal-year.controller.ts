import { Elysia } from 'elysia'
import { AppAuthService } from '../auth/app-auth.service.js'
import { fiscalYearDao } from 'services/dao/accounting/fiscal-year.dao'
import { FiscalYear } from 'db/models'
import { paginateQuery } from 'services/utils/pagination'

export const fiscalYearController = new Elysia({ prefix: '/org/:orgId/accounting/fiscal-year' })
  .use(AppAuthService)
  .get('/', async ({ params, query }) => {
    const filter: Record<string, any> = { orgId: params.orgId }
    const result = await paginateQuery(FiscalYear, filter, query)
    return { fiscalYears: result.items, ...result }
  }, { isSignIn: true })
  .get('/:id', async ({ params }) => {
    const item = await fiscalYearDao.findById(params.id)
    return { fiscalYear: item }
  }, { isSignIn: true })
  .post('/', async ({ params, body }) => {
    const item = await fiscalYearDao.create({ ...body, orgId: params.orgId })
    return { fiscalYear: item }
  }, { isSignIn: true })
  .put('/:id', async ({ params, body }) => {
    const item = await fiscalYearDao.update(params.id, body)
    return { fiscalYear: item }
  }, { isSignIn: true })
  .delete('/:id', async ({ params }) => {
    await fiscalYearDao.delete(params.id)
    return { success: true }
  }, { isSignIn: true })
