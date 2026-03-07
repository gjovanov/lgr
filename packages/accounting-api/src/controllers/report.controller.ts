import { Elysia } from 'elysia'
import { AppAuthService } from '../auth/app-auth.service.js'
import { getTrialBalance, getProfitLoss } from 'services/biz/accounting.service'
import { getRepos } from 'services/context'

export const reportController = new Elysia({ prefix: '/org/:orgId/accounting/report' })
  .use(AppAuthService)
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
    const r = getRepos()

    const allAccounts = await r.accounts.findMany({ orgId, isActive: true } as any, { code: 1 })

    const assets = allAccounts.filter((a: any) => a.type === 'asset')
    const liabilities = allAccounts.filter((a: any) => a.type === 'liability')
    const equity = allAccounts.filter((a: any) => a.type === 'equity')

    const totalAssets = assets.reduce((sum, a: any) => sum + (a.balance || 0), 0)
    const totalLiabilities = liabilities.reduce((sum, a: any) => sum + (a.balance || 0), 0)
    const totalEquity = equity.reduce((sum, a: any) => sum + (a.balance || 0), 0)

    return {
      assets: assets.map((a: any) => ({ account: `${a.code} - ${a.name}`, balance: a.balance || 0 })),
      liabilities: liabilities.map((a: any) => ({ account: `${a.code} - ${a.name}`, balance: a.balance || 0 })),
      equity: equity.map((a: any) => ({ account: `${a.code} - ${a.name}`, balance: a.balance || 0 })),
      totalAssets,
      totalLiabilities,
      totalEquity,
      totalLiabilitiesAndEquity: totalLiabilities + totalEquity,
    }
  }, { isSignIn: true })
