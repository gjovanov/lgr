import { Elysia } from 'elysia'
import { AppAuthService } from '../auth/app-auth.service.js'
import { timesheetDao } from 'services/dao/payroll/timesheet.dao'

export const timesheetController = new Elysia({ prefix: '/org/:orgId/payroll/timesheet' })
  .use(AppAuthService)
  .get('/', async ({ params }) => {
    const items = await timesheetDao.findByOrgId(params.orgId)
    return { timesheets: items }
  }, { isSignIn: true })
  .get('/:id', async ({ params }) => {
    const item = await timesheetDao.findById(params.id)
    return { item }
  }, { isSignIn: true })
  .post('/', async ({ params, body }) => {
    const item = await timesheetDao.create({ ...body, orgId: params.orgId })
    return { item }
  }, { isSignIn: true })
  .put('/:id', async ({ params, body }) => {
    const item = await timesheetDao.update(params.id, body)
    return { item }
  }, { isSignIn: true })
  .delete('/:id', async ({ params }) => {
    await timesheetDao.delete(params.id)
    return { success: true }
  }, { isSignIn: true })
