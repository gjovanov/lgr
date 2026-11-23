import { generateReportExcel } from 'reporting/excel/report.excel'
import { generateReportPdf } from 'reporting/pdf/report.pdf'
import { getOrgLogoDataUri } from 'services/biz/org-logo.service'
import { rowCapFor } from 'services/biz/report-registry.types'
import { payrollListTable, type PayrollListKind } from 'services/biz/payroll/list-export'
import { getRepos } from 'services/context'

/**
 * #830: a payroll list as an Excel sheet or a PDF, as the analytics grid and the reports export one: the list's own
 * filters and order (the same query its GET takes), every row up to the export cap, in the screen's words (`labels`),
 * through the shared house-style generators. A file the cap cut says so in `x-truncated`.
 *
 * It is a GET on the list's own path, so it needs exactly what reading the list needs (`config/access/routes.ts`), and
 * it writes nothing. What it prints, and what it never does: `services/biz/payroll/list-export.ts`.
 */
export async function listExport(
  kind: PayrollListKind,
  orgId: string,
  query: Record<string, unknown>,
): Promise<Response | null> {
  const format = query.format === 'pdf' ? 'pdf' : 'xlsx'
  const cap = rowCapFor(format)
  const [table, org] = await Promise.all([payrollListTable(kind, orgId, query, cap), getRepos().orgs.findById(orgId)])
  const orgName = org?.name ?? ''
  const filename = `${kind}-${new Date().toISOString().slice(0, 10)}.${format}`

  let buffer: Buffer | undefined
  if (format === 'xlsx') {
    buffer = await generateReportExcel({
      title: table.title,
      orgName,
      columns: table.columns,
      rows: table.rows,
      totals: table.totals,
      totalsLabel: table.totalsLabel,
      period: table.period,
    })
  } else {
    buffer = await generateReportPdf({
      title: table.title,
      orgName,
      columns: table.columns.map(c => ({ key: c.key, header: c.header, ...(c.type ? { type: c.type } : {}) })),
      rows: table.rows,
      totals: table.totals,
      totalsLabel: table.totalsLabel,
      period: table.period,
      locale: typeof query.locale === 'string' ? query.locale.slice(0, 10) : undefined,
      logo: (await getOrgLogoDataUri(orgId)) ?? org?.logo,
      labels: table.meta,
      extraMeta: table.filters.slice(0, 8),
      currency: table.currency,
    })
  }
  if (!buffer) return null

  const headers: Record<string, string> = {
    'content-type': format === 'pdf' ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'content-disposition': `attachment; filename="${filename}"`,
  }
  // A file cut at the cap says so, rather than passing for the whole list.
  if (table.truncated) headers['x-truncated'] = String(cap)
  return new Response(buffer, { headers })
}

/** What a list's `/export` answers when the file could not be made (the renderer gave nothing back). */
export const EXPORT_FAILED = { message: 'The export could not be made', code: 'export_failed' }
