/**
 * FR-25 §5: what the import endpoints take and answer, shared by the CLI and the server.
 * Import-pure, like the parsers that produce it.
 */
import type { AnalyticItem } from './plusminus-exports.js'

export type LedgerCurrency = 'BGN' | 'EUR'

/** One operation: two lines of one entry, with one `opNo`. Negative amounts stay negative. */
export interface ImportOperation {
  /** Debit and credit account codes. */
  d: string
  k: string
  /** Analytic paths, as booked. */
  ad?: string
  ak?: string
  qty?: number
  amount: number
  /** The currency the operation was made in, when it says one, its rate and its amount there. */
  cur?: string
  rate?: number
  fx?: number
  comment?: string
  /** `Журнал` (`Номер` in older exports). */
  journal?: string
  /** `Данък`. */
  tax?: string
}

/** A document with its operations, or one operation with no document. */
export interface ImportDocument {
  /** YYYY-MM-DD */
  date: string
  docType?: string
  docNumber?: string
  vatKind?: string
  /** The header row's `Сума`: gross, and not the sum of its operations. */
  total?: number
  comment?: string
  ops: ImportOperation[]
}

interface SourceFile {
  /** The company the file says it is about: it must be the org's. */
  eik: string
}

export interface ChartBody extends SourceFile {
  dryRun?: boolean
  accounts: { code: string; name: string }[]
}

export interface ChartAnswer {
  dryRun: boolean
  created: number
  updated: number
  unchanged: number
  /** Rows dropped, and why: reported, never silent (FR-25 §5.1). Their codes, which are no one's data. */
  junk: { code: string; reason: string }[]
}

export interface AnalyticsBody extends SourceFile {
  dryRun?: boolean
  items: AnalyticItem[]
}

export interface AnalyticsAnswer {
  dryRun: boolean
  created: number
  updated: number
  unchanged: number
  byRoot: Record<string, number>
  contacts: { created: number; linked: number; withoutIdentifier: number }
  bankAccounts: { created: number; linked: number; noLedgerAccount: number }
  fixedAssets: { linked: number; unlinked: number }
}

export interface OpeningLine {
  code: string
  debit: number
  credit: number
}

export interface OpeningAnalyticLine extends OpeningLine {
  path: string
  /** The opening quantity: signed, and on neither side. */
  quantity?: number
}

export interface OpeningBody extends SourceFile {
  dryRun?: boolean
  year: number
  accounts: OpeningLine[]
  analytics?: OpeningAnalyticLine[]
}

export interface OpeningAnswer {
  dryRun: boolean
  year: number
  currency: LedgerCurrency
  /** `new`, `changed` or `unchanged`: there is one opening entry a year. */
  outcome: 'new' | 'changed' | 'unchanged'
  lines: number
  balanced: boolean
  /** Accounts whose analytics do not add up to their balance: the rest sits on the account itself. */
  accountsWithRemainder: string[]
  /** On a dry run: accounts the chart does not hold yet. A real run refuses them. */
  unknownAccounts: string[]
  analyticsToCreate: number
  /**
   * The previous year's closing, at the rate where the currency changed, against this opening, per
   * account. Null when no previous year is imported.
   */
  continuity: { checked: number; equal: number; differing: string[] } | null
}

export interface JournalBody extends SourceFile {
  dryRun?: boolean
  /** YYYY-MM: one request replaces one month. */
  month: string
  /** What the file covers: an imported entry of this month outside it cannot be judged gone. */
  coverage: { from: string; to: string }
  documents: ImportDocument[]
}

export interface MonthDiff {
  new: number
  changed: number
  gone: number
  unchanged: number
}

export interface JournalAnswer extends MonthDiff {
  dryRun: boolean
  month: string
  batchId?: string
  currency: LedgerCurrency
  /** Entries this month's file makes: its documents, and its operations with no document. */
  entries: number
  documents: number
  operations: number
  /** The entries that balance. Always all of them; the count is what proves it. */
  balanced: number
  settles: number
  analyticsToCreate: number
  fiscalPeriod: 'exists' | 'would_create' | 'created'
  byDocType: Record<string, MonthDiff>
  unknownDocTypes: { docType: string; count: number }[]
  /** On a dry run: accounts the chart does not hold yet. A real run refuses them. */
  unknownAccounts: string[]
}

export interface FinishAnswer {
  dryRun: boolean
  accounts: number
  changed: number
}
