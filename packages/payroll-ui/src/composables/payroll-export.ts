/**
 * #830: the address of a payroll list's export. Import-pure, so `unit/payroll-export.test.ts` reads it without Vue.
 *
 * The export takes the list's own query (its filters and its order: what the list's GET takes), the format, the
 * reader's language and the screen's words for the file (`labels`, JSON), the way the analytics grid exports.
 */
export type PayrollList = 'employee' | 'run' | 'payslip' | 'timesheet'
export type ExportFormat = 'xlsx' | 'pdf'

export interface PayrollExportRequest {
  filters: Record<string, unknown>
  sortBy?: string
  sortOrder?: 'asc' | 'desc'
  format: ExportFormat
  locale?: string
  labels: Record<string, unknown>
}

export function payrollExportPath(orgUrl: string, list: PayrollList, req: PayrollExportRequest): string {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(req.filters)) {
    if (value === undefined || value === null || value === '') continue
    if (Array.isArray(value)) {
      if (value.length) params.set(key, value.join(','))
      continue
    }
    params.set(key, String(value))
  }
  if (req.sortBy) params.set('sortBy', req.sortBy)
  if (req.sortOrder) params.set('sortOrder', req.sortOrder)
  params.set('format', req.format)
  if (req.locale) params.set('locale', req.locale)
  params.set('labels', JSON.stringify(req.labels))
  return `${orgUrl}/payroll/${list}/export?${params}`
}

/** A stored value → its word, for each value the screen has a word for. */
export function wordsOf(values: readonly string[], word: (value: string) => string): Record<string, string> {
  return Object.fromEntries(values.map(v => [v, word(v)]))
}
