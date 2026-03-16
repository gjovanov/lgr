import { Elysia, t } from 'elysia'
import { AppAuthService } from '../auth/app-auth.service.js'
import { getRepos } from 'services/context'
import { createAuditEntry, diffChanges } from 'services/biz/audit-log.service'

async function upsertTags(orgId: string, type: string, tags?: string[]) {
  if (!tags?.length) return
  const r = getRepos()
  for (const value of tags) {
    const existing = await r.tags.findOne({ orgId, type, value } as any)
    if (!existing) await r.tags.create({ orgId, type, value } as any)
  }
}

export const employeeController = new Elysia({ prefix: '/org/:orgId/payroll/employee' })
  .use(AppAuthService)
  .get('/', async ({ params: { orgId }, query, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    const r = getRepos()

    const filter: Record<string, any> = { orgId }
    if (query.status) filter.status = query.status
    if (query.department) filter.department = query.department
    if (query.tags) {
      const tagList = Array.isArray(query.tags) ? query.tags : (query.tags as string).split(',')
      filter.tags = { $in: tagList }
    }

    const page = Math.max(0, Number(query.page) || 0)
    const size = query.size !== undefined ? Number(query.size) : 10
    const sortBy = (query.sortBy as string) || 'createdAt'
    const sortOrder = (query.sortOrder as string) === 'asc' ? 1 : -1

    const result = await r.employees.findAll(filter, { page, size, sort: { [sortBy]: sortOrder } })
    return { employees: result.items, ...result }
  }, { isSignIn: true })
  .post(
    '/',
    async ({ params: { orgId }, body, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })
      const r = getRepos()

      const employee = await r.employees.create({ ...body, orgId } as any)
      await upsertTags(orgId, 'employee', body.tags)

      createAuditEntry({ orgId, userId: user.id, action: 'create', module: 'payroll', entityType: 'employee', entityId: employee.id, entityName: `${(employee as any).firstName} ${(employee as any).lastName}` })

      return { employee }
    },
    {
      isSignIn: true,
      body: t.Object({
        employeeNumber: t.String({ minLength: 1 }),
        firstName: t.String({ minLength: 1 }),
        lastName: t.String({ minLength: 1 }),
        email: t.Optional(t.String({ format: 'email' })),
        phone: t.Optional(t.String()),
        dateOfBirth: t.Optional(t.String()),
        gender: t.Optional(t.Union([
          t.Literal('male'),
          t.Literal('female'),
          t.Literal('other'),
        ])),
        nationalId: t.Optional(t.String()),
        taxId: t.Optional(t.String()),
        department: t.String({ minLength: 1 }),
        position: t.String({ minLength: 1 }),
        managerId: t.Optional(t.String()),
        employmentType: t.Union([
          t.Literal('full_time'),
          t.Literal('part_time'),
          t.Literal('contract'),
          t.Literal('intern'),
        ]),
        contractStartDate: t.String(),
        contractEndDate: t.Optional(t.String()),
        salary: t.Object({
          baseSalary: t.Number(),
          currency: t.String(),
          frequency: t.Union([
            t.Literal('monthly'),
            t.Literal('biweekly'),
            t.Literal('weekly'),
            t.Literal('hourly'),
          ]),
          hourlyRate: t.Optional(t.Number()),
          bankAccountNumber: t.Optional(t.String()),
          bankName: t.Optional(t.String()),
          iban: t.Optional(t.String()),
        }),
        notes: t.Optional(t.String()),
        tags: t.Optional(t.Array(t.String())),
      }),
    },
  )
  .get('/:id', async ({ params: { orgId, id }, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    const r = getRepos()

    const employee = await r.employees.findOne({ id, orgId } as any)
    if (!employee) return status(404, { message: 'Employee not found' })

    return { employee }
  }, { isSignIn: true })
  .put(
    '/:id',
    async ({ params: { orgId, id }, body, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })
      if (!['admin', 'hr_manager'].includes(user.role))
        return status(403, { message: 'Admin or HR manager only' })
      const r = getRepos()

      const existing = await r.employees.findOne({ id, orgId } as any)
      if (!existing) return status(404, { message: 'Employee not found' })

      const employee = await r.employees.update(id, body as any)
      await upsertTags(orgId, 'employee', body.tags)

      createAuditEntry({ orgId, userId: user.id, action: 'update', module: 'payroll', entityType: 'employee', entityId: id, entityName: `${(employee as any).firstName} ${(employee as any).lastName}`, changes: diffChanges(existing as any, employee as any) })

      return { employee }
    },
    {
      isSignIn: true,
      body: t.Object({
        firstName: t.Optional(t.String()),
        lastName: t.Optional(t.String()),
        email: t.Optional(t.String({ format: 'email' })),
        phone: t.Optional(t.String()),
        department: t.Optional(t.String()),
        position: t.Optional(t.String()),
        managerId: t.Optional(t.String()),
        contractEndDate: t.Optional(t.String()),
        status: t.Optional(t.Union([
          t.Literal('active'),
          t.Literal('on_leave'),
          t.Literal('terminated'),
          t.Literal('suspended'),
        ])),
        salary: t.Optional(t.Object({
          baseSalary: t.Optional(t.Number()),
          currency: t.Optional(t.String()),
          frequency: t.Optional(t.Union([
            t.Literal('monthly'),
            t.Literal('biweekly'),
            t.Literal('weekly'),
            t.Literal('hourly'),
          ])),
          hourlyRate: t.Optional(t.Number()),
          bankAccountNumber: t.Optional(t.String()),
          bankName: t.Optional(t.String()),
          iban: t.Optional(t.String()),
        })),
        notes: t.Optional(t.String()),
        tags: t.Optional(t.Array(t.String())),
      }),
    },
  )
  .delete('/:id', async ({ params: { orgId, id }, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    if (!['admin', 'hr_manager'].includes(user.role))
      return status(403, { message: 'Admin or HR manager only' })
    const r = getRepos()

    const existing = await r.employees.findOne({ id, orgId } as any)
    if (!existing) return status(404, { message: 'Employee not found' })

    await r.employees.update(id, { status: 'terminated', terminationDate: new Date() } as any)

    createAuditEntry({ orgId, userId: user.id, action: 'delete', module: 'payroll', entityType: 'employee', entityId: id, entityName: `${(existing as any).firstName} ${(existing as any).lastName}` })

    return { message: 'Employee terminated' }
  }, { isSignIn: true })
