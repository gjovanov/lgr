import { Elysia, t } from 'elysia'
import { AppAuthService } from '../auth/app-auth.service.js'
import { bulkAdjustPrices } from 'services/biz/bulk-pricing.service'

export const bulkPricingController = new Elysia({ prefix: '/org/:orgId/warehouse/bulk-pricing' })
  .use(AppAuthService)
  .post(
    '/adjust',
    async ({ params: { orgId }, body, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })

      const result = await bulkAdjustPrices(orgId, body)
      return result
    },
    {
      isSignIn: true,
      body: t.Object({
        productTagFilters: t.Optional(t.Array(t.String())),
        customPriceTagFilters: t.Optional(t.Array(t.String())),
        sellingPricePercent: t.Optional(t.Number()),
        adjustCustomPrices: t.Optional(t.Boolean()),
        customPricePercent: t.Optional(t.Number()),
      }),
    },
  )
