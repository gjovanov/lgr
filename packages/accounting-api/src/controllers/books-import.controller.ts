import { Elysia, t } from 'elysia'
import { AppAuthService } from '../auth/app-auth.service.js'
import {
  BooksImportError,
  finishImport,
  importAnalytics,
  importChart,
  importJournalMonth,
  importOpening,
} from 'services/biz/accounting-books/import.service'
import { analyticTrialBalance, mainBook, trialBalance } from 'services/biz/accounting-books/books-ledger'

/**
 * FR-25 §5: a legal entity's books from PlusMinus. Driven by `scripts/import-accounting-books.ts`,
 * which reads the exports and sends one month at a time. Refused for any org that is not a books org.
 *
 * Every route answers with what it would change, and writes only on `dryRun: false`.
 */

const Source = { eik: t.String({ minLength: 1 }), dryRun: t.Optional(t.Boolean()) }
const Day = t.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}$' })

const Operation = t.Object({
  d: t.String({ minLength: 1 }),
  k: t.String({ minLength: 1 }),
  ad: t.Optional(t.String()),
  ak: t.Optional(t.String()),
  qty: t.Optional(t.Number()),
  amount: t.Number(),
  cur: t.Optional(t.String()),
  rate: t.Optional(t.Number()),
  fx: t.Optional(t.Number()),
  comment: t.Optional(t.String()),
  journal: t.Optional(t.String()),
  tax: t.Optional(t.String()),
})

const Document = t.Object({
  date: Day,
  docType: t.Optional(t.String()),
  docNumber: t.Optional(t.String()),
  vatKind: t.Optional(t.String()),
  total: t.Optional(t.Number()),
  comment: t.Optional(t.String()),
  ops: t.Array(Operation),
})

const AnalyticItem = t.Object({
  path: t.String({ minLength: 1 }),
  unit: t.Optional(t.String()),
  taxId: t.Optional(t.String()),
  vatNumber: t.Optional(t.String()),
  address: t.Optional(t.String()),
  city: t.Optional(t.String()),
  phone: t.Optional(t.String()),
  contactPerson: t.Optional(t.String()),
  bankName: t.Optional(t.String()),
  foreignCurrency: t.Optional(t.Boolean()),
})

const OpeningLine = { code: t.String({ minLength: 1 }), debit: t.Number(), credit: t.Number() }

function refused(e: unknown, status: any) {
  if (e instanceof BooksImportError) return status(e.statusCode, { message: e.message, code: e.code, ...e.extra })
  throw e
}

export const booksImportController = new Elysia({ prefix: '/org/:orgId/accounting/import' })
  .use(AppAuthService)
  .post('/chart', async ({ params: { orgId }, body, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    try {
      return await importChart(orgId, body, user)
    } catch (e) {
      return refused(e, status)
    }
  }, {
    isSignIn: true,
    body: t.Object({ ...Source, accounts: t.Array(t.Object({ code: t.String(), name: t.String() })) }),
  })
  .post('/analytics', async ({ params: { orgId }, body, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    try {
      return await importAnalytics(orgId, body, user)
    } catch (e) {
      return refused(e, status)
    }
  }, {
    isSignIn: true,
    body: t.Object({ ...Source, items: t.Array(AnalyticItem) }),
  })
  .post('/opening', async ({ params: { orgId }, body, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    try {
      return await importOpening(orgId, body, user)
    } catch (e) {
      return refused(e, status)
    }
  }, {
    isSignIn: true,
    body: t.Object({
      ...Source,
      year: t.Integer({ minimum: 2000, maximum: 2100 }),
      accounts: t.Array(t.Object(OpeningLine)),
      analytics: t.Optional(t.Array(t.Object({ ...OpeningLine, path: t.String({ minLength: 1 }), quantity: t.Optional(t.Number()) }))),
    }),
  })
  .post('/journal', async ({ params: { orgId }, body, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    try {
      return await importJournalMonth(orgId, body, user)
    } catch (e) {
      return refused(e, status)
    }
  }, {
    isSignIn: true,
    body: t.Object({
      ...Source,
      month: t.String({ pattern: '^\\d{4}-\\d{2}$' }),
      coverage: t.Object({ from: Day, to: Day }),
      documents: t.Array(Document),
    }),
  })
  .post('/finish', async ({ params: { orgId }, body, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    try {
      return await finishImport(orgId, body, user)
    } catch (e) {
      return refused(e, status)
    }
  }, {
    isSignIn: true,
    body: t.Object(Source),
  })

/**
 * The imported books as data, whole: what `scripts/compare-accounting-books.ts` checks against
 * PlusMinus's own exports. The reports read the same functions, under the report row caps.
 */
const Period = t.Object({ from: Day, to: Day, root: t.Optional(t.String()) })

export const booksLedgerController = new Elysia({ prefix: '/org/:orgId/accounting/books' })
  .use(AppAuthService)
  .get('/trial-balance', async ({ params: { orgId }, query, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    return trialBalance(orgId, query)
  }, { isSignIn: true, query: Period })
  .get('/analytic-trial-balance', async ({ params: { orgId }, query, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    return analyticTrialBalance(orgId, query, query.root)
  }, { isSignIn: true, query: Period })
  .get('/main-book', async ({ params: { orgId }, query, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    return mainBook(orgId, query)
  }, { isSignIn: true, query: Period })
