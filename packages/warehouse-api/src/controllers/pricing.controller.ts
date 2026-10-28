import { Elysia, t } from 'elysia'
import { AppAuthService } from '../auth/app-auth.service.js'
import { resolvePrice, listPriceOptions } from 'services/biz/pricing.service'
import { lastPricesForContact } from 'services/biz/last-price.service'

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
  /**
   * #145 — the price each product was last sold at to this customer (`last-price.service.ts`).
   * `{ prices: { [productId]: { price, invoiceNumber, issueDate, … } } }`; a product never sold
   * to them is simply absent.
   */
  .get(
    '/last-prices',
    async ({ params: { orgId }, query, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })
      const contactId = query.contactId as string
      if (!contactId) return status(400, { message: 'contactId is required' })
      const productIds = String(query.productIds || '').split(',').map(s => s.trim()).filter(Boolean)
      const prices = await lastPricesForContact(orgId, contactId, productIds, {
        currency: (query.currency as string) || undefined,
        excludeInvoiceId: (query.excludeId as string) || undefined,
      })
      return { prices }
    },
    { isSignIn: true },
  )
