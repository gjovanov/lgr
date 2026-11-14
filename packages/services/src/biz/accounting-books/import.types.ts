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

/** A document's link to another, as the file has it (FR-25a): an invoice and the bank document that paid it. */
export interface ImportLink {
  docType: string
  docNumber: string
  /** YYYY-MM-DD */
  date?: string
  /** What the link settles of the document (the file's `paid`), and the same in the document's currency. */
  amount?: number
  amountFx?: number
}

/** Who keyed the document in the accountant's program, and when (FR-25a). Instants are ISO 8601, in UTC. */
export interface ImportSource {
  createdBy?: string
  createdAt?: string
  modifiedBy?: string
  modifiedAt?: string
  /** The program's version stamp on the document, as written. */
  version?: string
}

/**
 * FR-25a: what a document's header says beyond its type, number, total and comment. Each field is set only when the
 * file states it, and a document the file says nothing more about has no `props` at all: an older client sends none,
 * and its documents hash exactly as they always did (`journal-plan.ts#contentOf`). The GUI journal export has none
 * of these columns; only the archive (`plusminus-archive.ts#journalFromRecords`) fills them.
 */
export interface ImportDocumentProps {
  /** `ПЛАЩАНЕ`, as booked: `registry.ts#PAYMENT_CODES`. */
  paymentCode?: string
  /** `ПЛАТЕНО`: what the document has been paid by so far. */
  paidAmount?: number
  /** `paidCash`: the cash part of it. */
  paidCash?: number
  /** `taxEventDate`, as YYYY-MM-DD. */
  taxEventDate?: string
  /** `vatRate`, in percent. */
  vatRate?: number
  /** `vatRules`: the VAT treatment in words. */
  vatRule?: string
  /** `ОНС`: why no VAT is charged. */
  vatExemptionReason?: string
  /** `ВИДДОК`: the NRA register's document-type code. */
  registerDocType?: string
  protocolType?: string
  /** `ОСНИЗВ`: what a credit or debit notice corrects. */
  reasonRef?: string
  /** `НОММД`: the customs declaration's reference. */
  customsRef?: string
  /** `operation`: a bank document's operation. */
  bankOperation?: string
  /** `МЕСЕЦ`, `YYYYMM` as booked: the month the document is reported in, when it is not its own. */
  reportingMonth?: string
  /** `ПАРТНЬОР`: the header's partner, an analytic path exactly as booked. */
  partnerPath?: string
  links?: ImportLink[]
  /** `options`: only the switches that are set, and not to `false`. Keys are identifiers. */
  docOptions?: Record<string, string>
  source?: ImportSource
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
  /** FR-25a: the rest of the header. Absent when it says nothing more. */
  props?: ImportDocumentProps
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
  /**
   * `deferred`, in a store keeping a share of the books (FR-25 R7) only: partners the store holds no
   * Contact for. Their Contact is made when one of the store's own entries names them.
   */
  contacts: { created: number; linked: number; withoutIdentifier: number; deferred?: number }
  bankAccounts: { created: number; linked: number; noLedgerAccount: number }
  /**
   * `linked`: `ДА` analytics linked to an asset kept in LGR; `unlinked`: the rest. The other four only where the org holds the
   * register (the home of a split, or a books org of its own) and the file carries the assets' properties (FR-25a §4.2): then
   * each `ДА` analytic is counted once, in `linked`, `unlinked`, `created`, `updated` or `unchanged`, and `problems` says why.
   */
  fixedAssets: { linked: number; unlinked: number } & Partial<FixedAssetRegisterCounts>
}

/** FR-25a §4.2: the fixed-asset register the books import keeps from the `ДА` analytics. */
export interface FixedAssetRegisterCounts {
  /** Assets the import made (a dry run: would make). */
  created: number
  /** Assets of the import's whose fields or link the books changed. */
  updated: number
  /** Assets of the import's as the books say. */
  unchanged: number
  /** What it could not take as booked, per analytic. Never a value of the file: a key, a reason, an account code. */
  problems: FixedAssetRegisterProblem[]
}

export interface FixedAssetRegisterProblem {
  /** The `ДА` analytic's path. */
  path: string
  /** The property, where one is the cause. */
  key?: string
  /**
   * The mapping's own (`fixed-asset-params.ts#FixedAssetProblemReason`), or the register's: `native_asset` (linked to an
   * asset kept in LGR, which the books never write), `native_namesake` (an asset kept in LGR has the name of one the
   * import made: the register may hold it twice), `code_taken`, `invalid`, `conflict` (another import made it since this
   * one read: the next finds it), `vanished` (the file no longer lists the analytic: the asset is left as it is).
   */
  reason: string
  /** `unknown_account`: the code the file names. */
  code?: string
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
   * account. Null when no previous year is imported, and in an org of a split: a share's closing is not
   * the company's (the group's continuity is the gate's and the nightly's, FR-25 R7).
   */
  continuity: { checked: number; equal: number; differing: string[] } | null
  /** Only in an org of a split (FR-25 R7): the home writes the opening; a member answers this and writes nothing. */
  split?: { role: SplitRole }
}

/** FR-25 R7: the org that holds the opening and everything no store's series names, or a store keeping its own sales. */
export type SplitRole = 'home' | 'member'

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
  /**
   * Only in an org of a split (FR-25 R7), where every count above is this org's share. `fileEntries` is
   * the whole month's: the shares of the group add up to it. `contacts` are the ones made (or that a dry
   * run would make) for partners this org's own entries name, and the ones found.
   */
  split?: { role: SplitRole; fileEntries: number; contacts: { created: number; linked: number } }
}

export interface FinishAnswer {
  dryRun: boolean
  accounts: number
  changed: number
}
