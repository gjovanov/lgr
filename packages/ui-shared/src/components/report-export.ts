/**
 * Where a list's Export leads (FR-31.11): its report in Reports, with the list's filters under the report's parameter
 * names, as `ReportRunner` reads them from the address (`useListQueryState`: a period is `<key>Preset`, `<key>From`,
 * `<key>To`; a multiselect a comma-joined list; a switch `true`).
 */
export type ReportQuery = Record<string, string | number | boolean | readonly string[] | null | undefined>

export function reportHref(report: string, query: ReportQuery = {}): string {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) {
    if (value === null || value === undefined || value === '' || value === false) continue
    if (Array.isArray(value)) {
      if (value.length) params.set(key, value.join(','))
      continue
    }
    params.set(key, value === true ? 'true' : String(value))
  }
  const qs = params.toString()
  return `/reports/${report}${qs ? `?${qs}` : ''}`
}

/** A list's date range as a report's period: a custom one when either end is set, else the report's own default. */
export function periodQuery(key: string, from?: string | null, to?: string | null): ReportQuery {
  if (!from && !to) return {}
  return { [`${key}Preset`]: 'custom', [`${key}From`]: from || undefined, [`${key}To`]: to || undefined }
}
