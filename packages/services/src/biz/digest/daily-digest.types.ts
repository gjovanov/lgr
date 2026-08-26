/**
 * FR-11 (#21) — the daily digest's data shape.
 *
 * Import-pure: no models, no mongoose. The renderer and the tests import this; the builder
 * (`daily-digest.service.ts`) is the only server-only half. Same split as
 * `report-registry.types.ts` vs `report-registry.ts`, for the same reason.
 */

/** Every section carries its own failure, so one broken query cannot kill the digest. */
export interface SectionError {
  failed: true
  message: string
}

export type Section<T> = T | SectionError

export function isSectionError(s: unknown): s is SectionError {
  return !!s && typeof s === 'object' && (s as any).failed === true
}

// ── FR-11.7 KPIs ────────────────────────────────────────────────────────────

export interface DigestKpis {
  currency: string
  /** Outgoing invoice/credit/debit note family. */
  salesCount: number
  salesTotal: number
  /** cash_sale documents. */
  cashCount: number
  cashTotal: number
  /** Incoming bills (SHOULD sub-block). */
  purchaseCount: number
  purchaseTotal: number
  /** Payments recorded on the day, from `payments[].date`. */
  paymentsCount: number
  paymentsTotal: number
  /** Register split by effective payment method (cash / card / other). */
  byMethod: { method: string; amount: number; count: number }[]
  /** True when the day's documents span several currencies — totals are then per-doc sums. */
  mixedCurrency: boolean
}

// ── FR-11.7a document register + FR-11.7b sequences ─────────────────────────

export interface DigestDocumentRow {
  id: string
  number: string
  type: string
  contactName: string
  total: number
  currency: string
  status: string
  paymentMethod?: string
}

export interface DigestSequenceLine {
  /** Counter key, e.g. SALES_DOC — for tests and debugging, not for display. */
  key: string
  /** Display prefix resolved through the registry. NEVER hardcoded. */
  prefix: string
  min?: string
  max?: string
  count: number
  /** Numbers inside the day's range with no surviving document — the „липсваща разписка" class. */
  missing: string[]
  /** Set when the day's max suffix disagrees with the counter's `lastNumber`. */
  lastNumberMismatch?: { dayMax: number; counter: number }
  /** Last issued number, for the „no documents today" line. */
  lastNumber?: number
}

export interface DigestDocumentFamily {
  key: string
  rows: DigestDocumentRow[]
  /** Rows beyond the cap. */
  more: number
  total: number
  count: number
  sequence?: DigestSequenceLine
}

export interface DigestDocuments {
  sales: DigestDocumentFamily
  cash: DigestDocumentFamily
  purchases: { count: number; total: number }
}

// ── FR-11.7c materials ──────────────────────────────────────────────────────

export interface DigestMaterialRow {
  productId: string
  sku: string
  name: string
  unit: string
  quantity: number
  value: number
}

export interface DigestMaterialBlock {
  rows: DigestMaterialRow[]
  more: number
  /** Σ value. Σ quantity across products is meaningless — row count is the honest companion. */
  totalValue: number
  rowCount: number
}

export interface DigestMaterials {
  sold: DigestMaterialBlock
  transferred: DigestMaterialBlock
  loaded: DigestMaterialBlock
}

// ── Anomaly sections ────────────────────────────────────────────────────────

export interface DigestStockRow {
  productId: string
  sku: string
  name: string
  warehouseName: string
  quantity: number
}

export interface DigestStock {
  rows: DigestStockRow[]
  more: number
  count: number
}

export interface DigestCorrectionRow {
  id: string
  movementNumber: string
  /** Корекция / Отписване / Ръчна корекция, derived from the notes marker. */
  kind: 'correction' | 'writeOff' | 'manual'
  lineCount: number
  /** Signed: `fromWarehouseId ⇒ −|qty|`. */
  quantity: number
  value: number
}

export interface DigestCorrections {
  rows: DigestCorrectionRow[]
  more: number
  count: number
}

export interface DigestUndocumentedRow {
  id: string
  number: string
  type: string
  total: number
  /** Import-born rows render muted — intentionally movement-free, not an alarm. */
  imported: boolean
}

export interface DigestUndocumented {
  rows: DigestUndocumentedRow[]
  more: number
  count: number
  importedCount: number
}

export interface DigestDuplicateRow {
  productId: string
  name: string
  quantity: number
  occurrences: number
  documents: string[]
}

export interface DigestDuplicates {
  rows: DigestDuplicateRow[]
  more: number
  count: number
}

export interface DigestEditedRow {
  entityName: string
  action: string
  changeCount: number
  userName: string
  at: string
}

export interface DigestEdited {
  rows: DigestEditedRow[]
  more: number
  count: number
}

export interface DigestOps {
  tasks: { type: string; completed: number; failed: number; created: number; failedRows: number }[]
  failedEmails: { to: string; subject: string; error: string }[]
  failedEmailCount: number
}

// ── The whole thing ─────────────────────────────────────────────────────────

export interface DailyDigestData {
  orgId: string
  orgName: string
  /** Org-local `YYYY-MM-DD` the digest covers (yesterday, at send time). */
  date: string
  locale: string
  timezone: string
  generatedAt: string
  kpis?: Section<DigestKpis>
  documents?: Section<DigestDocuments>
  materials?: Section<DigestMaterials>
  stock?: Section<DigestStock>
  corrections?: Section<DigestCorrections>
  undocumentedSales?: Section<DigestUndocumented>
  duplicates?: Section<DigestDuplicates>
  editedAfterIssue?: Section<DigestEdited>
  ops?: Section<DigestOps>
  /** True when every enabled section came back empty — the „всичко е наред" day. */
  allClear: boolean
}

export type DigestSectionKey =
  | 'kpis' | 'documents' | 'materials' | 'stock' | 'corrections'
  | 'undocumentedSales' | 'duplicates' | 'editedAfterIssue' | 'ops'

export const DIGEST_SECTION_KEYS: DigestSectionKey[] = [
  'kpis', 'documents', 'materials', 'stock', 'corrections',
  'undocumentedSales', 'duplicates', 'editedAfterIssue', 'ops',
]

/** Row caps. The digest is a pointer to the grids, not an export (edge case 6). */
export const DIGEST_CAPS = {
  documents: 100,
  materials: 30,
  stock: 30,
  corrections: 30,
  undocumented: 30,
  duplicates: 20,
  edited: 30,
  emails: 10,
} as const
