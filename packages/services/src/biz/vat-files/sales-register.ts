import type { VatCells, VatRow } from './codec.js'

/**
 * FR-25 R3, the sales side of the VAT register derived from the documents themselves: what the
 * accountant types into PRODAGBI by hand today, one row per invoice, debit note and credit note a
 * branch issued (§1.5, §6.2). The same function serves the gate (`scripts/compare-sales-register.ts`)
 * and, later, the worker that posts forward, so what the gate proves is what will be posted.
 *
 * Import-pure: the caller loads the documents, their partner and their lines' product kinds.
 *
 * What a row is made of, as the 42 filed months show it (§7.1):
 *   - `01` invoice, `02` debit note, `03` credit note. A cash sale is no row of its own: the till's
 *     month is one `81` row per device, which this does not derive (§12, question 2).
 *   - the number is the document's ten digits, without LGR's display prefix (ЗДДС чл. 114);
 *   - the date is the business day in Sofia, at UTC midnight as the codec keeps it;
 *   - the partner is its VAT number where it has one, else its ЕИК (or a person's ЕГН);
 *   - base and VAT are the document's own: VAT is worked out once on the base, and a sum of the
 *     lines' rounded VAT can be a cent away from it, so the lines are never added up for it;
 *   - a credit note's values are negative, and a document annulled in its own period stays as a row
 *     with no values (Annex 12). One annulled in a later period keeps its values in its own; the row
 *     with the opposite sign belongs to the period of the annulment, which this does not derive yet.
 *     ⚠ LGR's date of a void is when LGR was told, which for a document annulled in PlusMinus can be
 *     weeks after the annulment: the gate then shows the row as differing, which it is.
 *
 * Only what has been proven is derived. In 42 filed months this company's invoices and notes carried
 * 20% and nothing else, so every other rate is refused with its reason rather than put in a cell
 * nobody has checked: a 0% line can be an intra-EU supply, an export or an exempt one, and the
 * document does not say which.
 */

export const REGISTER_DOC_TYPES: Record<string, string> = { invoice: '01', debit_note: '02', credit_note: '03' }

export interface RegisterLine {
  taxRate?: number
  /** Every line of a document on a service makes it `Услуги`. */
  service?: boolean
}

export interface RegisterDocument {
  type: string
  /** As LGR shows it, display prefix and all. */
  number: string
  issueDate: Date
  status: string
  /** When a `voided` document was voided, from its status history. */
  voidedAt?: Date
  currency?: string
  subtotal?: number
  discountTotal?: number
  taxTotal?: number
  total?: number
  lines?: RegisterLine[]
  partner?: { vatNumber?: string; taxId?: string; name?: string }
}

export type RegisterRefusal =
  | 'not_a_register_document'
  | 'not_issued'
  | 'number_not_ten_digits'
  | 'currency_not_eur'
  | 'rate_not_derived'
  | 'outside_the_period'

export type DerivedRow =
  | { row: Omit<VatRow, 'rowNo'> }
  | { refused: RegisterRefusal; detail?: string }

const SOFIA_DAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Sofia', year: 'numeric', month: '2-digit', day: '2-digit' })

/** The business day in Sofia, at UTC midnight, the way `codec.ts` keeps a document's date. */
export function sofiaDay(at: Date): Date {
  const [y, m, d] = SOFIA_DAY.format(at).split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d))
}

/** `YYYYMM` of the business day in Sofia. */
export function sofiaPeriod(at: Date): string {
  const day = sofiaDay(at)
  return `${day.getUTCFullYear()}${String(day.getUTCMonth() + 1).padStart(2, '0')}`
}

const cents = (v: unknown) => Math.round((Number(v) || 0) * 100)
const compact = (s: unknown) => String(s ?? '').replace(/\s+/g, '').toUpperCase()

/** The partner's id as the register carries it: the VAT number, else the ЕИК or ЕГН. */
export function registerPartnerId(partner: RegisterDocument['partner']): string {
  return compact(partner?.vatNumber) || compact(partner?.taxId)
}

/** The document's number as the register carries it: its last ten digits, or nothing. */
export function registerNumber(number: string): string | null {
  const m = /(\d{10})$/.exec(String(number ?? '').trim())
  return m ? m[1] : null
}

/** A document's row in the sales register of `period`, or why it has none there. */
export function salesRegisterRow(doc: RegisterDocument, period: string): DerivedRow {
  const docTypeCode = REGISTER_DOC_TYPES[doc.type]
  if (!docTypeCode) return { refused: 'not_a_register_document', detail: doc.type }
  if (doc.status === 'draft' || doc.status === 'cancelled') return { refused: 'not_issued', detail: doc.status }
  if (sofiaPeriod(doc.issueDate) !== period) return { refused: 'outside_the_period' }
  const docNumber = registerNumber(doc.number)
  if (!docNumber) return { refused: 'number_not_ten_digits' }
  if ((doc.currency || 'EUR') !== 'EUR') return { refused: 'currency_not_eur', detail: doc.currency }

  const lines = doc.lines ?? []
  const rates = [...new Set(lines.map(l => Number(l.taxRate ?? 0)))]
  if (rates.length !== 1 || rates[0] !== 20) return { refused: 'rate_not_derived', detail: rates.sort((a, b) => a - b).join(',') || 'no lines' }

  // Annex 12: a document annulled in its own period keeps its row, with its values blank.
  const annulledHere = doc.status === 'voided' && !!doc.voidedAt && sofiaPeriod(doc.voidedAt) === period

  const sign = docTypeCode === '03' ? -1 : 1
  const vat = cents(doc.taxTotal)
  // The document's base, after its discounts: what it charges VAT on.
  const base = cents(doc.total) - vat
  const cells: VatCells = {}
  if (!annulledHere) {
    if (base) { cells['02-10'] = sign * base; cells['02-11'] = sign * base }
    if (vat) { cells['02-20'] = sign * vat; cells['02-21'] = sign * vat }
  }
  return {
    row: {
      docTypeCode,
      docNumber,
      docDate: sofiaDay(doc.issueDate),
      partnerVat: registerPartnerId(doc.partner),
      partnerName: String(doc.partner?.name ?? '').trim(),
      description: lines.length && lines.every(l => l.service) ? 'Услуги' : 'Стоки',
      code: '',
      cells,
    },
  }
}

// ── the gate ────────────────────────────────────────────────────────────────────────────

export interface FiledSalesRow {
  docTypeCode: string
  docNumber: string
  docDate: Date
  partnerVat?: string
  cells: VatCells
}

export interface DerivedSalesRow {
  row: Omit<VatRow, 'rowNo'>
  /** Which branch issued it, by its code (`PZ`, `SF`). */
  branch: string
  /** Issued in LGR (no PlusMinus document behind it), or imported from PlusMinus. */
  origin: 'imported' | 'native'
}

export interface SeriesOwner {
  branch: string
  docSeries: readonly string[]
  /** A store of the same legal entity that sells outside LGR: the books hold its rows, LGR never will. */
  outsideLgr?: boolean
}

/** Field by field, what differs between a derived row and the filed one. Empty when they are equal. */
export function rowDifferences(derived: Omit<VatRow, 'rowNo'>, filed: FiledSalesRow): string[] {
  const out: string[] = []
  if (derived.docDate.getTime() !== new Date(filed.docDate).getTime()) out.push('date')
  if (compact(derived.partnerVat) !== compact(filed.partnerVat)) out.push('partner')
  const codes = new Set([...Object.keys(derived.cells), ...Object.keys(filed.cells)])
  const cellsDiffer = (c: string) => (derived.cells[c] ?? 0) !== (filed.cells[c] ?? 0)
  if (cellsDiffer('02-10') || cellsDiffer('02-11')) out.push('base')
  if (cellsDiffer('02-20') || cellsDiffer('02-21')) out.push('vat')
  if ([...codes].some(c => !['02-10', '02-11', '02-20', '02-21'].includes(c) && cellsDiffer(c))) out.push('other cells')
  return out
}

const rowKey = (docTypeCode: string, docNumber: string) => `${docTypeCode}:${String(docNumber).replace(/^0+/, '')}`

export interface RegisterComparison {
  /** Counts, keyed by what happened. No number, partner or amount. */
  counts: Record<string, number>
  /** One entry a row that is not equal, for the operator's private look. */
  details: { key: string; outcome: string; deltas?: Record<string, number> }[]
}

/**
 * The derived rows of a period against the filed ones: equal, differing (and in what), only
 * derived, or only filed. A filed row whose number is in a branch's series but that LGR does not
 * hold says so, apart from the rows of a store that sells outside LGR, which LGR never holds, and the
 * rows no series explains (a protocol, a till's month, a series nobody has named yet, §12).
 */
export function compareSalesRegister(derived: readonly DerivedSalesRow[], filed: readonly FiledSalesRow[], owners: readonly SeriesOwner[]): RegisterComparison {
  const counts: Record<string, number> = {}
  const details: RegisterComparison['details'] = []
  const bump = (k: string) => { counts[k] = (counts[k] ?? 0) + 1 }
  const filedByKey = new Map<string, FiledSalesRow[]>()
  for (const f of filed) {
    const k = rowKey(f.docTypeCode, f.docNumber)
    filedByKey.set(k, [...(filedByKey.get(k) ?? []), f])
  }
  const matched = new Set<string>()
  // One number, one document. While the stores issue in both systems, a document typed into LGR can
  // carry the number of one imported from PlusMinus (CLAUDE.md, the SALES_DOC counter): the import is
  // the one the register knows, and the other is counted apart rather than matched twice.
  const byKey = new Map<string, DerivedSalesRow[]>()
  for (const d of derived) {
    const k = rowKey(d.row.docTypeCode, d.row.docNumber)
    byKey.set(k, [...(byKey.get(k) ?? []), d])
  }
  const firsts: DerivedSalesRow[] = []
  for (const [, ds] of byKey) {
    const ordered = [...ds].sort((a, b) => (a.origin === b.origin ? 0 : a.origin === 'imported' ? -1 : 1))
    firsts.push(ordered[0])
    for (const extra of ordered.slice(1)) bump(`${extra.branch} ${extra.origin}: another LGR document carries the same number`)
  }
  for (const d of firsts) {
    const k = rowKey(d.row.docTypeCode, d.row.docNumber)
    const rows = filedByKey.get(k)
    const who = `${d.branch} ${d.origin}`
    if (!rows) { bump(`${who}: in LGR, not filed`); details.push({ key: k, outcome: `${who}: in LGR, not filed` }); continue }
    if (rows.length > 1) bump(`${who}: filed more than once`)
    matched.add(k)
    const diff = rowDifferences(d.row, rows[0])
    if (!diff.length) { bump(`${who}: equal`); continue }
    const outcome = `${who}: differs in ${diff.join(' + ')}`
    bump(outcome)
    details.push({
      key: k, outcome,
      deltas: {
        base: (d.row.cells['02-10'] ?? 0) - (rows[0].cells['02-10'] ?? 0),
        vat: (d.row.cells['02-20'] ?? 0) - (rows[0].cells['02-20'] ?? 0),
      },
    })
  }
  for (const [k, rows] of filedByKey) {
    if (matched.has(k)) continue
    const n = rows[0].docNumber
    const owner = /^\d{10}$/.test(n) ? owners.find(o => o.docSeries.some(s => n.startsWith(s))) : undefined
    const outcome = owner
      ? `filed ${rows[0].docTypeCode}, ${owner.branch}'s series: ${owner.outsideLgr ? 'a store outside LGR' : 'not in LGR'}`
      : `filed ${rows[0].docTypeCode}, no branch's series${/^\d{10}$/.test(n) ? '' : ` (a ${n.length}-character number)`}`
    bump(outcome)
    details.push({ key: k, outcome })
  }
  return { counts, details }
}
