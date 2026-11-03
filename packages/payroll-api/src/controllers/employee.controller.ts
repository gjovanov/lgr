import { Elysia, t } from 'elysia'
import { AppAuthService } from '../auth/app-auth.service.js'
import { getRepos } from 'services/context'
import { createAuditEntry, diffChanges, recordAuditEntry } from 'services/biz/audit-log.service'
import { buildSearchFilter } from 'services/biz/search.utils'
import { holdsPersonal } from 'services/biz/route-permission'
import { upsertTags } from 'services/biz/tag.service'
import { forOrg } from 'services/biz/personal-data/personal-data.service'
import {
  cleanPersonalPatch,
  employeeView,
  nationalIdLookup,
  revealEmployeeFields,
  sealedEmployeeFields,
} from 'services/biz/personal-data/employee-personal'
import { lockedAnswer, PERSONAL_REFUSAL } from './answers.js'

/** FR-25 §3.11: a write is about one person whatever it changes. The route rule has already asked for `payroll.write`. */
const personalRefusal = (status: any) => status(403, PERSONAL_REFUSAL)

const PersonalBody = t.Object({
  identifierType: t.Optional(t.Union([t.Literal('egn'), t.Literal('lnch'), t.Literal('service')])),
  nationalId: t.Optional(t.Nullable(t.String())),
  taxId: t.Optional(t.Nullable(t.String())),
  dateOfBirth: t.Optional(t.Nullable(t.String())),
  address: t.Optional(t.Nullable(t.Object({
    street: t.Optional(t.String()),
    city: t.Optional(t.String()),
    state: t.Optional(t.String()),
    postalCode: t.Optional(t.String()),
    country: t.Optional(t.String()),
  }))),
  emergencyContact: t.Optional(t.Nullable(t.Object({
    name: t.Optional(t.String()),
    relationship: t.Optional(t.String()),
    phone: t.Optional(t.String()),
  }))),
  idCard: t.Optional(t.Nullable(t.Object({
    number: t.Optional(t.String()),
    date: t.Optional(t.String()),
    issuer: t.Optional(t.String()),
  }))),
  education: t.Optional(t.Nullable(t.String())),
  retiree: t.Optional(t.Nullable(t.Boolean())),
  disabled: t.Optional(t.Nullable(t.Object({
    percent: t.Optional(t.Number()),
    from: t.Optional(t.String()),
    to: t.Optional(t.String()),
  }))),
  childRelief: t.Optional(t.Nullable(t.Object({
    children: t.Optional(t.Number()),
    disabledChildren: t.Optional(t.Number()),
    declaredAt: t.Optional(t.String()),
  }))),
  isMainEmployer: t.Optional(t.Nullable(t.Boolean())),
  insuredAtMaxElsewhere: t.Optional(t.Nullable(t.Boolean())),
  paymentMethod: t.Optional(t.Nullable(t.String())),
  iban: t.Optional(t.Nullable(t.String())),
  bic: t.Optional(t.Nullable(t.String())),
  bankName: t.Optional(t.Nullable(t.String())),
  bankAccountNumber: t.Optional(t.Nullable(t.String())),
})

export const employeeController = new Elysia({ prefix: '/org/:orgId/payroll/employee' })
  .use(AppAuthService)
  .get('/', async ({ params: { orgId }, query, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    const r = getRepos()

    const filter: Record<string, any> = { orgId }
    if (query.search) {
      const searchFilter = buildSearchFilter(query.search as string, ['firstName', 'middleName', 'lastName', 'email'], { hasTextIndex: true })
      Object.assign(filter, searchFilter)
      // An exact ЕГН finds its person through the lookup value, and nothing is opened to do it.
      if (/^\d{9,10}$/.test(String(query.search).trim())) {
        const lookup = await nationalIdLookup(orgId, String(query.search))
        if (lookup) filter.$or = [...(filter.$or ?? []), lookup]
      }
    }
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
    const items = result.items.map(employeeView)
    return { ...result, employees: items, items }
  }, { isSignIn: true })
  .post(
    '/',
    async ({ params: { orgId }, body, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })
      if (!holdsPersonal(user)) return personalRefusal(status)
      const r = getRepos()

      const { personal, ...plain } = body
      const patch = cleanPersonalPatch(personal)
      const hasPersonal = Object.keys(patch).length > 0

      let employee: any
      try {
        // The record is bound to the document's id, so the document comes first. A locked server is
        // found out before that: the key is opened here, and no half-made employee is left behind.
        if (hasPersonal) await forOrg(orgId)
        employee = await r.employees.create({ ...plain, orgId } as any)
        if (hasPersonal) employee = await r.employees.updateInOrg(employee.id, orgId, await sealedEmployeeFields(orgId, employee.id, null, patch) as any)
      } catch (e) {
        return lockedAnswer(status, e)
      }
      await upsertTags(orgId, 'employee', body.tags)

      createAuditEntry({ orgId, userId: user.id, action: 'create', module: 'payroll', entityType: 'employee', entityId: employee.id, entityName: (employee as any).employeeNumber })

      return { employee: employeeView(employee) }
    },
    {
      isSignIn: true,
      body: t.Object({
        employeeNumber: t.String({ minLength: 1 }),
        firstName: t.String({ minLength: 1 }),
        middleName: t.Optional(t.String()),
        lastName: t.String({ minLength: 1 }),
        email: t.Optional(t.String({ format: 'email' })),
        phone: t.Optional(t.String()),
        gender: t.Optional(t.Union([
          t.Literal('male'),
          t.Literal('female'),
          t.Literal('other'),
        ])),
        personal: t.Optional(PersonalBody),
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

    return { employee: employeeView(employee) }
  }, { isSignIn: true })
  // FR-25 §3.12: the one way a person reads a sealed value. The route rule needs `payroll.personal`.
  // ⚠ The audit row is written before the value leaves, and no row means no value.
  .post(
    '/:id/reveal',
    async ({ params: { orgId, id }, body, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })
      const r = getRepos()

      const existing: any = await r.employees.findOne({ id, orgId } as any)
      if (!existing) return status(404, { message: 'Employee not found' })

      let personal
      try {
        personal = await revealEmployeeFields(orgId, existing, body.fields)
      } catch (e) {
        return lockedAnswer(status, e)
      }

      const logged = await recordAuditEntry({
        orgId, userId: user.id, action: 'reveal', module: 'payroll', entityType: 'employee', entityId: id, entityName: existing.employeeNumber,
        changes: Object.keys(personal).map(field => ({ field: `personal.${field}`, oldValue: body.reason, newValue: '[REDACTED]' })),
      })
      if (!logged) return status(503, { message: 'The read could not be recorded, so it was refused', code: 'audit_unavailable' })

      return { personal }
    },
    {
      isSignIn: true,
      body: t.Object({
        fields: t.Array(t.String(), { minItems: 1 }),
        reason: t.Union([t.Literal('edit'), t.Literal('declaration'), t.Literal('employee_request'), t.Literal('audit')]),
      }),
    },
  )
  .put(
    '/:id',
    async ({ params: { orgId, id }, body, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })
      if (!holdsPersonal(user)) return personalRefusal(status)
      const r = getRepos()

      const existing: any = await r.employees.findOne({ id, orgId } as any)
      if (!existing) return status(404, { message: 'Employee not found' })

      const { personal, ...plain } = body
      const patch = cleanPersonalPatch(personal)
      const personalFields = Object.keys(patch)

      let sealed = {}
      try {
        if (personalFields.length) sealed = await sealedEmployeeFields(orgId, id, existing.personal, patch)
      } catch (e) {
        return lockedAnswer(status, e)
      }
      const employee = await r.employees.updateInOrg(id, orgId, { ...plain, ...sealed } as any)
      await upsertTags(orgId, 'employee', body.tags)

      // FR-25 §3.11: what changed, never to what. Pay is as private as the ЕГН here.
      const { salary: _salary, ...comparable } = plain as any
      const changes = [
        ...diffChanges(existing, comparable),
        ...(plain.salary ? [{ field: 'salary', oldValue: '[REDACTED]', newValue: '[REDACTED]' }] : []),
        ...personalFields.map(field => ({ field: `personal.${field}`, oldValue: '[REDACTED]', newValue: '[REDACTED]' })),
      ]
      createAuditEntry({ orgId, userId: user.id, action: 'update', module: 'payroll', entityType: 'employee', entityId: id, entityName: existing.employeeNumber, changes })

      return { employee: employeeView(employee) }
    },
    {
      isSignIn: true,
      body: t.Object({
        firstName: t.Optional(t.String()),
        middleName: t.Optional(t.String()),
        lastName: t.Optional(t.String()),
        email: t.Optional(t.String({ format: 'email' })),
        phone: t.Optional(t.String()),
        department: t.Optional(t.String()),
        position: t.Optional(t.String()),
        managerId: t.Optional(t.String()),
        personal: t.Optional(PersonalBody),
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
        })),
        notes: t.Optional(t.String()),
        tags: t.Optional(t.Array(t.String())),
      }),
    },
  )
  .delete('/:id', async ({ params: { orgId, id }, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    if (!holdsPersonal(user)) return personalRefusal(status)
    const r = getRepos()

    const existing = await r.employees.findOne({ id, orgId } as any)
    if (!existing) return status(404, { message: 'Employee not found' })

    await r.employees.updateInOrg(id, orgId, { status: 'terminated', terminationDate: new Date(), deactivatedAt: new Date() } as any)

    createAuditEntry({ orgId, userId: user.id, action: 'delete', module: 'payroll', entityType: 'employee', entityId: id, entityName: (existing as any).employeeNumber })

    return { message: 'Employee terminated' }
  }, { isSignIn: true })
