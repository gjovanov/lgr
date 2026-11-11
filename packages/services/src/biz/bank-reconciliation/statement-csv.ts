/**
 * #675 — a bank statement exported as CSV (or TSV), read into statement lines.
 *
 * Banks export differently, so the columns are found by their header, in Bulgarian, English or German:
 *   - a date: "Дата", "Вальор", "Date", "Value date", "Datum", "Buchungsdatum"…;
 *   - a description: "Описание", "Основание", "Description", "Details", "Verwendungszweck"…;
 *   - either one signed amount ("Сума", "Amount", "Betrag"), or a debit and a credit column ("Дебит"/"Кредит",
 *     "Debit"/"Credit", "Soll"/"Haben"): a credit to the account is money in (+), a debit money out (−);
 *   - optionally a reference ("Референция", "Reference").
 * The separator is the one the header line uses most (`;`, `,` or a tab); quotes are honoured. Amounts take a decimal
 * comma or point and any thousands separator ("1 234,56", "1.234,56", "1,234.56"); dates "dd.mm.yyyy", "dd/mm/yyyy",
 * "dd-mm-yyyy" or "yyyy-mm-dd", with or without a time.
 *
 * Import-pure: no I/O. A row it cannot read is reported by its line number, never guessed at.
 */

export interface StatementLine {
  /** The booking date, at UTC midnight. */
  date: Date
  description: string
  /** Signed: + money in, − money out. */
  amount: number
  bankReference?: string
}

export interface StatementParse {
  lines: StatementLine[]
  /** Rows that are not a statement line: their line number in the file and why. */
  unrecognized: Array<{ row: number; reason: string }>
  /** The header the columns were found in, or null when none was. */
  columns: Record<string, string> | null
}

const HEADERS: Record<'date' | 'description' | 'amount' | 'debit' | 'credit' | 'reference', string[]> = {
  date: ['дата', 'дата на операцията', 'дата на осчетоводяване', 'вальор', 'date', 'booking date', 'value date', 'transaction date', 'datum', 'buchungsdatum', 'valuta'],
  description: ['описание', 'основание', 'основание за плащане', 'информация', 'наредител/получател', 'description', 'details', 'narrative', 'text', 'payment details', 'beschreibung', 'verwendungszweck', 'buchungstext'],
  amount: ['сума', 'amount', 'betrag', 'износ'],
  debit: ['дебит', 'дт', 'debit', 'withdrawal', 'withdrawals', 'soll', 'изходящи'],
  credit: ['кредит', 'кт', 'credit', 'deposit', 'deposits', 'haben', 'входящи'],
  reference: ['референция', 'реф', 'reference', 'ref', 'ref.', 'reference no', 'referenz'],
}

const norm = (s: string) => s.replace(/^﻿/, '').trim().toLowerCase().replace(/\s+/g, ' ')

/** One CSV line into its cells, honouring quotes ("" is a quote inside one). */
function cells(line: string, sep: string): string[] {
  const out: string[] = []
  let cur = ''
  let quoted = false
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++ }
      else if (c === '"') quoted = false
      else cur += c
    } else if (c === '"') quoted = true
    else if (c === sep) { out.push(cur); cur = '' }
    else cur += c
  }
  out.push(cur)
  return out.map(c => c.trim())
}

function separatorOf(line: string): string {
  const counts = [';', ',', '\t'].map(s => [s, line.split(s).length - 1] as const)
  counts.sort((a, b) => b[1] - a[1])
  return counts[0][1] > 0 ? counts[0][0] : ';'
}

/** A header's column for one field: an exact name first, else a name it contains. */
function find(header: string[], names: string[], taken: Set<number>): number {
  const exact = header.findIndex((h, i) => !taken.has(i) && names.includes(h))
  if (exact >= 0) return exact
  return header.findIndex((h, i) => !taken.has(i) && names.some(n => n.length > 2 && h.includes(n)))
}

/** "1 234,56", "1.234,56", "1,234.56", "-12.5", "(12,50)": a number, or null. */
export function parseAmount(raw: string): number | null {
  let s = String(raw ?? '').replace(/[\s ']/g, '').replace(/[^\d,.\-()+]/g, '')
  if (!s) return null
  let negative = false
  if (/^\(.*\)$/.test(s)) { negative = true; s = s.slice(1, -1) }
  if (s.startsWith('-')) { negative = !negative; s = s.slice(1) }
  else if (s.startsWith('+')) s = s.slice(1)
  if (s.endsWith('-')) { negative = !negative; s = s.slice(0, -1) }
  const lastComma = s.lastIndexOf(',')
  const lastDot = s.lastIndexOf('.')
  if (lastComma >= 0 && lastDot >= 0) {
    // The later one is the decimal point; the other groups thousands.
    s = lastComma > lastDot ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '')
  } else if (lastComma >= 0) {
    // A comma alone: decimal when one comma with 1–2 digits after it, else thousands.
    s = (s.match(/,/g)!.length === 1 && /,\d{1,2}$/.test(s)) ? s.replace(',', '.') : s.replace(/,/g, '')
  } else if (lastDot >= 0 && (s.match(/\./g)!.length > 1)) {
    s = s.replace(/\./g, '')
  }
  if (!/^\d+(\.\d+)?$/.test(s)) return null
  const n = Number(s)
  return Number.isFinite(n) ? (negative ? -n : n) : null
}

/** "31.10.2026", "31/10/2026", "31-10-2026", "2026-10-31" (a time after it is ignored): UTC midnight, or null. */
export function parseStatementDate(raw: string): Date | null {
  const s = String(raw ?? '').trim()
  let y: number, m: number, d: number
  let match = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/)
  if (match) { y = +match[1]; m = +match[2]; d = +match[3] }
  else if ((match = s.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})/))) { d = +match[1]; m = +match[2]; y = +match[3] }
  else if ((match = s.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{2})\b/))) { d = +match[1]; m = +match[2]; y = 2000 + +match[3] }
  else return null
  if (m < 1 || m > 12 || d < 1 || d > 31) return null
  const date = new Date(Date.UTC(y, m - 1, d))
  return date.getUTCMonth() === m - 1 ? date : null
}

export function parseStatementCsv(text: string): StatementParse {
  const rows = String(text ?? '').split(/\r\n|\n|\r/)
  const unrecognized: StatementParse['unrecognized'] = []
  // The header: the first line naming a date column and an amount (or a debit and a credit).
  let headerAt = -1
  let sep = ';'
  let col: Record<string, number> = {}
  for (let i = 0; i < Math.min(rows.length, 30); i++) {
    if (!rows[i].trim()) continue
    const s = separatorOf(rows[i])
    const header = cells(rows[i], s).map(norm)
    const taken = new Set<number>()
    const pick = (k: keyof typeof HEADERS) => { const at = find(header, HEADERS[k], taken); if (at >= 0) taken.add(at); return at }
    const date = pick('date')
    const amount = pick('amount')
    const debit = amount < 0 ? pick('debit') : -1
    const credit = amount < 0 ? pick('credit') : -1
    if (date >= 0 && (amount >= 0 || (debit >= 0 && credit >= 0))) {
      headerAt = i
      sep = s
      col = { date, amount, debit, credit, description: pick('description'), reference: pick('reference') }
      break
    }
  }
  if (headerAt < 0) {
    return { lines: [], unrecognized: [{ row: 1, reason: 'no header with a date and an amount (or debit and credit) column' }], columns: null }
  }
  const header = cells(rows[headerAt], sep)
  const named = (i: number) => (i >= 0 ? header[i] : '')
  const lines: StatementLine[] = []
  for (let i = headerAt + 1; i < rows.length; i++) {
    if (!rows[i].trim()) continue
    const c = cells(rows[i], sep)
    const date = parseStatementDate(c[col.date] ?? '')
    if (!date) { unrecognized.push({ row: i + 1, reason: `no date in "${c[col.date] ?? ''}"` }); continue }
    let amount: number | null
    if (col.amount >= 0) amount = parseAmount(c[col.amount] ?? '')
    else {
      const debit = parseAmount(c[col.debit] ?? '') ?? 0
      const credit = parseAmount(c[col.credit] ?? '') ?? 0
      amount = (c[col.debit] ?? '').trim() || (c[col.credit] ?? '').trim() ? Math.abs(credit) - Math.abs(debit) : null
    }
    if (amount === null || amount === 0) { unrecognized.push({ row: i + 1, reason: 'no amount' }); continue }
    const description = (col.description >= 0 ? c[col.description] : '') || '—'
    const reference = col.reference >= 0 ? c[col.reference] : ''
    lines.push({ date, description, amount: Math.round(amount * 100) / 100, ...(reference ? { bankReference: reference } : {}) })
  }
  return {
    lines,
    unrecognized,
    columns: {
      date: named(col.date), description: named(col.description), amount: named(col.amount),
      debit: named(col.debit), credit: named(col.credit), reference: named(col.reference),
    },
  }
}
