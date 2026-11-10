import { Elysia } from 'elysia'
import { seesBills } from 'services/biz/access/partition'
import { AppAuthService } from '../auth/app-auth.service.js'
import { getContactLedger } from 'services/biz/contact-ledger.service'
import { grantOf } from 'services/biz/access/evaluate'
import { seesCosts } from 'config/access'

export const contactLedgerController = new Elysia({ prefix: '/org/:orgId/invoicing/contact-ledger' })
  .use(AppAuthService)
  .get('/:contactId', async ({ params: { orgId, contactId }, query, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })

    const options: Record<string, any> = {}
    if (query.dateFrom) options.dateFrom = query.dateFrom
    if (query.dateTo) options.dateTo = query.dateTo
    if (query.documentTypes) {
      options.documentTypes = (query.documentTypes as string).split(',').filter(Boolean)
    }
    if (!seesBills(user as any)) options.outgoingOnly = true
    // #526: they narrow the ledger; the area check above still decides which documents it holds.
    if (typeof query.productSearch === 'string') options.productSearch = query.productSearch
    if (typeof query.documentNumber === 'string') options.documentNumber = query.documentNumber
    options.page = Math.max(0, Number(query.page) || 0)
    options.size = query.size !== undefined ? Number(query.size) : 25

    const result = await getContactLedger(orgId, contactId, options)
    // FR-27.11.C.2: each row's purchase price, and the profitability (the sales less the total cost, which gives the
    // cost back), are cost figures: absent for a role without them.
    if (seesCosts(grantOf(user as any))) return result
    const { profitabilityNet: _net, profitabilityGross: _gross, ...summary } = result.summary as any
    return { ...result, entries: result.entries.map(({ purchasePrice: _cost, ...e }: any) => e), summary }
  }, { isSignIn: true })
