import { Elysia, t } from 'elysia'
import { AppAuthService } from '../auth/app-auth.service.js'
import { Employee } from 'db/models'

export const employeeController = new Elysia({ prefix: '/org/:orgId/payroll/employee' })
  .use(AppAuthService)
  .get('/', async ({ params: { orgId }, query, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })

    const filter: Record<string, any> = { orgId }
    if (query.status) filter.status = query.status
    if (query.department) filter.department = query.department

    const page = Number(query.page) || 1
    const pageSize = Number(query.pageSize) || 50
    const skip = (page - 1) * pageSize

    const [data, total] = await Promise.all([
      Employee.find(filter).sort({ lastName: 1, firstName: 1 }).skip(skip).limit(pageSize).exec(),
      Employee.countDocuments(filter).exec(),
    ])

    return { employees: data, data, total, page, pageSize, totalPages: Math.ceil(total / pageSize) }
  }, { isSignIn: true })
  .post(
    '/',
    async ({ params: { orgId }, body, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })

      const employee = await Employee.create({ ...body, orgId })
      return employee.toJSON()
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
      }),
    },
  )
  .get('/:id', async ({ params: { orgId, id }, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })

    const employee = await Employee.findOne({ _id: id, orgId }).lean().exec()
    if (!employee) return status(404, { message: 'Employee not found' })

    return employee
  }, { isSignIn: true })
  .put(
    '/:id',
    async ({ params: { orgId, id }, body, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })
      if (!['admin', 'hr_manager'].includes(user.role))
        return status(403, { message: 'Admin or HR manager only' })

      const employee = await Employee.findOneAndUpdate(
        { _id: id, orgId },
        body,
        { new: true },
      ).lean().exec()
      if (!employee) return status(404, { message: 'Employee not found' })

      return employee
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
      }),
    },
  )
  .delete('/:id', async ({ params: { orgId, id }, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    if (!['admin', 'hr_manager'].includes(user.role))
      return status(403, { message: 'Admin or HR manager only' })

    const employee = await Employee.findOneAndUpdate(
      { _id: id, orgId },
      { status: 'terminated', terminationDate: new Date() },
      { new: true },
    ).exec()
    if (!employee) return status(404, { message: 'Employee not found' })

    return { message: 'Employee terminated' }
  }, { isSignIn: true })
