import { Elysia } from 'elysia'
import { AppAuthService } from '../auth/app-auth.service.js'
import { getProductLedger } from 'services/biz/product-ledger.service'

export const productLedgerController = new Elysia({ prefix: '/org/:orgId/warehouse/product-ledger' })
  .use(AppAuthService)
  .get('/:productId', async ({ params: { orgId, productId }, query, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })

    const result = await getProductLedger(orgId, productId, {
      warehouseId: query.warehouseId as string | undefined,
      dateFrom: query.dateFrom as string | undefined,
      dateTo: query.dateTo as string | undefined,
    })

    return result
  }, { isSignIn: true })
