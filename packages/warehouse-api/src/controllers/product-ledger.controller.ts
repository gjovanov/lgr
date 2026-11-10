import { Elysia } from 'elysia'
import { AppAuthService } from '../auth/app-auth.service.js'
import { getProductLedger } from 'services/biz/product-ledger.service'
import { grantOf } from 'services/biz/access/evaluate'
import { redactMovementLine, seesCosts } from 'config/access'

export const productLedgerController = new Elysia({ prefix: '/org/:orgId/warehouse/product-ledger' })
  .use(AppAuthService)
  .get('/:productId', async ({ params: { orgId, productId }, query, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })

    const eventTypes = query.eventTypes
      ? (query.eventTypes as string).split(',').filter(Boolean)
      : undefined

    const result = await getProductLedger(orgId, productId, {
      warehouseId: query.warehouseId as string | undefined,
      dateFrom: query.dateFrom as string | undefined,
      dateTo: query.dateTo as string | undefined,
      contactId: query.contactId as string | undefined,
      eventTypes,
      sortBy: (query.sortBy as string | undefined) || undefined,
      sortOrder: query.sortOrder === 'desc' ? 'desc' : 'asc',
      page: query.page ? parseInt(query.page as string, 10) : undefined,
      size: query.size ? parseInt(query.size as string, 10) : undefined,
    })

    // FR-27.11.C.1: the ledger's costs (unit cost, the line's and the running value, the current value) only with them.
    const grant = grantOf(user as any)
    if (seesCosts(grant)) return result
    const { currentValue: _value, ...summary } = result.summary as any
    return { ...result, entries: result.entries.map(e => redactMovementLine(grant, e as any)), summary }
  }, { isSignIn: true })
