import { Elysia, t } from 'elysia'
import { kindOfDocument, readsKind, writesKind } from 'config/access'
import { Invoice } from 'db/models'
import { grantOf } from 'services/biz/access/evaluate'
import { withVisibleTrails } from 'services/biz/access/price-trails'
import {
  DispatchInvoiceError, createInvoiceFromDispatches, dispatchesOverlapping, invoiceableDispatchesOf, linkDispatchesToInvoice,
} from 'services/biz/dispatch-invoice.service'
import { AppAuthService } from '../auth/app-auth.service.js'

/**
 * The customer's invoice for goods a stock note already delivered (FR-22.61 / #725, FR-22.62): the sales twin of
 * `receipt-bill.controller.ts`.
 *
 *   POST /org/:orgId/invoicing/sales/from-dispatch          { movementIds[], contactId? }  → a DRAFT invoice, linked
 *   GET  /org/:orgId/invoicing/sales/invoiceable-dispatches ?contactId=                    → that customer's
 *        uninvoiced stock notes, then the uninvoiced ones that name no customer
 *   POST /org/:orgId/invoicing/sales/:id/link-dispatches    { movementIds[], replaceLines?, contactId? } → a draft
 *        invoice, linked; one whose lines differ from the notes only when `replaceLines` says so
 *   GET  /org/:orgId/invoicing/sales/:id/dispatch-overlap   → the question `/invoices/:id/send` would ask (FR-22.61b),
 *        so a form can ask it before it checks the stock a linked invoice will never take
 *
 * `contactId` names the customer of a note that has none: it is required for one.
 *
 * The rules live in `services/biz/dispatch-invoice.service.ts`. Issuing, voiding and editing such an invoice stay on
 * `/invoices/:id/…`, which honour the link. A sales document is the sales partition's (FR-27.6): these routes ask
 * its capabilities, as `/invoices` does for a document of that kind.
 */

type Status = (code: number, body: Record<string, unknown>) => any

const refused = (status: Status, e: DispatchInvoiceError) => status(e.statusCode, { code: e.code, message: e.message, ...(e.details || {}) })
const notYours = (status: Status, action: 'create' | 'edit') =>
  status(403, { code: 'capability_required', capabilities: [`sales-docs.${action}`], message: 'This kind of document is read-only for your role.' })

/**
 * The document a by-id route is asked about, as this session may know it: an id that is none, another org's document
 * and one of a kind the session does not read all read as absent (FR-27.6, as on `/invoices`).
 */
async function readable(orgId: string, id: string, user: unknown, fields?: Record<string, 1>): Promise<any | null> {
  if (!/^[0-9a-f]{24}$/i.test(id)) return null
  const doc: any = await Invoice.findOne({ _id: id, orgId }, fields).lean().exec()
  return doc && readsKind(grantOf(user as any), kindOfDocument(doc)) ? doc : null
}

export const dispatchInvoiceController = new Elysia({ prefix: '/org/:orgId/invoicing/sales' })
  .use(AppAuthService)
  // FR-27.11.C.6, as on `/invoices`: no answer names a price level the role does not see in a line's stored trail.
  .onAfterHandle(({ response, user }: any) => withVisibleTrails(grantOf(user), response))
  .post(
    '/from-dispatch',
    async ({ params: { orgId }, body, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })
      if (!writesKind(grantOf(user as any), 'sales', 'create')) return notYours(status, 'create')
      try {
        return { invoice: await createInvoiceFromDispatches(orgId, user as any, body) }
      } catch (e: any) {
        if (e instanceof DispatchInvoiceError) return refused(status, e)
        throw e
      }
    },
    {
      isSignIn: true,
      body: t.Object({
        movementIds: t.Array(t.String(), { minItems: 1, maxItems: 50 }),
        contactId: t.Optional(t.String()),
        currency: t.Optional(t.String()),
        issueDate: t.Optional(t.String()),
        dueDate: t.Optional(t.String()),
        notes: t.Optional(t.String()),
        paymentMethod: t.Optional(t.String()),
        locale: t.Optional(t.String()),
      }),
    },
  )
  .get('/invoiceable-dispatches', async ({ params: { orgId }, query, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    if (!readsKind(grantOf(user as any), 'sales')) return status(403, { code: 'capability_required', capabilities: ['sales-docs.view'], message: 'Sales documents are not part of your role.' })
    const contactId = String(query.contactId || '')
    if (!contactId) return status(422, { code: 'contact_required', message: 'Choose the customer first' })
    return { dispatches: await invoiceableDispatchesOf(orgId, contactId) }
  }, { isSignIn: true })
  .get('/:id/dispatch-overlap', async ({ params: { orgId, id }, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    const invoice = await readable(orgId, id, user)
    if (!invoice) return status(404, { message: 'Invoice not found' })
    return { overlap: await dispatchesOverlapping(orgId, invoice) }
  }, { isSignIn: true })
  .post(
    '/:id/link-dispatches',
    async ({ params: { orgId, id }, body, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })
      const doc = await readable(orgId, id, user, { direction: 1, type: 1 })
      if (!doc) return status(404, { message: 'Invoice not found' })
      if (!writesKind(grantOf(user as any), kindOfDocument(doc), 'edit')) return notYours(status, 'edit')
      try {
        const { movementIds, replaceLines, contactId } = body
        return await linkDispatchesToInvoice(orgId, user as any, id, movementIds, { replaceLines, contactId })
      } catch (e: any) {
        if (e instanceof DispatchInvoiceError) return refused(status, e)
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
