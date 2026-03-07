import { Elysia } from 'elysia'
import { AppAuthService } from '../auth/app-auth.service.js'
import { getRepos } from 'services/context'

export const payslipController = new Elysia({ prefix: '/org/:orgId/payroll/payslip' })
  .use(AppAuthService)
  .get('/', async ({ params: { orgId }, query }) => {
    const r = getRepos()
    const filter: Record<string, any> = { orgId }

    const page = Math.max(0, Number(query.page) || 0)
    const size = query.size !== undefined ? Number(query.size) : 10
    const sortBy = (query.sortBy as string) || 'createdAt'
    const sortOrder = (query.sortOrder as string) === 'asc' ? 1 : -1

    const result = await r.payslips.findAll(filter, { page, size, sort: { [sortBy]: sortOrder } })
    return { payslips: result.items, ...result }
  }, { isSignIn: true })
  .get('/:id', async ({ params }) => {
    const r = getRepos()
    const item = await r.payslips.findById(params.id)
    return { payslip: item }
  }, { isSignIn: true })
  .post('/', async ({ params, body }) => {
    const r = getRepos()
    const item = await r.payslips.create({ ...body, orgId: params.orgId } as any)
    return { payslip: item }
  }, { isSignIn: true })
  .put('/:id', async ({ params, body }) => {
    const r = getRepos()
    const item = await r.payslips.update(params.id, body as any)
    return { payslip: item }
  }, { isSignIn: true })
  .delete('/:id', async ({ params }) => {
    const r = getRepos()
    await r.payslips.delete(params.id)
    return { success: true }
  }, { isSignIn: true })
