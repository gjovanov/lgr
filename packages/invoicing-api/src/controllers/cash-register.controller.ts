import { Elysia, t } from 'elysia'
import { AppAuthService } from '../auth/app-auth.service.js'
import { orgDao } from 'services/dao/org.dao'
import { getJournalDocument, listJournal } from 'services/biz/cash-register/journal.service'

/**
 * FR-21.12 — the cash-register journal („Касови продажби").
 *
 * One list and one detail for every cash-register sale and storno: the till's, the back office's
 * and the PlusMinus imports'. The POS app shows it at `/pos/orders` and the invoicing app at
 * `/invoicing/cash-sales`, so its readers are either app's (`route-permission.ts`, `cash-register`),
 * and a till signed in with a PIN reaches it too. Read-only: nothing here writes.
 */
const literal = <T extends string>(...values: T[]) => t.Optional(t.Union(values.map(v => t.Literal(v))))

export const cashRegisterController = new Elysia({ prefix: '/org/:orgId/cash-register' })
  .use(AppAuthService)
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
        kind: literal('sale', 'storno'),
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
