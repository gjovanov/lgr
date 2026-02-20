import { Elysia } from 'elysia'
import { AuthService } from '../../auth/auth.service.js'
import { getTrialBalance, getProfitLoss } from 'services/biz/accounting.service'
import { Account } from 'db/models'

export const reportController = new Elysia({ prefix: '/org/:orgId/accounting/report' })
  .use(AuthService)
  .get('/trial-balance', async ({ params: { orgId }, query, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })

    const rows = await getTrialBalance(orgId, query.fiscalYearId as string | undefined)
    return { rows }
  }, { isSignIn: true })
  .get('/profit-loss', async ({ params: { orgId }, query, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })

    const startDate = query.startDate ? new Date(query.startDate as string) : new Date(new Date().getFullYear(), 0, 1)
    const endDate = query.endDate ? new Date(query.endDate as string) : new Date()

    const data = await getProfitLoss(orgId, startDate, endDate)
    return data
  }, { isSignIn: true })
  .get('/balance-sheet', async ({ params: { orgId }, query, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })

    const accounts = await Account.find({ orgId, isActive: true }).sort({ code: 1 }).lean().exec()

    const assets = accounts.filter(a => a.type === 'asset')
    const liabilities = accounts.filter(a => a.type === 'liability')
    const equity = accounts.filter(a => a.type === 'equity')

    const totalAssets = assets.reduce((sum, a) => sum + (a.balance || 0), 0)
    const totalLiabilities = liabilities.reduce((sum, a) => sum + (a.balance || 0), 0)
    const totalEquity = equity.reduce((sum, a) => sum + (a.balance || 0), 0)

    return {
      assets: assets.map(a => ({ account: `${a.code} - ${a.name}`, balance: a.balance || 0 })),
      liabilities: liabilities.map(a => ({ account: `${a.code} - ${a.name}`, balance: a.balance || 0 })),
      equity: equity.map(a => ({ account: `${a.code} - ${a.name}`, balance: a.balance || 0 })),
      totalAssets,
      totalLiabilities,
      totalEquity,
      totalLiabilitiesAndEquity: totalLiabilities + totalEquity,
    }
  }, { isSignIn: true })
