import { Elysia } from 'elysia'
import { AppAuthService } from '../auth/app-auth.service.js'
import { employeeDocumentDao } from 'services/dao/hr/employee-document.dao'
import { EmployeeDocument } from 'db/models'
import { paginateQuery } from 'services/utils/pagination'

export const employeeDocumentController = new Elysia({ prefix: '/org/:orgId/hr/employee-document' })
  .use(AppAuthService)
  .get('/', async ({ params: { orgId }, query }) => {
    const filter: Record<string, any> = { orgId }
    const result = await paginateQuery(EmployeeDocument, filter, query)
    return { employeeDocuments: result.items, ...result }
  }, { isSignIn: true })
  .get('/:id', async ({ params }) => {
    const item = await employeeDocumentDao.findById(params.id)
    return { employeeDocument: item }
  }, { isSignIn: true })
  .post('/', async ({ params, body, user }) => {
    const item = await employeeDocumentDao.create({ ...body, orgId: params.orgId, createdBy: user.id })
    return { employeeDocument: item }
  }, { isSignIn: true })
  .put('/:id', async ({ params, body }) => {
    const item = await employeeDocumentDao.update(params.id, body)
    return { employeeDocument: item }
  }, { isSignIn: true })
  .delete('/:id', async ({ params }) => {
    await employeeDocumentDao.delete(params.id)
    return { success: true }
  }, { isSignIn: true })
