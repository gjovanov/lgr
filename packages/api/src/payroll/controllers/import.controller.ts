import { Elysia, t } from 'elysia'
import { AnObject } from 'services/http/body-schemas'
import { AppAuthService } from '../auth/app-auth.service.js'
import { getRepos } from 'services/context'
import { createAuditEntry } from 'services/biz/audit-log.service'
import { can } from 'services/biz/access/evaluate'
import { importContracts, importEmployees, importMonth } from 'services/biz/payroll/bg/import.service'
import { isEmplRow } from 'services/biz/payroll/bg/files/empl2021'
import { lockedAnswer, PERSONAL_REFUSAL } from './answers.js'

/**
 * FR-25 §5.1: payroll as filed, from `scripts/import-payroll.ts`, which opens the sealed files in
 * memory and posts them here. `payroll.import` by the route rule, and `payroll.personal` on top: a
 * caller who may not read a person may not write one either.
 *
 * `dryRun` defaults to true: leaving it out answers what would change, and changes nothing. ⚠ What
 * is answered and audited is counts and month names, never a person.
 */
const dry = (body: { dryRun?: boolean }) => body.dryRun !== false

const NOT_A_PAYROLL_ORG = { message: 'This org has no settings.payroll.engine: bg', code: 'payroll_engine_not_set' }
const NOT_THE_HOME = { message: "A split's payroll lives in its home org, not in a store", code: 'payroll_in_home' }

/**
 * ⚠ A mistyped `--org` must not put a company's payroll in a store org: the org has to have asked for it.
 * And in a split (FR-25 R7) the payroll is the home's (owner, 2026-11-20): one employer files one обр. 1
 * and one обр. 6 a month, so a store holding part of it would declare part of the company.
 */
async function importRefusal(orgId: string) {
  const org: any = await getRepos().orgs.findById(orgId)
  if (org?.settings?.payroll?.engine !== 'bg') return NOT_A_PAYROLL_ORG
  const books = org.settings?.accounting?.books
  if (books?.mode === 'books' && books.split?.homeOrgId && String(books.split.homeOrgId) !== String(orgId)) return NOT_THE_HOME
  return null
}

export const payrollImportController = new Elysia({ prefix: '/org/:orgId/payroll/import' })
  .use(AppAuthService)
  .post(
    '/employees',
    async ({ params: { orgId }, body, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })
      if (!can(user, 'payroll-people.view')) return status(403, PERSONAL_REFUSAL)
      const refused = await importRefusal(orgId)
      if (refused) return status(409, refused)
      try {
        const report = await importEmployees(orgId, body.people, { dryRun: dry(body) })
        if (!dry(body)) createAuditEntry({ orgId, userId: user.id, action: 'import', module: 'payroll', entityType: 'employee', entityId: orgId, entityName: `${report.create} new, ${report.update} changed` })
        return report
      } catch (e) {
        return lockedAnswer(status, e)
      }
    },
    {
      isSignIn: true,
      body: t.Object({
        dryRun: t.Optional(t.Boolean()),
        people: t.Array(t.Object({
          personId: t.String({ minLength: 9, maxLength: 13 }),
          personIdKind: t.Number(),
          firstName: t.Optional(t.String()),
          middleName: t.Optional(t.String()),
          lastName: t.String({ minLength: 1 }),
          active: t.Boolean(),
          knownFrom: t.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}$' }),
        })),
      }),
    },
  )
  .post(
    '/contracts',
    async ({ params: { orgId }, body, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })
      if (!can(user, 'payroll-people.view')) return status(403, PERSONAL_REFUSAL)
      const refused = await importRefusal(orgId)
      if (refused) return status(409, refused)
      try {
        const report = await importContracts(orgId, body as any, { dryRun: dry(body) })
        if (!dry(body)) createAuditEntry({ orgId, userId: user.id, action: 'import', module: 'payroll', entityType: 'employment_contract', entityId: orgId, entityName: `${report.create} new, ${report.update} changed` })
        return report
      } catch (e) {
        return lockedAnswer(status, e)
      }
    },
    {
      isSignIn: true,
      body: t.Object({
        dryRun: t.Optional(t.Boolean()),
        events: t.Array(t.Object({
          source: t.Union([t.Literal('etz'), t.Literal('utd62')]),
          action: t.Union([t.Literal('concluded'), t.Literal('amended'), t.Literal('terminated')]),
          correction: t.Number(),
          personId: t.String({ minLength: 9, maxLength: 13 }),
          contractDate: t.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}$' }),
        }, { additionalProperties: true })),
        snapshots: t.Array(t.Object({
          personId: t.String({ minLength: 9, maxLength: 13 }),
          asOf: t.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}$' }),
        }, { additionalProperties: true })),
        people: t.Array(t.String({ minLength: 9, maxLength: 13 })),
      }),
    },
  )
  .post(
    '/months',
    async ({ params: { orgId }, body, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })
      if (!can(user, 'payroll-people.view')) return status(403, PERSONAL_REFUSAL)
      const refused = await importRefusal(orgId)
      if (refused) return status(409, refused)
      if (!body.rows.every(isEmplRow)) return status(422, { message: 'A row is not an обр. 1 record', code: 'bad_row' })
      try {
        const { dryRun: _dryRun, ...month } = body
        const report = await importMonth(orgId, user.id, month as any, { dryRun: dry(body) })
        if (!dry(body) && report.action !== 'unchanged' && report.action !== 'refused') {
          createAuditEntry({ orgId, userId: user.id, action: 'import', module: 'payroll', entityType: 'payroll_month', entityId: orgId, entityName: `${body.period} ${report.action}` })
        }
        return report
      } catch (e) {
        return lockedAnswer(status, e)
      }
    },
    {
      isSignIn: true,
      body: t.Object({
        dryRun: t.Optional(t.Boolean()),
        period: t.String({ pattern: '^\\d{6}$' }),
        version: t.String({ minLength: 1 }),
        rows: t.Array(AnObject, { minItems: 1 }),
        sheet: t.Optional(t.Array(t.Object({
          personId: t.String({ minLength: 9, maxLength: 13 }),
          paidLeaveDays: t.Optional(t.Number()),
          lines: t.Array(t.Object({ code: t.String(), amount: t.Number(), days: t.Optional(t.Number()) })),
        }))),
        filed: t.Optional(t.Object({ ending: t.Union([t.Literal('crlf-eof'), t.Literal('eof')]), record: t.Any() })),
      }),
    },
  )
