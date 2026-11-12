/**
 * FR-06 (#14) — the report registry's CONTRACT: its types plus the pure functions that
 * operate on an entry without touching a database.
 *
 * `report-registry.ts` is server-only — its handlers reach Mongo through the models, so
 * importing it anywhere near a browser bundle would drag mongoose along. Everything here is
 * import-pure, which is why the access gate (`canAccessReport`), the parameter validator
 * (`validateParams`) and the wire projection (`toReportMeta`) live in this file rather than
 * next to the entries they are applied to: they are the part worth unit-testing, and this
 * way that test boots nothing.
 *
 * The wire contract: the UI's ONLY source of report metadata is
 * `GET /org/:orgId/reports/catalog`, which returns `ReportMeta[]` — this file's shape,
 * mirrored (deliberately, not imported) in `reports-ui/src/types/report.ts`.
 */
import { can as grantCan, compileLegacy, seesCosts, type CapabilityId, type Grant } from 'config/access'

export const REPORT_CATEGORIES = ['sales', 'purchase', 'receivables', 'inventory', 'accounting', 'fiscal'] as const
export type ReportCategory = (typeof REPORT_CATEGORIES)[number]

export type ReportOutput = 'table' | 'xlsx' | 'pdf'

/**
 * Parameter kinds the generic runner's filter bar knows how to render.
 * `period` is a from/to pair with presets (FR-6.11); the rest are single values.
 */
export type ParamType =
  | 'period'
  | 'date'
  | 'contact'
  | 'warehouse'
  | 'product'
  | 'category'
  | 'user'
  | 'select'
  /** Like `select`, but the value is a string[] of allowed option values. */
  | 'multiselect'
  | 'bool'
  | 'text'

/** Entity-reference params: the runner renders a server-searched autocomplete for each. */
export const LOOKUP_PARAM_TYPES = ['contact', 'warehouse', 'product', 'category', 'user'] as const

export interface ParamOption {
  value: string
  labelKey: string
}

export interface ParamDef {
  key: string
  type: ParamType
  labelKey: string
  required?: boolean
  /** Applied when the caller omits the param. For `period`, a `PeriodPreset`. */
  default?: unknown
  /** `select` / `multiselect` only. */
  options?: ParamOption[]
  /**
   * `contact` params only — narrows the picker to one side of the ledger. The value may be
   * the key of another param (e.g. `operation`) whose current value picks the side, so a
   * purchases report offers suppliers and a sales report offers customers.
   */
  contactSideFrom?: { param: string; map: Record<string, 'customer' | 'supplier'> }
  /**
   * `contact` params only — a FIXED side, for reports where it never changes (a purchase
   * register only ever wants suppliers). `contactSideFrom` wins when both are present.
   */
  contactSide?: 'customer' | 'supplier'
}

/** `status`: a document status (`paid`, `voided`…), which the UI prints in its own words. */
export type ColumnType = 'text' | 'money' | 'quantity' | 'int' | 'percent' | 'date' | 'status'

export interface ReportColumn {
  key: string
  labelKey: string
  type?: ColumnType
  align?: 'start' | 'end' | 'center'
  /**
   * FR-27.6 field groups: a column only a role holding the group sees (`costs`: `products.costs`). The runner drops it,
   * its cells and its total for any other, on screen and in the file (`withoutFieldGroups`).
   */
  fieldGroup?: 'costs'
}

export interface ReportResult {
  columns: ReportColumn[]
  rows: Record<string, any>[]
  /** Column-key → summed value, rendered as the grid's totals row. */
  totals?: Record<string, number>
  meta?: {
    /** Set when the row cap kicked in — the UI shows "narrow the period" (FR-6.15). */
    truncated?: boolean
    cap?: number
    rowCount?: number
    [k: string]: any
  }
}

/**
 * What `GET /reports/catalog` returns per entry — everything the hub card and the runner
 * need, and nothing that would leak the gate (`permission`/`roles` stay server-side; a
 * report the caller may not run is simply absent from the response).
 */
export interface ReportMeta {
  id: string
  category: ReportCategory
  labelKey: string
  descriptionKey: string
  icon: string
  outputs: ReportOutput[]
  params: ParamDef[]
  /**
   * `runner` — the generic `/reports/:id` view drives it from `params` + the run endpoint.
   * `custom` — the entry has its own hand-written view; the card links straight at `route`.
   *   (P1's two moved invoicing pages are richer than the runner v1; converting them into
   *   registry handlers is P2-optional.)
   */
  view: 'runner' | 'custom'
  /** App-relative path inside reports-ui, e.g. "/export" or "/inventory-valuation". */
  route: string
  /**
   * The format the runner's Export dialog starts on, when `outputs` offers it; absent: Excel. A register that is
   * printed and handed over (the sales documents) starts on PDF.
   */
  defaultExport?: 'xlsx' | 'pdf'
}

// ── Period presets (FR-6.11) ────────────────────────────────────────────────

export const PERIOD_PRESETS = [
  'today', 'this_week', 'this_month', 'last_month', 'this_quarter', 'this_year', 'custom',
] as const
export type PeriodPreset = (typeof PERIOD_PRESETS)[number]

export interface PeriodValue {
  preset?: PeriodPreset
  /** YYYY-MM-DD */
  from?: string
  /** YYYY-MM-DD */
  to?: string
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

export function isIsoDate(v: unknown): v is string {
  return typeof v === 'string' && DATE_RE.test(v)
}

function iso(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/**
 * Resolve a preset into a concrete from/to pair. Shared by the UI (to show the dates it is
 * about to request) and the server (which never trusts the client's arithmetic and always
 * re-resolves). `custom` passes the caller's own from/to through.
 *
 * Dates are calendar days in the caller's local zone — the same convention the existing
 * export endpoints use for their startDate/endDate query params.
 */
export function resolvePeriod(value: PeriodValue | undefined, now = new Date()): { from?: string; to?: string } {
  const preset = value?.preset ?? 'custom'
  if (preset === 'custom') {
    return {
      from: isIsoDate(value?.from) ? value!.from : undefined,
      to: isIsoDate(value?.to) ? value!.to : undefined,
    }
  }
  const y = now.getFullYear()
  const m = now.getMonth()
  const d = now.getDate()
  switch (preset) {
    case 'today':
      return { from: iso(new Date(y, m, d)), to: iso(new Date(y, m, d)) }
    case 'this_week': {
      // ISO week: Monday-start.
      const dow = (now.getDay() + 6) % 7
      return { from: iso(new Date(y, m, d - dow)), to: iso(new Date(y, m, d - dow + 6)) }
    }
    case 'this_month':
      return { from: iso(new Date(y, m, 1)), to: iso(new Date(y, m + 1, 0)) }
    case 'last_month':
      return { from: iso(new Date(y, m - 1, 1)), to: iso(new Date(y, m, 0)) }
    case 'this_quarter': {
      const q = Math.floor(m / 3) * 3
      return { from: iso(new Date(y, q, 1)), to: iso(new Date(y, q + 3, 0)) }
    }
    case 'this_year':
      return { from: iso(new Date(y, 0, 1)), to: iso(new Date(y, 11, 31)) }
    default:
      return {}
  }
}

// ── Row caps (FR-6.15) ──────────────────────────────────────────────────────

/** One screen's worth; the runner grid pages client-side over what it got. */
export const TABLE_ROW_CAP = 1000
export const XLSX_ROW_CAP = 50_000
export const PDF_ROW_CAP = 5_000

export function rowCapFor(output: ReportOutput): number {
  if (output === 'xlsx') return XLSX_ROW_CAP
  if (output === 'pdf') return PDF_ROW_CAP
  return TABLE_ROW_CAP
}

// ── Entry shape, validation and the access gate ─────────────────────────────

export interface ReportHandlerContext {
  orgId: string
  /** Validated + defaulted parameter values, keyed by `ParamDef.key`. */
  params: Record<string, any>
  /** Which surface asked — decides the row cap. */
  output: ReportOutput
  locale?: string
  /**
   * What the caller reads beyond the report's own gate, for a handler that reads a source with partitions of its own:
   * the purchases side (`bills`: incoming documents, and the bill behind a delivery, FR-26.6) and the cost figures
   * (`costs`: `products.costs`, FR-27.11) that are no column of the report, which `withoutFieldGroups` cannot drop.
   * A handler run with no caller (absent) reads everything.
   */
  sees?: { bills: boolean; costs: boolean }
}

export interface ReportEntry extends ReportMeta {
  /** Exact-match against the caller's JWT permissions (the legacy model). */
  permission: string
  /** Optional role allow-list, applied ON TOP of `permission` (the legacy model). */
  roles?: string[]
  /**
   * FR-27 (#529): the capability of what the report shows, which decides in an org on `roles`: the role's own, not
   * its projection's permissions, which may say less than the role. The legacy model keeps `permission` and `roles`.
   */
  cap: CapabilityId
  /** Absent for `view: 'custom'` entries — those are their own page. */
  handler?: (ctx: ReportHandlerContext) => Promise<ReportResult>
  /**
   * FR-27.11.C.1: a report that is ONLY a field group's figures (`inventory-valuation` is cost figures through and
   * through) is not offered to a role without the group, rather than shown with every value column dropped.
   */
  fieldGroup?: 'costs'
  /** Row → absolute, cross-SPA href of the source document (FR-6.10). */
  drilldown?: (row: Record<string, any>) => string | undefined
}

// ── Parameter helpers ───────────────────────────────────────────────────────

export class ReportParamError extends Error {
  constructor(message: string, readonly param?: string) {
    super(message)
    this.name = 'ReportParamError'
  }
}

/**
 * Coerce + validate the caller's raw params against the entry's `ParamDef[]`.
 * Unknown keys are DROPPED rather than passed through — a handler only ever sees what its
 * own definition declares, so no report can be steered by an injected filter.
 */
export function validateParams(entry: ReportEntry, raw: Record<string, any> | undefined): Record<string, any> {
  const input = raw && typeof raw === 'object' ? raw : {}
  const out: Record<string, any> = {}

  for (const def of entry.params) {
    const has = input[def.key] !== undefined && input[def.key] !== null && input[def.key] !== ''
    const value = has ? input[def.key] : def.default

    if (!has && def.required && def.default === undefined) {
      throw new ReportParamError(`Missing required parameter: ${def.key}`, def.key)
    }
    if (value === undefined || value === null || value === '') continue

    switch (def.type) {
      case 'period': {
        const period = (typeof value === 'object' ? value : {}) as PeriodValue
        // The server never trusts the client's date arithmetic — it re-resolves the preset.
        const { from, to } = resolvePeriod(period)
        if (from && to && from > to) {
          throw new ReportParamError(`Period start is after its end: ${from} > ${to}`, def.key)
        }
        if (def.required && (!from || !to)) {
          throw new ReportParamError(`Parameter ${def.key} requires a from/to range`, def.key)
        }
        out[def.key] = { preset: period.preset, from, to }
        break
      }
      case 'date': {
        if (!isIsoDate(value)) throw new ReportParamError(`Parameter ${def.key} must be YYYY-MM-DD`, def.key)
        out[def.key] = value
        break
      }
      case 'bool': {
        out[def.key] = value === true || value === 'true' || value === 1 || value === '1'
        break
      }
      case 'select': {
        const allowed = (def.options || []).map(o => o.value)
        if (allowed.length && !allowed.includes(String(value))) {
          throw new ReportParamError(`Parameter ${def.key} must be one of: ${allowed.join(', ')}`, def.key)
        }
        out[def.key] = String(value)
        break
      }
      case 'multiselect': {
        // Accepts an array or the comma-joined query-string form.
        const raw = Array.isArray(value) ? value : String(value).split(',')
        const list = raw.map(v => String(v).trim()).filter(Boolean)
        const allowed = (def.options || []).map(o => o.value)
        if (allowed.length) {
          const bad = list.filter(v => !allowed.includes(v))
          if (bad.length) {
            throw new ReportParamError(
              `Parameter ${def.key} has invalid value(s): ${bad.join(', ')}. Allowed: ${allowed.join(', ')}`,
              def.key,
            )
          }
        }
        // An empty selection means "no filter", same as omitting the param.
        if (list.length) out[def.key] = list
        break
      }
      // contact / warehouse / product / category are id references; text is free-form.
      default:
        out[def.key] = String(value)
    }
  }

  return out
}

// ── The gate (FR-6.7) ───────────────────────────────────────────────────────

export interface ReportCaller {
  permissions?: string[]
  role?: string
}

/** `true` when this caller may see AND run this report. One rule, three endpoints. */
export function canAccessReport(entry: ReportEntry, user: ReportCaller | null | undefined): boolean {
  if (!user) return false
  // Admin holds every module permission by construction; keep it explicit so a report whose
  // permission is not in an admin's set (there are none today) still resolves sensibly.
  const access = (user as any).access as Grant | undefined
  if (access) {
    // FR-27.5: an org on `roles`: what the report shows is the role's to read, or not.
    if (!grantCan(access, entry.cap)) return false
  } else {
    const perms = user.permissions || []
    if (!perms.includes(entry.permission) && user.role !== 'admin') return false
    if (entry.roles && !entry.roles.includes(user.role || '')) return false
  }
  if (entry.fieldGroup === 'costs' && !seesCosts(callerGrant(user))) return false
  return true
}

/** The caller's grant: its role's, live (an org on `roles`), else its claims compiled, as the server decides by. */
function callerGrant(user: ReportCaller): Grant {
  return ((user as any).access as Grant | undefined) ?? compileLegacy(user as any)
}

/**
 * FR-6.2: taking data OUT is a separate right from looking at it. A read-only `member` can
 * open a report and read it on screen but cannot download the workbook.
 *
 * Layered ON TOP of `canAccessReport` — never instead of it, so `reports.export` alone never
 * reveals a report whose module permission the caller lacks. Admin passes by construction
 * (`tokenize()` expands an admin permission set to every PERMISSION).
 */
export function canExportReport(entry: ReportEntry, user: ReportCaller | null | undefined): boolean {
  if (!canAccessReport(entry, user)) return false
  // FR-27: the capability, on the caller's grant. On the legacy model it is exactly the old rule (the admin role, or
  // the `reports.export` permission); in an org on `roles` the role's, not its projection's.
  return grantCan(callerGrant(user!), 'reports.export')
}

/** The serialisable projection — `permission`/`roles`/`handler` never cross the wire. */
export function toReportMeta(entry: ReportEntry): ReportMeta {
  const { id, category, labelKey, descriptionKey, icon, outputs, params, view, route, defaultExport } = entry
  return { id, category, labelKey, descriptionKey, icon, outputs, params, view, route, ...(defaultExport ? { defaultExport } : {}) }
}

/**
 * FR-27.6: the report without the columns of a field group the caller does not see: the column, every row's cell and
 * the total are gone (never blanked), and `meta.withheld` names the keys. Unchanged when nothing is withheld.
 */
export function withoutFieldGroups(result: ReportResult, sees: (group: NonNullable<ReportColumn['fieldGroup']>) => boolean): ReportResult {
  const hidden = new Set(result.columns.filter(c => c.fieldGroup && !sees(c.fieldGroup)).map(c => c.key))
  if (!hidden.size) return result
  const drop = (o: Record<string, any>) => Object.fromEntries(Object.entries(o).filter(([k]) => !hidden.has(k)))
  return {
    ...result,
    columns: result.columns.filter(c => !hidden.has(c.key)),
    rows: result.rows.map(drop),
    ...(result.totals ? { totals: drop(result.totals) as Record<string, number> } : {}),
    meta: { ...result.meta, withheld: [...hidden] } as any,
  }
}
