import { Elysia } from 'elysia'
import { AuthService } from '../../auth/auth.service.js'
import { employeeDocumentDao } from 'services/dao/hr/employee-document.dao'

export const employeeDocumentController = new Elysia({ prefix: '/org/:orgId/hr/employee-document' })
  .use(AuthService)
  .get('/', async ({ params }) => {
    const items = await employeeDocumentDao.findByOrgId(params.orgId)
    return { documents: items }
  }, { isSignIn: true })
  .get('/:id', async ({ params }) => {
    const item = await employeeDocumentDao.findById(params.id)
    return { item }
  }, { isSignIn: true })
  .post('/', async ({ params, body }) => {
    const item = await employeeDocumentDao.create({ ...body, orgId: params.orgId })
    return { item }
  }, { isSignIn: true })
  .put('/:id', async ({ params, body }) => {
    const item = await employeeDocumentDao.update(params.id, body)
    return { item }
  }, { isSignIn: true })
  .delete('/:id', async ({ params }) => {
    await employeeDocumentDao.delete(params.id)
    return { success: true }
  }, { isSignIn: true })
