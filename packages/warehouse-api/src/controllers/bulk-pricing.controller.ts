import { Elysia, t } from 'elysia'
import { AppAuthService } from '../auth/app-auth.service.js'
import { bulkAdjustPrices } from 'services/biz/bulk-pricing.service'
import { createAuditEntry } from 'services/biz/audit-log.service'

export const bulkPricingController = new Elysia({ prefix: '/org/:orgId/warehouse/bulk-pricing' })
  .use(AppAuthService)
  .post(
    '/adjust',
    async ({ params: { orgId }, body, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })

      const result = await bulkAdjustPrices(orgId, body)

      createAuditEntry({ orgId, userId: user.id, action: 'bulk_price_adjust', module: 'warehouse', entityType: 'product', entityId: orgId, changes: [{ field: 'bulkAdjust', oldValue: null, newValue: body }] })

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
