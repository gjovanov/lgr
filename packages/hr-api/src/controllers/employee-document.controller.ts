import { Elysia } from 'elysia'
import { AppAuthService } from '../auth/app-auth.service.js'
import { getRepos } from 'services/context'
import { createAuditEntry, diffChanges } from 'services/biz/audit-log.service'

export const employeeDocumentController = new Elysia({ prefix: '/org/:orgId/hr/employee-document' })
  .use(AppAuthService)
  .get('/', async ({ params: { orgId }, query }) => {
    const r = getRepos()
    const filter: Record<string, any> = { orgId }

    const page = Math.max(0, Number(query.page) || 0)
    const size = query.size !== undefined ? Number(query.size) : 10
    const sortBy = (query.sortBy as string) || 'createdAt'
    const sortOrder = (query.sortOrder as string) === 'asc' ? 1 : -1

    const result = await r.employeeDocuments.findAll(filter, { page, size, sort: { [sortBy]: sortOrder } })
    return { employeeDocuments: result.items, ...result }
  }, { isSignIn: true })
  .get('/:id', async ({ params }) => {
    const r = getRepos()
    const item = await r.employeeDocuments.findById(params.id)
    return { employeeDocument: item }
  }, { isSignIn: true })
  .post('/', async ({ params, body, user }) => {
    const r = getRepos()
    const item = await r.employeeDocuments.create({ ...body, orgId: params.orgId, createdBy: user.id } as any)

    createAuditEntry({ orgId: params.orgId, userId: user.id, action: 'create', module: 'hr', entityType: 'employee_document', entityId: item.id, entityName: (item as any).name || (item as any).title })

    return { employeeDocument: item }
  }, { isSignIn: true })
  .put('/:id', async ({ params, body, user }) => {
    const r = getRepos()
    const existing = await r.employeeDocuments.findById(params.id)
    const item = await r.employeeDocuments.update(params.id, body as any)

    createAuditEntry({ orgId: params.orgId, userId: user.id, action: 'update', module: 'hr', entityType: 'employee_document', entityId: params.id, entityName: (item as any).name || (item as any).title, changes: existing ? diffChanges(existing as any, item as any) : undefined })

    return { employeeDocument: item }
  }, { isSignIn: true })
  .delete('/:id', async ({ params, user }) => {
    const r = getRepos()
    const existing = await r.employeeDocuments.findById(params.id)
    await r.employeeDocuments.delete(params.id)

    createAuditEntry({ orgId: params.orgId, userId: user.id, action: 'delete', module: 'hr', entityType: 'employee_document', entityId: params.id, entityName: (existing as any)?.name || (existing as any)?.title })

    return { success: true }
  }, { isSignIn: true })
