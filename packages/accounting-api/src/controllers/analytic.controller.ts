import { Elysia, t } from 'elysia'
import { Org } from 'db/models'
import { generateReportExcel, type ReportSheetColumn } from 'reporting/excel/report.excel'
import { AppAuthService } from '../auth/app-auth.service.js'
import {
  AnalyticsError,
  analyticRoots,
  analyticsForExport,
  bankOperationCounts,
  deactivateAnalytic,
  getAnalytic,
  listAnalytics,
  updateAnalytic,
} from 'services/biz/accounting-books/analytics.service'
import { MAX_PARAMS, MAX_PARAM_KEY, MAX_PARAM_VALUE } from 'services/biz/accounting-books/analytics-query'
import { rowCapFor } from 'services/biz/report-registry.types'

/**
 * FR-25a §3.2: the analytics of the books (`AccountingAnalytic`). Reading them is the chart's (`accounts.view`);
 * changing one, what links to it and its properties, is `accounts.edit`, and only on an analytic of LGR's own: one of a
 * books org answers 422 `books_as_booked` (`analytics.service.ts`). Nothing here creates or deletes an analytic: the
 * import makes them, and a line may point at any of them.
 */

const Id = t.String({ pattern: '^[a-fA-F0-9]{24}$' })
/** An id links; null or '' unlinks. */
const Link = t.Optional(t.Union([Id, t.Null(), t.Literal('')]))

const Change = t.Object({
  // A PUT never carries `orgId`: a document does not move between orgs (FR-20.7).
  orgId: t.Optional(t.Never()),
  contactId: Link,
  bankAccountId: Link,
  fixedAssetId: Link,
  params: t.Optional(t.Array(
    t.Object({ key: t.String({ maxLength: MAX_PARAM_KEY }), value: t.Optional(t.String({ maxLength: MAX_PARAM_VALUE })) }),
    { maxItems: MAX_PARAMS },
  )),
  isActive: t.Optional(t.Boolean()),
})

function refused(e: unknown, status: any) {
  if (e instanceof AnalyticsError) return status(e.statusCode, { message: e.message, code: e.code })
  throw e
}

/** The export's words, from the UI's catalogue (the server has none for these): plain text only, each optional. */
interface ExportLabels {
  title?: string
  columns?: Record<string, string>
  kinds?: Record<string, string>
  roots?: Record<string, string>
  yes?: string
  no?: string
}

function labelsOf(raw: unknown): ExportLabels {
  if (typeof raw !== 'string' || raw.length > 20_000) return {}
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

const word = (map: Record<string, string> | undefined, key: string, fallback: string) =>
  (map && typeof map[key] === 'string' && map[key]) || fallback

export const analyticController = new Elysia({ prefix: '/org/:orgId/accounting/analytics' })
  .use(AppAuthService)
  .get('/', async ({ params: { orgId }, query, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    return listAnalytics(orgId, query as Record<string, unknown>)
  }, { isSignIn: true })
  .get('/roots', async ({ params: { orgId }, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    return analyticRoots(orgId)
  }, { isSignIn: true })
  // FR-25a §3.3: the bank accounts list's "bank operations this month".
  .get('/bank-operations', async ({ params: { orgId }, query, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    try {
      return await bankOperationCounts(orgId, String((query as any).month ?? ''))
    } catch (e) {
      return refused(e, status)
    }
  }, { isSignIn: true })
  // The grid as an Excel sheet: the same filters and order, every row up to the export cap.
  .get('/export', async ({ params: { orgId }, query, user, set, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    const q = query as Record<string, unknown>
    const labels = labelsOf(q.labels)
    const cap = rowCapFor('xlsx')
    const [{ rows, truncated }, org] = await Promise.all([
      analyticsForExport(orgId, q, cap),
      Org.findById(orgId, { name: 1 }).lean() as Promise<any>,
    ])
    const col = (key: string, fallback: string, width?: number): ReportSheetColumn => ({ key, header: word(labels.columns, key, fallback), ...(width ? { width } : {}) })
    const yes = labels.yes || 'Yes'
    const no = labels.no || 'No'
    const buffer = await generateReportExcel({
      title: labels.title || 'Analytics',
      orgName: org?.name ?? '',
      columns: [
        col('path', 'Path', 48),
        col('root', 'Root'),
        col('kind', 'Kind'),
        col('unit', 'Unit'),
        col('contact', 'Contact', 32),
        col('bankAccount', 'Bank account', 28),
        col('fixedAsset', 'Fixed asset', 28),
        col('isActive', 'Active'),
      ],
      rows: rows.map(r => ({
        path: r.path,
        root: word(labels.roots, r.root, r.root),
        kind: word(labels.kinds, r.kind, r.kind),
        unit: r.unit ?? '',
        contact: r.contactName ?? '',
        bankAccount: r.bankAccountName ?? '',
        fixedAsset: r.fixedAssetName ?? '',
        isActive: r.isActive ? yes : no,
      })),
    })
    set.headers['content-type'] = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    set.headers['content-disposition'] = `attachment; filename="analytics-${new Date().toISOString().slice(0, 10)}.xlsx"`
    // A sheet cut at the cap says so, rather than passing for the whole tree.
    if (truncated) set.headers['x-truncated'] = String(cap)
    return new Response(buffer)
  }, { isSignIn: true })
  .get('/:id', async ({ params: { orgId, id }, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    try {
      return await getAnalytic(orgId, id)
    } catch (e) {
      return refused(e, status)
    }
  }, { isSignIn: true })
  .put('/:id', async ({ params: { orgId, id }, body, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    try {
      return await updateAnalytic(orgId, id, body, user)
    } catch (e) {
      return refused(e, status)
    }
  }, { isSignIn: true, body: Change })
  // Soft, as every nomenclature's delete: the analytic stays, with every line that names it.
  .delete('/:id', async ({ params: { orgId, id }, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    try {
      return await deactivateAnalytic(orgId, id, user)
    } catch (e) {
      return refused(e, status)
    }
  }, { isSignIn: true })
