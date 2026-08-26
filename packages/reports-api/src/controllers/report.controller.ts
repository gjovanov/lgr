import { Elysia, t } from 'elysia'
import { AppAuthService } from '../auth/app-auth.service.js'
import { Org } from 'db/models'
import {
  listReportsFor,
  reportById,
  canAccessReport,
  validateParams,
  ReportParamError,
  rowCapFor,
  type ReportEntry,
  type ReportResult,
} from 'services/biz/report-registry'
import { generateReportExcel } from 'reporting/excel/report.excel'
import { generateReportPdf } from 'reporting/pdf/report.pdf'
import { getOrgLogoDataUri } from 'services/biz/org-logo.service'

/**
 * FR-06 (#14) — the Reports module's three endpoints. All of them read; none writes
 * (FR-6.13). Everything report-specific lives in the registry, so this controller does not
 * grow when a report is added.
 *
 * The gate (FR-6.7) is `canAccessReport`, applied identically by all three: the catalog is
 * a VIEW of it, not the security boundary — run and export re-check before doing any work.
 * A report the caller may not run answers 404, not 403: the catalog already told them it
 * does not exist for them, and 403 would confirm that a report by that id does.
 *
 * Side effect worth noting: routing the aging report through here finally puts a permission
 * check on that data. `GET /invoicing/reports/aging` is `isSignIn` only — any authenticated
 * user of any role can read every customer's outstanding balance. That endpoint stays
 * mounted and byte-compatible (FR-6.20), but the Reports app reaches it behind
 * `invoicing.read`.
 */

/** Column headers arrive translated from the UI — see reporting/excel/report.excel.ts. */
const MAX_LABEL_LEN = 120

interface ResolvedReport {
  entry: ReportEntry
  params: Record<string, any>
}

function resolve(id: string, rawParams: any, user: any): ResolvedReport | { error: { status: 404 | 422; message: string } } {
  const entry = reportById(id)
  if (!entry || !canAccessReport(entry, user)) {
    return { error: { status: 404, message: `Unknown report: ${id}` } }
  }
  if (!entry.handler) {
    return { error: { status: 422, message: `Report ${id} has its own page and no generic handler` } }
  }
  try {
    return { entry, params: validateParams(entry, rawParams) }
  } catch (e) {
    if (e instanceof ReportParamError) return { error: { status: 422, message: e.message } }
    throw e
  }
}

/**
 * Merge the caller's column selection (the `useExportColumns` picker contract: an ordered
 * list of keys) with the handler's own column definitions, which carry the cell types.
 * Unknown keys are dropped rather than rejected — a stale saved selection should degrade,
 * not 400 — but an empty intersection falls back to the full set.
 */
function pickColumns(
  result: ReportResult,
  keys: string[] | undefined,
  labels: Record<string, string> | undefined,
) {
  const defs = new Map(result.columns.map(c => [c.key, c]))
  const ordered = keys?.length
    ? keys.map(k => defs.get(k)).filter((c): c is NonNullable<typeof c> => !!c)
    : result.columns
  const cols = ordered.length ? ordered : result.columns
  return cols.map(c => ({
    key: c.key,
    header: (labels?.[c.key] || c.labelKey).slice(0, MAX_LABEL_LEN),
    type: c.type,
  }))
}

/**
 * How the PDF's closing box is filled.
 *
 * A handler that produced a per-currency reconciliation (`meta.summary` — sales history)
 * gets THAT as the box, because "expected cash / card / other" is the number the operator
 * actually came for. Everything else falls through to the renderer's default, which derives
 * the box from the report's own column totals.
 *
 * Mixed currencies suppress the box entirely: summing across them would be meaningless.
 */
function totalsBoxFor(result: ReportResult, b: any) {
  const meta: any = result.meta || {}

  if (meta.mixedCurrency) {
    return { mixedCurrencyNote: b.labels_meta?.mixedCurrency }
  }

  const summary = Array.isArray(meta.summary) ? meta.summary[0] : undefined
  const labels = b.summaryLabels
  if (summary && labels) {
    const cur = summary.currency ? ` ${summary.currency}` : ''
    const money = (n: number) => `${Number(n || 0).toFixed(2)}${cur}`
    return {
      currency: summary.currency,
      summaryLines: [
        { label: labels.operations, value: String(summary.count) },
        { label: labels.expectedCash, value: money(summary.cash), separator: true },
        { label: labels.cardPayments, value: money(summary.card) },
        ...(summary.other ? [{ label: labels.otherPayments, value: money(summary.other) }] : []),
        { label: labels.systemSales, value: money(summary.total), grand: true },
      ],
    }
  }

  // Single-currency reports name their currency so the derived box can print it.
  const currencies: string[] = Array.isArray(meta.currencies) ? meta.currencies : []
  return { currency: currencies.length === 1 ? currencies[0] : undefined }
}

function filenameFor(id: string, format: string): string {
  const stamp = new Date().toISOString().slice(0, 10)
  return `${id}-${stamp}.${format}`
}

// Named `reportsController` (plural): `reportController` is already taken in unified.ts by
// accounting's financial-statement controller.
export const reportsController = new Elysia({ prefix: '/org/:orgId/reports' })
  .use(AppAuthService)

  /**
   * The catalog. Returns only what this caller may see — the card hub renders it verbatim
   * and never filters client-side, so a report is not merely hidden, it is absent.
   */
  .get('/catalog', ({ user, status }) => {
    // The explicit check is load-bearing, NOT belt-and-braces: the `isSignIn` macro does
    // not actually reject anonymous callers on these controllers (verified against the
    // running server — every endpoint that answers 401 does so from a check like this one).
    // Without it an anonymous caller gets 200 + an empty list, which reads like "you have
    // no reports" rather than "you are not signed in".
    if (!user) return status(401, { message: 'Unauthorized' })
    return { reports: listReportsFor(user) }
  }, { isSignIn: true })

  /** Run a registry-driven report and return its table. */
  .post('/:id/run', async ({ params: { orgId, id }, body, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    const resolved = resolve(id, (body as any)?.params, user)
    if ('error' in resolved) return status(resolved.error.status, { message: resolved.error.message })

    const result = await resolved.entry.handler!({
      orgId,
      params: resolved.params,
      output: 'table',
      locale: (body as any)?.locale,
    })

    return {
      id,
      columns: result.columns,
      rows: result.rows,
      totals: result.totals,
      meta: {
        ...result.meta,
        cap: result.meta?.cap ?? rowCapFor('table'),
        // The export re-runs the report under a bigger cap, so a truncated table does NOT
        // mean a truncated file. The dialog says so, and needs the numbers to say it with.
        exportCaps: { xlsx: rowCapFor('xlsx'), pdf: rowCapFor('pdf') },
      },
    }
  }, {
    isSignIn: true,
    body: t.Object({
      params: t.Optional(t.Record(t.String(), t.Any())),
      locale: t.Optional(t.String()),
    }),
  })

  /** Render a registry-driven report to XLSX or PDF via the shared reporting stack. */
  .post('/:id/export', async ({ params: { orgId, id }, body, user, status, set }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    const b = body as any
    const resolved = resolve(id, b?.params, user)
    if ('error' in resolved) return status(resolved.error.status, { message: resolved.error.message })

    const format = b.format as 'xlsx' | 'pdf'
    if (!resolved.entry.outputs.includes(format)) {
      return status(422, { message: `Report ${id} does not offer ${format}` })
    }

    const result = await resolved.entry.handler!({
      orgId,
      params: resolved.params,
      output: format,
      locale: b.locale,
    })

    const org = await Org.findById(orgId).lean()
    const orgName = (org as any)?.name || 'Organization'
    const columns = pickColumns(result, b.columns, b.labels)
    const title = b.title || id
    // A `period` param, when the report has one, is what the header block prints.
    const period = Object.values(resolved.params).find(
      (v: any) => v && typeof v === 'object' && ('from' in v || 'to' in v),
    ) as { from?: string; to?: string } | undefined

    const filename = filenameFor(id, format)

    if (format === 'xlsx') {
      const buffer = await generateReportExcel({
        title,
        orgName,
        columns,
        rows: result.rows,
        totals: result.totals,
        totalsLabel: b.totalsLabel,
        period,
      })
      set.headers['content-type'] = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      set.headers['content-disposition'] = `attachment; filename="${filename}"`
      return new Response(buffer)
    }

    const buffer = await generateReportPdf({
      title,
      orgName,
      columns,
      rows: result.rows,
      totals: result.totals,
      totalsLabel: b.totalsLabel,
      period,
      locale: b.locale,
      logo: (await getOrgLogoDataUri(orgId)) ?? (org as any)?.logo,
      // The renderer carries no i18n table of its own — the UI resolves these, exactly as it
      // already does for the column headers.
      labels: b.labels_meta,
      // Whatever the user filtered by, printed in the header block so a shared PDF is
      // self-describing ("Operation: Sales", "Warehouse: СКЛАД-1").
      extraMeta: Array.isArray(b.meta) ? b.meta.slice(0, 8) : undefined,
      ...totalsBoxFor(result, b),
    })
    if (!buffer) return status(500, { message: 'PDF generation failed' })

    set.headers['content-type'] = 'application/pdf'
    set.headers['content-disposition'] = `attachment; filename="${filename}"`
    return new Response(buffer)
  }, {
    isSignIn: true,
    body: t.Object({
      format: t.Union([t.Literal('xlsx'), t.Literal('pdf')]),
      params: t.Optional(t.Record(t.String(), t.Any())),
      /** Ordered column keys from the picker; unknown keys are ignored. */
      columns: t.Optional(t.Array(t.String())),
      /** Column key → localized header, resolved by the UI from the registry's labelKeys. */
      labels: t.Optional(t.Record(t.String(), t.String())),
      title: t.Optional(t.String()),
      totalsLabel: t.Optional(t.String()),
      /** Localized meta-block labels (Period / Generated / Rows / empty-state). */
      labels_meta: t.Optional(t.Object({
        period: t.Optional(t.String()),
        generated: t.Optional(t.String()),
        rows: t.Optional(t.String()),
        noRows: t.Optional(t.String()),
        mixedCurrency: t.Optional(t.String()),
      })),
      /** Localized labels for the reconciliation box, when the report produces a summary. */
      summaryLabels: t.Optional(t.Object({
        operations: t.String(),
        systemSales: t.String(),
        expectedCash: t.String(),
        cardPayments: t.String(),
        otherPayments: t.String(),
      })),
      /** Extra localized header lines describing the filters that produced this run. */
      meta: t.Optional(t.Array(t.Object({
        label: t.String(),
        value: t.Union([t.String(), t.Number()]),
      }))),
      locale: t.Optional(t.String()),
    }),
  })
