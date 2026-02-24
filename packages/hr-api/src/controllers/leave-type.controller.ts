import { Elysia } from 'elysia'
import { AppAuthService } from '../auth/app-auth.service.js'
import { leaveTypeDao } from 'services/dao/hr/leave-type.dao'

export const leaveTypeController = new Elysia({ prefix: '/org/:orgId/hr/leave-type' })
  .use(AppAuthService)
  .get('/', async ({ params }) => {
    const items = await leaveTypeDao.findByOrgId(params.orgId)
    return { leaveTypes: items }
  }, { isSignIn: true })
  .get('/:id', async ({ params }) => {
    const item = await leaveTypeDao.findById(params.id)
    return { leaveType: item }
  }, { isSignIn: true })
  .post('/', async ({ params, body }) => {
    const item = await leaveTypeDao.create({ ...body, orgId: params.orgId })
    return { leaveType: item }
  }, { isSignIn: true })
  .put('/:id', async ({ params, body }) => {
    const item = await leaveTypeDao.update(params.id, body)
    return { leaveType: item }
  }, { isSignIn: true })
  .delete('/:id', async ({ params }) => {
    await leaveTypeDao.delete(params.id)
    return { success: true }
  }, { isSignIn: true })
