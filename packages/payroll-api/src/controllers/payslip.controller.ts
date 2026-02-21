import { Elysia } from 'elysia'
import { AppAuthService } from '../auth/app-auth.service.js'
import { payslipDao } from 'services/dao/payroll/payslip.dao'

export const payslipController = new Elysia({ prefix: '/org/:orgId/payroll/payslip' })
  .use(AppAuthService)
  .get('/', async ({ params }) => {
    const items = await payslipDao.findByOrgId(params.orgId)
    return { payslips: items }
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
