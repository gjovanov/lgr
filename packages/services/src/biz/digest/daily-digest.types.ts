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

// ── FR-13.6 backups ─────────────────────────────────────────────────────────

/**
 * Why there is no usable backup report. Each of these renders as a FAILURE, never as an
 * absent section: roomler's uploads backup has produced zero snapshots since it was
 * installed precisely because "no news" read as "no news" rather than as "no backups".
 */
export type DigestBackupGap = 'never_reported' | 'stale' | 'unreadable'

export interface DigestBackupCheck {
  check: string
  result: 'pass' | 'fail' | 'warn'
  detail: string
}

export interface DigestBackups {
  /** False whenever anything is wrong OR nothing is known. Absence is not health. */
  healthy: boolean
  gap?: DigestBackupGap
  /** When the verification that produced this report ran, and how long ago. */
  reportedAt?: string
  reportAgeHours?: number
  host?: string
  latestFull?: { artifact: string; bytes: number; ageHours: number }
  /** Generations retained per GFS tier (FR-13.8). */
  generations?: { daily: number; weekly: number; monthly: number; yearly: number }
  uploads?: { snapshots: number; files: number; ageHours: number }
  delta?: { slices: number; ageHours: number }
  /** Destinations the last off-site push actually reached. Empty means mars holds the only copy. */
  offsite?: { reached: string[]; ageHours: number }
  /** The last restore test — FR-13.5's whole point. A report with none has never proven itself. */
  lastRestore?: { result: 'pass' | 'fail'; at: string; collections?: number; seconds?: number }
  /** Only the checks that did NOT pass; a green run lists nothing. */
  failures: DigestBackupCheck[]
  checkCount: number
  /**
   * This org's own most recent Layer-2 bundle (FR-13.10–13.19).
   *
   * ⚠ Everything above describes Layer 1 — the cluster-wide dumps on mars, reported by
   * `verify-backups.sh`. That said nothing about whether THIS org's per-org bundle ran, so a
   * per-org backup could fail every night for a month and produce no visible signal
   * anywhere. FR-13.6's argument ("a job writing to a log nobody reads is indistinguishable
   * from no backup") applies to both layers; this carries the second one.
   *
   * Absent when the org has never had a Layer-2 run — which is normal, since the scheduler
   * is opt-in per org, and is rendered as "not enabled" rather than as a failure.
   */
  orgRun?: DigestOrgBackupRun
  /**
   * FR-13.37 — restores performed against this org on the reported day.
   *
   * Absent on every ordinary day, which is the overwhelming majority of them. Present is
   * itself the signal.
   */
  restores?: DigestRestore[]
}

export interface DigestOrgBackupRun {
  status: 'completed' | 'failed' | 'running'
  /** Org-local day the run was claimed under. */
  date: string
  kind: 'full' | 'delta'
  bytes?: number
  documentCount?: number
  sha256?: string
  /** Present on a failure — the message that stopped it. */
  reason?: string
  /** How many times today's run has been attempted, and the ceiling it stops at. */
  attempts?: number
  maxAttempts?: number
  /** Whether the mail carried the payload, and if not, why not. */
  emailed?: boolean
  emailSkippedReason?: string
  ageHours?: number
  /**
   * FR-13.59 — where this org's own bundle went.
   *
   * ⚠ An empty array means the bundle exists ONLY on the uploads PV, which is a node-local
   * hostPath on the same node as the live database. That is rendered as a gap, not as
   * silence: a backup that shares a disk with what it protects is the state FR-13 was written
   * to end, and the digest is the one place a human already looks.
   */
  destinations?: DigestBackupDestination[]
}

/**
 * FR-13.37 (#24) — one restore performed against this org on the reported day.
 *
 * ⚠ A writing restore takes the day off „всичко е наред" even when every backup is green, and
 * that is the point of carrying it here. Somebody with an allow-listed account reached into
 * live data: inserted documents, possibly deleted them, possibly across a tenant boundary. It
 * is not an error, and it must not read as a quiet line either — the people who did not
 * perform it are exactly the ones who need to see that it happened.
 */
export interface DigestRestore {
  mode: 'inspect' | 'merge' | 'replace'
  status: 'completed' | 'failed' | 'rolled_back' | 'running'
  /** Who did it. The scheduler never restores; a restore always has a human behind it. */
  actor?: string
  /** The day the restored bundle was taken — how far back live data was reached into. */
  bundleDate?: string
  documentsInserted: number
  documentsDeleted: number
  /** FR-13.35 — how many sequences the restore refused to move backwards. */
  sequenceClamps: number
  /** FR-13.37 — `DocFile` rows now pointing at bytes that are not on the volume. */
  danglingFileCount: number
  /** FR-13.32 — the bundle came from a different organisation and was rewritten onto this one. */
  remap: boolean
  error?: string
}

export interface DigestBackupDestination {
  name: string
  /** Only `reached` means an off-site copy exists. */
  status: 'reached' | 'failed' | 'skipped' | 'reconsent_required'
  reason?: string
  bytes?: number
  /** Whether the artifact was downloaded again and re-hashed. */
  verified?: boolean
  ageHours?: number
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
  backups?: Section<DigestBackups>
  /** True when every enabled section came back empty — the „всичко е наред" day. */
  allClear: boolean
}

export type DigestSectionKey =
  | 'kpis' | 'documents' | 'materials' | 'stock' | 'corrections'
  | 'undocumentedSales' | 'duplicates' | 'editedAfterIssue' | 'ops' | 'backups'

export const DIGEST_SECTION_KEYS: DigestSectionKey[] = [
  'kpis', 'documents', 'materials', 'stock', 'corrections',
  'undocumentedSales', 'duplicates', 'editedAfterIssue', 'ops', 'backups',
]

/**
 * Sections that are OFF unless the org explicitly enables them — the inverse of every other
 * section, which defaults ON (see the `dailyDigest.sections` schema comment).
 */
export const DIGEST_OPT_IN_SECTIONS: DigestSectionKey[] = ['backups']

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
