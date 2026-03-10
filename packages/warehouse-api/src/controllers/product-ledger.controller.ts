import { Elysia } from 'elysia'
import { AppAuthService } from '../auth/app-auth.service.js'
import { getProductLedger } from 'services/biz/product-ledger.service'

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
      page: query.page ? parseInt(query.page as string, 10) : undefined,
      size: query.size ? parseInt(query.size as string, 10) : undefined,
    })

    return result
  }, { isSignIn: true })
