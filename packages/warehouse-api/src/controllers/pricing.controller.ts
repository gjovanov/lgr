import { Elysia, t } from 'elysia'
import { AppAuthService } from '../auth/app-auth.service.js'
import { resolvePrice, listPriceOptions } from 'services/biz/pricing.service'

export const pricingController = new Elysia({ prefix: '/org/:orgId/pricing' })
  .use(AppAuthService)
  .get(
    '/resolve',
    async ({ params: { orgId }, query, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })

      if (!query.productId) {
        return status(400, { message: 'productId is required' })
      }

      const result = await resolvePrice(
        orgId,
        query.productId as string,
        (query.contactId as string) || undefined,
        query.quantity ? Number(query.quantity) : undefined,
      )

      return result
    },
    { isSignIn: true },
  )
  .get(
    '/options',
    async ({ params: { orgId }, query, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })

      const productId = query.productId as string
      if (!productId) return status(400, { message: 'productId is required' })

      const result = await listPriceOptions(
        orgId,
        productId,
        (query.contactId as string) || undefined,
        query.quantity ? Number(query.quantity) : undefined,
        undefined,
        { all: query.all === 'true' || query.all === '1' },
      )
      return result
    },
    { isSignIn: true },
  )
