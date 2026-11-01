import { FiscalRoute, deviceFromJournalDocument } from 'fiscal/fiscal-route'
import { Elysia, t } from 'elysia'
import { AppAuthService } from '../auth/app-auth.service.js'
import { orgDao } from 'services/dao/org.dao'
import { getJournalDocument, listJournal } from 'services/biz/cash-register/journal.service'
import { cashRegisterRefusal } from 'services/biz/cash-register/freeze-check'
import { readIdempotencyKey, requestHash } from 'services/biz/hot-path-key'
import { Invoice, POSSession } from 'db/models'
import { SETTLEABLE_TYPES, settleInDoubt } from 'services/biz/cash-register/settle.service'
import { RegisterRefusal } from 'services/biz/cash-register/register.service'
import { STORNO_ROLES, deviceless, documentContext, stornoDoor } from '../lib/cash-register-till.js'

/**
 * FR-21.12 — the cash-register journal („Касови продажби").
 *
 * One list and one detail for every cash-register sale and storno: the till's, the back office's
 * and the PlusMinus imports'. The invoicing app shows it at `/invoicing/cash-sales`, to whoever holds
 * `pos.*` or `invoicing.*` (`route-permission.ts`, `cash-register`), and a till signed in with a
 * PIN reaches it too.
 *
 * Its one write is the storno (FR-21.18): the till's own route needs the session in its path, but a
 * back-office sale has no receipt and no drawer, so it is reversed here without one. A till sale
 * still names the session its refund leaves.
 */
const literal = <T extends string>(...values: T[]) => t.Optional(t.Union(values.map(v => t.Literal(v))))

export const cashRegisterController = new Elysia({ prefix: '/org/:orgId/cash-register' })
  .use(AppAuthService)
  // FR-24.50: the routes that reach a fiscal device say which; one held on another pod runs there.
  .use(FiscalRoute)
  // FR-21.28: refused, with the reason, until the till's history may be read from documents only.
  .onBeforeHandle(async ({ status }) => {
    const refusal = await cashRegisterRefusal()
    if (refusal) return status(503, refusal)
  })
  .get(
    '/documents',
    async ({ params: { orgId }, query, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })
      // Calendar days in the org's own zone; a Bulgarian day when it has none.
      const org: any = await orgDao.findById(orgId)
      return listJournal({
        orgId,
        search: query.search || undefined,
        kind: query.kind,
        origin: query.origin,
        status: query.status,
        fiscalState: query.fiscalState || undefined,
        sessionId: query.sessionId || undefined,
        warehouseId: query.warehouseId || undefined,
        cashierId: query.cashierId || undefined,
        contactId: query.contactId || undefined,
        paymentMethod: query.paymentMethod || undefined,
        invoiced: query.invoiced,
        dateFrom: query.dateFrom || undefined,
        dateTo: query.dateTo || undefined,
        timeZone: org?.settings?.timezone || undefined,
        page: query.page !== undefined ? Number(query.page) : undefined,
        size: query.size !== undefined ? Number(query.size) : undefined,
        sortBy: query.sortBy,
        sortOrder: query.sortOrder,
      })
    },
    {
      isSignIn: true,
      query: t.Object({
        search: t.Optional(t.String()),
        kind: literal('sale', 'storno', 'payment'),
        origin: literal('pos', 'backoffice', 'import'),
        status: literal('completed', 'stornoed', 'voided'),
        fiscalState: t.Optional(t.String()),
        sessionId: t.Optional(t.String()),
        warehouseId: t.Optional(t.String()),
        cashierId: t.Optional(t.String()),
        contactId: t.Optional(t.String()),
        paymentMethod: t.Optional(t.String()),
        invoiced: literal('yes', 'no'),
        dateFrom: t.Optional(t.String()),
        dateTo: t.Optional(t.String()),
        page: t.Optional(t.String()),
        size: t.Optional(t.String()),
        sortBy: literal('date', 'number', 'total'),
        sortOrder: literal('asc', 'desc'),
      }),
    },
  )
  .get('/documents/:id', async ({ params: { orgId, id }, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    const doc = await getJournalDocument(orgId, id)
    if (!doc) return status(404, { message: 'Cash-register document not found' })
    return doc
  }, { isSignIn: true })
  // FR-23: a person who looked at the device says whether a receipt or a storno nothing could prove printed.
  .post(
    '/documents/:id/settle',
    async ({ params: { orgId, id }, body, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })
      // It decides what happened to money: the same roles as a storno.
      if (!STORNO_ROLES.includes(user.role)) {
        return status(403, { message: 'Settling a receipt requires manager or admin authorization' })
      }
      const held: any = Invoice.base.Types.ObjectId.isValid(id)
        ? await Invoice.findOne({ _id: id, orgId, type: { $in: SETTLEABLE_TYPES } }).lean().exec()
        : null
      if (!held) return status(404, { message: 'Receipt not found' })
      try {
        // What the device says, when it is here. Nothing that follows reaches it.
        const { printer } = await documentContext(orgId, user, held)
        const settled = await settleInDoubt(deviceless(orgId, user), id, body.printed, printer)
        if (!settled) return status(409, { code: 'receipt_not_in_doubt', message: 'This document is not waiting to be settled.' })
      } catch (e: any) {
        if (e instanceof RegisterRefusal) return status(e.statusCode, e.body)
        throw e
      }
      return { document: await getJournalDocument(orgId, id) }
    },
    { isSignIn: true, fiscalDevice: deviceFromJournalDocument, body: t.Object({ printed: t.Boolean() }) },
  )
  .post(
    '/documents/:id/storno',
    async ({ params: { orgId, id }, body, user, status, headers }) => {
      if (!user) return status(401, { message: 'Unauthorized' })
      // H4: the same roles as the till's storno.
      if (!STORNO_ROLES.includes(user.role)) {
        return status(403, { message: 'Storno requires manager or admin authorization' })
      }

      let key: string | undefined
      try {
        key = readIdempotencyKey(headers)
      } catch (e: any) {
        return status(e.statusCode, { code: e.code, message: e.message })
      }

      let session: any = null
      if (body.sessionId) {
        session = POSSession.base.Types.ObjectId.isValid(body.sessionId)
          ? await POSSession.findOne({ _id: body.sessionId, orgId }).lean().exec()
          : null
        if (!session) return status(404, { message: 'POS session not found' })
      }

      const out = await stornoDoor({
        orgId, user, originalId: id, reason: body.reason, payments: body.payments, session,
        key, hash: key ? requestHash(`cash-register.storno:${id}`, body) : undefined,
      })
      return 'status' in out ? status(out.status, out.body) : out
    },
    {
      isSignIn: true, fiscalDevice: deviceFromJournalDocument,
      body: t.Object({
        reason: t.Union([t.Literal('operator_error'), t.Literal('customer_return'), t.Literal('price_reduction'), t.Literal('tax_base_reduction')]),
        /** The open session a till sale's refund leaves; a back-office sale takes none. */
        sessionId: t.Optional(t.String()),
        // Any string: refused by hand before anything is written (`stornoDoor`), with its reason.
        payments: t.Optional(t.Array(t.Object({
          method: t.String(),
          amount: t.Number(),
          reference: t.Optional(t.String()),
        }))),
      }),
    },
  )
