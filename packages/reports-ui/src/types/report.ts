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
  /** A fixed side, for reports where it never changes. `contactSideFrom` wins over it. */
  contactSide?: 'customer' | 'supplier'
}

/** `status`: a document status (`paid`, `voided`…), printed through `invoicing.status.*`. */
export type ColumnType = 'text' | 'money' | 'quantity' | 'int' | 'percent' | 'date' | 'status'

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
  meta?: {
    truncated?: boolean
    cap?: number
    rowCount?: number
    /** Row caps the export runs under — bigger than the table's (FR-6.15). */
    exportCaps?: { xlsx: number; pdf: number }
    [k: string]: any
  }
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

/**
 * Client-side preset → from/to, mirroring `resolvePeriod` in the server's registry types.
 *
 * Registry reports do NOT rely on this — they send the preset and the server re-resolves it,
 * never trusting the client's arithmetic. It exists for the SUPTO page (P2), whose download
 * goes to the pre-existing `/supto/export/:tableId`, an endpoint that has always taken
 * concrete `dateFrom`/`dateTo` and is frozen byte-compatible (FR-6.20).
 */
export function resolvePeriod(value: PeriodValue | undefined, now = new Date()): { from?: string; to?: string } {
  const iso = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  const preset = value?.preset ?? 'custom'
  if (preset === 'custom') return { from: value?.from, to: value?.to }

  const y = now.getFullYear()
  const m = now.getMonth()
  const d = now.getDate()
  switch (preset) {
    case 'today': return { from: iso(new Date(y, m, d)), to: iso(new Date(y, m, d)) }
    case 'this_week': {
      const dow = (now.getDay() + 6) % 7 // ISO week: Monday-start.
      return { from: iso(new Date(y, m, d - dow)), to: iso(new Date(y, m, d - dow + 6)) }
    }
    case 'this_month': return { from: iso(new Date(y, m, 1)), to: iso(new Date(y, m + 1, 0)) }
    case 'last_month': return { from: iso(new Date(y, m - 1, 1)), to: iso(new Date(y, m, 0)) }
    case 'this_quarter': {
      const q = Math.floor(m / 3) * 3
      return { from: iso(new Date(y, q, 1)), to: iso(new Date(y, q + 3, 0)) }
    }
    case 'this_year': return { from: iso(new Date(y, 0, 1)), to: iso(new Date(y, 11, 31)) }
    default: return {}
  }
}
