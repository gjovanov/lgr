import { Elysia, t } from 'elysia'
import { mongoose } from 'db/connection'
import { AbsenceEntry, Employee, EmploymentContract, LeaveBalance } from 'db/models'
import { AppAuthService } from '../auth/app-auth.service.js'
import { createAuditEntry, recordAuditEntry } from 'services/biz/audit-log.service'
import { can } from 'services/biz/access/evaluate'
import { ABSENCE_CODES, openAbsenceDetail, sealAbsenceDetail } from 'services/biz/payroll/bg/absence'
import { openContractPay, sealContractPay } from 'services/biz/payroll/bg/contract-pay'
import { absenceView, contractView, leaveBalanceView } from 'services/biz/payroll/bg/views'
import { lockedAnswer, PERSONAL_REFUSAL, RECORD_REFUSAL, REVEAL_REASON } from './answers.js'

/**
 * FR-25 §3.10: contracts, absences and leave. All of it is about one person, so the route rules need
 * `payroll.personal` to read; a write needs `payroll.write` by rule and `payroll.personal` here.
 * Lists and gets send the allow-list views, and a sealed value comes out only through a reveal, which
 * is written to the audit log before it answers.
 */
const inThisOrg = (orgId: string, employeeId: string) => Employee.exists({ _id: employeeId, orgId }).exec()

const NOT_HERE = { message: 'Employee not found' }

const SalaryBody = t.Object({
  effectiveFrom: t.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}$' }),
  amount: t.Number({ minimum: 0 }),
  currency: t.String({ minLength: 3, maxLength: 3 }),
})

const ContractFields = {
  number: t.Optional(t.String()),
  type: t.Optional(t.String()),
  ekatte: t.Optional(t.String()),
  startDate: t.Optional(t.String()),
  endDate: t.Optional(t.Nullable(t.String())),
  position: t.Optional(t.String()),
  nkpd: t.Optional(t.String()),
  kid: t.Optional(t.String()),
  activityKid: t.Optional(t.String()),
  laborCategory: t.Optional(t.String()),
  qualificationGroup: t.Optional(t.Number({ minimum: 1, maximum: 9 })),
  mainActivityRow: t.Optional(t.Number({ minimum: 1 })),
  socialSecurityType: t.Optional(t.String()),
  healthSecurityType: t.Optional(t.String()),
  hoursPerDay: t.Optional(t.Number({ minimum: 1, maximum: 8 })),
  daysPerWeek: t.Optional(t.Number({ minimum: 1, maximum: 7 })),
  statutoryHours: t.Optional(t.Number({ minimum: 1, maximum: 8 })),
  payKind: t.Optional(t.Union([t.Literal('monthly'), t.Literal('hourly')])),
  currency: t.Optional(t.String()),
  annualLeaveDays: t.Optional(t.Number()),
  classPercent: t.Optional(t.Number()),
  salaries: t.Optional(t.Array(SalaryBody)),
}

export const contractController = new Elysia({ prefix: '/org/:orgId/payroll/contract' })
  .use(AppAuthService)
  .get('/', async ({ params: { orgId }, query, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    const filter: Record<string, unknown> = { orgId }
    if (query.employeeId) filter.employeeId = query.employeeId
    const contracts = await EmploymentContract.find(filter).sort({ date: -1 }).lean().exec()
    return { contracts: contracts.map(contractView), total: contracts.length }
  }, { isSignIn: true })
  .get('/:id', async ({ params: { orgId, id }, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    const contract = await EmploymentContract.findOne({ _id: id, orgId }).lean().exec()
    if (!contract) return status(404, { message: 'Contract not found' })
    return { contract: contractView(contract) }
  }, { isSignIn: true })
  .post(
    '/',
    async ({ params: { orgId }, body, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })
      if (!can(user, 'payroll-people.view')) return status(403, PERSONAL_REFUSAL)
      if (!(await inThisOrg(orgId, body.employeeId))) return status(404, NOT_HERE)
      const { salaries, ...plain } = body
      const id = new mongoose.Types.ObjectId()
      try {
        const pay = salaries?.length ? await sealContractPay(orgId, String(id), { salaries }) : undefined
        const contract = await EmploymentContract.create({ _id: id, orgId, ...plain, ...(pay ? { pay } : {}), source: 'manual' })
        createAuditEntry({ orgId, userId: user.id, action: 'create', module: 'payroll', entityType: 'employment_contract', entityId: String(id) })
        return { contract: contractView(contract) }
      } catch (e) {
        return lockedAnswer(status, e)
      }
    },
    {
      isSignIn: true,
      body: t.Object({ employeeId: t.String({ minLength: 24, maxLength: 24 }), date: t.String(), ...ContractFields }),
    },
  )
  .put(
    '/:id',
    async ({ params: { orgId, id }, body, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })
      if (!can(user, 'payroll-people.view')) return status(403, PERSONAL_REFUSAL)
      const existing = await EmploymentContract.findOne({ _id: id, orgId }).lean().exec()
      if (!existing) return status(404, { message: 'Contract not found' })
      const { salaries, ...plain } = body
      try {
        const opened = await openContractPay(orgId, existing)
        const pay = salaries ? await sealContractPay(orgId, id, { ...(opened ?? {}), salaries }) : undefined
        const contract = await EmploymentContract.findOneAndUpdate({ _id: id, orgId }, { $set: { ...plain, ...(pay ? { pay } : {}) } }, { new: true }).lean().exec()
        // What changed, never to what (§3.11).
        const changes = Object.keys(body).map(field => ({ field, oldValue: '[REDACTED]', newValue: '[REDACTED]' }))
        createAuditEntry({ orgId, userId: user.id, action: 'update', module: 'payroll', entityType: 'employment_contract', entityId: id, changes })
        return { contract: contractView(contract) }
      } catch (e) {
        return lockedAnswer(status, e)
      }
    },
    { isSignIn: true, body: t.Object(ContractFields) },
  )
  .post(
    '/:id/reveal',
    async ({ params: { orgId, id }, body, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })
      const contract = await EmploymentContract.findOne({ _id: id, orgId }).lean().exec()
      if (!contract) return status(404, { message: 'Contract not found' })
      let pay
      try {
        pay = await openContractPay(orgId, contract)
      } catch (e) {
        return lockedAnswer(status, e)
      }
      const logged = await recordAuditEntry({
        orgId, userId: user.id, action: 'reveal', module: 'payroll', entityType: 'employment_contract', entityId: id,
        changes: [{ field: 'pay', oldValue: body.reason, newValue: '[REDACTED]' }],
      })
      if (!logged) return status(503, RECORD_REFUSAL)
      return { pay }
    },
    { isSignIn: true, body: t.Object({ reason: REVEAL_REASON }) },
  )

export const absenceController = new Elysia({ prefix: '/org/:orgId/payroll/absence' })
  .use(AppAuthService)
  .get('/', async ({ params: { orgId }, query, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    const filter: Record<string, unknown> = { orgId }
    if (query.employeeId) filter.employeeId = query.employeeId
    const absences = await AbsenceEntry.find(filter).sort({ from: -1 }).lean().exec()
    return { absences: absences.map(absenceView), total: absences.length }
  }, { isSignIn: true })
  .post(
    '/',
    async ({ params: { orgId }, body, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })
      if (!can(user, 'payroll-people.view')) return status(403, PERSONAL_REFUSAL)
      if (!(await inThisOrg(orgId, body.employeeId))) return status(404, NOT_HERE)
      const { code, document, ...plain } = body
      const id = new mongoose.Types.ObjectId()
      try {
        const detail = await sealAbsenceDetail(orgId, String(id), { code, document })
        const absence = await AbsenceEntry.create({ _id: id, orgId, ...plain, detail })
        createAuditEntry({ orgId, userId: user.id, action: 'create', module: 'payroll', entityType: 'absence', entityId: String(id) })
        return { absence: absenceView(absence) }
      } catch (e) {
        return lockedAnswer(status, e)
      }
    },
    {
      isSignIn: true,
      body: t.Object({
        employeeId: t.String({ minLength: 24, maxLength: 24 }),
        contractId: t.Optional(t.String({ minLength: 24, maxLength: 24 })),
        from: t.String(),
        to: t.String(),
        workingDays: t.Number({ minimum: 0 }),
        code: t.Union(ABSENCE_CODES.map(c => t.Literal(c))),
        document: t.Optional(t.String()),
      }),
    },
  )
  .delete('/:id', async ({ params: { orgId, id }, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    if (!can(user, 'payroll-people.view')) return status(403, PERSONAL_REFUSAL)
    const removed = await AbsenceEntry.findOneAndDelete({ _id: id, orgId }).lean().exec()
    if (!removed) return status(404, { message: 'Absence not found' })
    createAuditEntry({ orgId, userId: user.id, action: 'delete', module: 'payroll', entityType: 'absence', entityId: id })
    return { success: true }
  }, { isSignIn: true })
  .post(
    '/:id/reveal',
    async ({ params: { orgId, id }, body, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })
      const absence = await AbsenceEntry.findOne({ _id: id, orgId }).lean().exec()
      if (!absence) return status(404, { message: 'Absence not found' })
      let detail
      try {
        detail = await openAbsenceDetail(orgId, absence)
      } catch (e) {
        return lockedAnswer(status, e)
      }
      const logged = await recordAuditEntry({
        orgId, userId: user.id, action: 'reveal', module: 'payroll', entityType: 'absence', entityId: id,
        changes: [{ field: 'detail', oldValue: body.reason, newValue: '[REDACTED]' }],
      })
      if (!logged) return status(503, RECORD_REFUSAL)
      return { detail }
    },
    { isSignIn: true, body: t.Object({ reason: REVEAL_REASON }) },
  )

export const leaveBalanceController = new Elysia({ prefix: '/org/:orgId/payroll/leave-balance' })
  .use(AppAuthService)
  .get('/', async ({ params: { orgId }, query, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    const filter: Record<string, unknown> = { orgId }
    if (query.employeeId) filter.employeeId = query.employeeId
    if (query.year) filter.year = Number(query.year)
    const balances = await LeaveBalance.find(filter).sort({ year: -1 }).lean().exec()
    return { leaveBalances: balances.map(leaveBalanceView), total: balances.length }
  }, { isSignIn: true })
  .put(
    '/',
    async ({ params: { orgId }, body, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })
      if (!can(user, 'payroll-people.view')) return status(403, PERSONAL_REFUSAL)
      const { employeeId, year, ...values } = body
      if (!(await inThisOrg(orgId, employeeId))) return status(404, NOT_HERE)
      const balance = await LeaveBalance.findOneAndUpdate({ orgId, employeeId, year }, { $set: values }, { new: true, upsert: true }).lean().exec()
      createAuditEntry({ orgId, userId: user.id, action: 'update', module: 'payroll', entityType: 'leave_balance', entityId: String((balance as any)._id) })
      return { leaveBalance: leaveBalanceView(balance) }
    },
    {
      isSignIn: true,
      body: t.Object({
        employeeId: t.String({ minLength: 24, maxLength: 24 }),
        year: t.Number(),
        entitled: t.Optional(t.Number({ minimum: 0 })),
        carried: t.Optional(t.Number({ minimum: 0 })),
        taken: t.Optional(t.Number({ minimum: 0 })),
      }),
    },
  )
