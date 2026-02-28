import { Elysia } from 'elysia'
import { AuthService } from '../../auth/auth.service.js'
import { payslipDao } from 'services/dao/payroll/payslip.dao'
import { Payslip } from 'db/models'
import { paginateQuery } from 'services/utils/pagination'

export const payslipController = new Elysia({ prefix: '/org/:orgId/payroll/payslip' })
  .use(AuthService)
  .get('/', async ({ params: { orgId }, query }) => {
    const filter: Record<string, any> = { orgId }
    const result = await paginateQuery(Payslip, filter, query)
    return { payslips: result.items, ...result }
  }, { isSignIn: true })
  .get('/:id', async ({ params }) => {
    const item = await payslipDao.findById(params.id)
    return { item }
  }, { isSignIn: true })
  .post('/', async ({ params, body }) => {
    const item = await payslipDao.create({ ...body, orgId: params.orgId })
    return { item }
  }, { isSignIn: true })
  .put('/:id', async ({ params, body }) => {
    const item = await payslipDao.update(params.id, body)
    return { item }
  }, { isSignIn: true })
  .delete('/:id', async ({ params }) => {
    await payslipDao.delete(params.id)
    return { success: true }
  }, { isSignIn: true })
