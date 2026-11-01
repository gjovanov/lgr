import { Elysia, t } from 'elysia'
import { AppAuthService } from '../auth/app-auth.service.js'
import {
  ReceiptBillError, billableReceiptsOf, createBillFromReceipts, linkReceiptsToBill,
} from 'services/biz/receipt-bill.service'

/**
 * The supplier's bill for goods already received (FR-22.31 / #168, FR-22.32).
 *
 *   POST /org/:orgId/invoicing/bills/from-receipt      { movementIds[], contactId? }  → a DRAFT bill, linked
 *   GET  /org/:orgId/invoicing/bills/billable-receipts ?contactId=                    → that supplier's unbilled
 *        receipts, then the unbilled ones that name no supplier
 *   POST /org/:orgId/invoicing/bills/:id/link-receipts { movementIds[], replaceLines?, contactId? } → a draft bill,
 *        linked; one with lines only when `replaceLines` says so
 *
 * `contactId` names the supplier of a receipt that has none: it is required for one.
 *
 * The rules live in `services/biz/receipt-bill.service.ts`. Receiving, voiding and editing such a
 * bill stay on `/invoices/:id/…`, which honour the link.
 */

type Status = (code: number, body: Record<string, unknown>) => any

const refused = (status: Status, e: ReceiptBillError) => status(e.statusCode, { code: e.code, message: e.message, ...(e.details || {}) })

export const receiptBillController = new Elysia({ prefix: '/org/:orgId/invoicing/bills' })
  .use(AppAuthService)
  .post(
    '/from-receipt',
    async ({ params: { orgId }, body, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })
      try {
        return { invoice: await createBillFromReceipts(orgId, user, body) }
      } catch (e: any) {
        if (e instanceof ReceiptBillError) return refused(status, e)
        throw e
      }
    },
    {
      isSignIn: true,
      body: t.Object({
        movementIds: t.Array(t.String(), { minItems: 1, maxItems: 50 }),
        contactId: t.Optional(t.String()),
        currency: t.Optional(t.String()),
        reference: t.Optional(t.String()),
        issueDate: t.Optional(t.String()),
        dueDate: t.Optional(t.String()),
        notes: t.Optional(t.String()),
        paymentMethod: t.Optional(t.String()),
      }),
    },
  )
  .get('/billable-receipts', async ({ params: { orgId }, query, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    const contactId = String(query.contactId || '')
    if (!contactId) return status(422, { code: 'contact_required', message: 'Choose the supplier first' })
    return { receipts: await billableReceiptsOf(orgId, contactId) }
  }, { isSignIn: true })
  .post(
    '/:id/link-receipts',
    async ({ params: { orgId, id }, body, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })
      try {
        const { movementIds, replaceLines, contactId } = body
        return { invoice: await linkReceiptsToBill(orgId, user, id, movementIds, { replaceLines, contactId }) }
      } catch (e: any) {
        if (e instanceof ReceiptBillError) return refused(status, e)
        throw e
      }
    },
    {
      isSignIn: true,
      body: t.Object({
        movementIds: t.Array(t.String(), { minItems: 1, maxItems: 50 }),
        replaceLines: t.Optional(t.Boolean()),
        contactId: t.Optional(t.String()),
      }),
    },
  )
