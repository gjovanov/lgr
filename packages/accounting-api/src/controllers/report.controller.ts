import { Elysia, t } from 'elysia'
import { AppAuthService } from '../auth/app-auth.service.js'
import { getBalanceSheet, getTrialBalance, getProfitLoss } from 'services/biz/accounting.service'
import { reportDayEnd, reportDayStart } from 'services/utils/report-day'

const OBJECT_ID = '^[0-9a-fA-F]{24}$'

export const reportController = new Elysia({ prefix: '/org/:orgId/accounting/report' })
  .use(AppAuthService)
  .get('/trial-balance', async ({ params: { orgId }, query, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })

    const asOf = reportDayEnd(query.asOf)
    if (asOf === null) return status(422, { message: `Invalid date: ${query.asOf}` })

    const rows = await getTrialBalance(orgId, { fiscalYearId: query.fiscalYearId, fiscalPeriodId: query.fiscalPeriodId, asOf })
    return { rows }
  }, {
    isSignIn: true,
    query: t.Object({
      fiscalYearId: t.Optional(t.String({ pattern: OBJECT_ID })),
      fiscalPeriodId: t.Optional(t.String({ pattern: OBJECT_ID })),
      asOf: t.Optional(t.String()),
    }),
  })
  .get('/profit-loss', async ({ params: { orgId }, query, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })

    const startDate = reportDayStart(query.startDate)
    const endDate = reportDayEnd(query.endDate)
    if (startDate === null || endDate === null) return status(422, { message: `Invalid date: ${startDate === null ? query.startDate : query.endDate}` })

    const data = await getProfitLoss(orgId, startDate ?? new Date(new Date().getFullYear(), 0, 1), endDate ?? new Date())
    return data
  }, { isSignIn: true })
  .get('/balance-sheet', async ({ params: { orgId }, query, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })

    const asOf = reportDayEnd(query.asOf)
    if (asOf === null) return status(422, { message: `Invalid date: ${query.asOf}` })

    return getBalanceSheet(orgId, asOf)
  }, { isSignIn: true })
