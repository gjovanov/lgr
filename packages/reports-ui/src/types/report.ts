/**
 * FR-06 (#14) — the wire shape of `GET /org/:orgId/reports/catalog` and
 * `POST /reports/:id/run`.
 *
 * This MIRRORS `services/src/biz/report-registry.types.ts` and deliberately does not import
 * it: no other `*-ui` package depends on `services`, and adding that edge would put one
 * `import` away from pulling mongoose into the browser bundle — the exact hazard FR-6.6
 * calls out. The duplication is a dozen lines of types with no logic; the compile-time
 * check that they still agree is the integration test over the catalog endpoint.
 *
 * Server-side fields that gate access (`permission`, `roles`) are absent by design: a report
 * the caller may not run never appears in the response at all.
 */

export type ReportCategory = 'sales' | 'purchase' | 'receivables' | 'inventory' | 'fiscal'

export type ReportOutput = 'table' | 'xlsx' | 'pdf'

export type ParamType =
  | 'period' | 'date' | 'contact' | 'warehouse' | 'product' | 'category' | 'user'
  | 'select' | 'multiselect' | 'bool' | 'text'

export interface ParamDef {
  key: string
  type: ParamType
  labelKey: string
  required?: boolean
  default?: unknown
  options?: { value: string; labelKey: string }[]
  /** Narrows a contact picker to customers or suppliers based on a sibling param's value. */
  contactSideFrom?: { param: string; map: Record<string, 'customer' | 'supplier'> }
}

export type ColumnType = 'text' | 'money' | 'quantity' | 'int' | 'percent' | 'date'

export interface ReportColumn {
  key: string
  labelKey: string
  type?: ColumnType
  align?: 'start' | 'end' | 'center'
}

export interface ReportMeta {
  id: string
  category: ReportCategory
  labelKey: string
  descriptionKey: string
  icon: string
  outputs: ReportOutput[]
  params: ParamDef[]
  view: 'runner' | 'custom'
  route: string
}

export interface ReportRunResult {
  id: string
  columns: ReportColumn[]
  rows: Record<string, any>[]
  totals?: Record<string, number>
  meta?: { truncated?: boolean; cap?: number; rowCount?: number; [k: string]: any }
}

export const PERIOD_PRESETS = [
  'today', 'this_week', 'this_month', 'last_month', 'this_quarter', 'this_year', 'custom',
] as const
export type PeriodPreset = (typeof PERIOD_PRESETS)[number]

export interface PeriodValue {
  preset?: PeriodPreset
  from?: string
  to?: string
}
