/**
 * FR-25: the accountant's books read straight out of a PlusMinus database dump (a nightly `archive\<yyyymmdd>.arz`), into the very
 * shapes `plusminus-exports.ts` builds from the GUI exports. No vendor server runs: the archive IS the database.
 *
 * **The dump** (pmserver's `main.Restore` and `createDefaultBaseOnFirstStart` both feed it to `fkb33.(*DB).GzToFkb`): gzip around a
 * pre-order walk of the database's key tree, one record per node, `[tag][depth][u32 LE length][length bytes]`. A name or a value is
 * CP1251 text; tag 0x28 marks an 8-byte float64 (amounts). The tag's low nibble is not read here, nor by the vendor's loader (a
 * template with every text tag rewritten still loads and signs in).
 *
 * **Proven 2026-11-05** on archive 20261105 against the GUI exports taken from the same database state an hour before it was written:
 * journal 2025 (27,442 documents) and 2026 (22,151), chart and openings of both years row for row in order, 16 analytic roots item
 * for item, every analytic opening of six trial balances. The only differences are the export's own damage, and the archive is the
 * better source in each: the export cuts text at 120 characters, breaks some Cyrillic letters into U+FFFD (the "31 broken analytic
 * names" of 11-05 are the export's, not the database's), and rounds numbers to 10 decimals (applied here too, so amounts are equal).
 *
 * ⚠ Personal data never leaves this module from here: the ПЕРСОНАЛ analytic root and each account's АНАЛИТ index (which lists
 * employees under 421/425) are skipped during the walk. Payroll is `scripts/lib/payroll-archive.ts`, sealed by its callers.
 */
import { createGunzip } from 'node:zlib'
import { parseAnalyticsFile, type AnalyticItem, type ParsedChartRow, type ParsedJournal } from './plusminus-exports.js'
import type { ImportDocument, ImportDocumentProps, ImportLink, ImportOperation, ImportSource, LedgerCurrency, OpeningAnalyticLine } from './import.types.js'
import { EUR_CHANGEOVER } from './registry.js'
import { localInstant } from '../local-day.js'

// ── the dump ─────────────────────────────────────────────────────────────────────────────────────

export interface DumpRecord { tag: number; depth: number; bytes: Buffer }
export const FLOAT64_TAG = 0x28

const cp1251 = new TextDecoder('windows-1251')
export const decode1251 = (b: Uint8Array) => cp1251.decode(b)

/** Every record of a gzip dump, in order. Rejects on a truncated stream or one that does not end on a whole record. */
export function walkDump(gz: Buffer, onRec: (r: DumpRecord) => void): Promise<{ records: number; bytes: number }> {
  return new Promise((ok, fail) => {
    let pend = Buffer.alloc(0), records = 0, bytes = 0
    const z = createGunzip()
    z.on('data', (chunk: Buffer) => {
      bytes += chunk.length
      pend = pend.length ? Buffer.concat([pend, chunk]) : chunk
      let o = 0
      while (pend.length - o >= 6) {
        const len = pend.readUInt32LE(o + 2)
        if (pend.length - o < 6 + len) break
        onRec({ tag: pend[o], depth: pend[o + 1], bytes: pend.subarray(o + 6, o + 6 + len) })
        records++
        o += 6 + len
      }
      pend = Buffer.from(pend.subarray(o)) // a copy: never pin a whole inflated chunk behind a short tail
    })
    z.on('end', () => (pend.length ? fail(new Error(`plusminus-archive: ${pend.length} bytes after the last whole record`)) : ok({ records, bytes })))
    z.on('error', fail)
    z.end(gz)
  })
}

/** Encodes records back into a dump (tests build synthetic archives with it). */
export function encodeRecords(records: { depth: number; text?: string; float?: number }[]): Buffer {
  const parts: Buffer[] = []
  for (const r of records) {
    const bytes = r.float !== undefined ? Buffer.alloc(8) : encode1251(r.text ?? '')
    if (r.float !== undefined) bytes.writeDoubleLE(r.float, 0)
    const h = Buffer.alloc(6)
    h[0] = r.float !== undefined ? FLOAT64_TAG : 0x10 | Math.min(bytes.length, 15)
    h[1] = r.depth
    h.writeUInt32LE(bytes.length, 2)
    parts.push(h, bytes)
  }
  return Buffer.concat(parts)
}

/** CP1251 for what a PlusMinus name or value holds: ASCII, Cyrillic, Ё/ё and №. */
export function encode1251(s: string): Buffer {
  const out = Buffer.alloc(s.length)
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c < 0x80) out[i] = c
    else if (c >= 0x410 && c <= 0x44f) out[i] = c - 0x410 + 0xc0
    else if (c === 0x401) out[i] = 0xa8
    else if (c === 0x451) out[i] = 0xb8
    else if (c === 0x2116) out[i] = 0xb9
    else throw new Error(`encode1251: U+${c.toString(16)} has no mapping here`)
  }
  return out
}

// ── one walk for the books ───────────────────────────────────────────────────────────────────────

export type FieldValue = string | number
/** One ОПЕРАЦИИ record: its first-level fields, each with its value (deeper structure, such as СКЛОПЕР lines, is not read). */
export interface RawRecord { date: string; seq: string; f: Record<string, FieldValue> }
/** A subtree kept in memory: a node's name, a float64 node's value, its children in dump order. A text value is a child's name. */
export interface TreeNode { name: string; value?: number; kids: TreeNode[] }

export interface ArchiveBooks {
  company: string
  /** The company's Булстат (ФИРМИ\<company>\ПАРАМЕТРИ): what the import checks against the org's ЕИК. */
  eik?: string
  /** ОПЕРАЦИИ records dated within the requested range (YYYYMMDD), in dump = booking order. */
  records: RawRecord[]
  /** The first and last ОПЕРАЦИИ dates in the whole dump (YYYYMMDD). */
  span: { first: string; last: string } | null
  /** СМЕТКОПЛАН\СМЕТКИ, without each account's operation index and analytic index. */
  accounts: TreeNode | null
  /** СМЕТКОПЛАН\АНАЛИТИЧНИ ПРИЗНАЦИ, without operation indexes and without the ПЕРСОНАЛ root. */
  analytics: TreeNode | null
}

/**
 * The one company in the dump: its operations dated within [from, to] (YYYYMMDD, inclusive), its chart, analytics and ЕИК.
 * Refuses a dump holding more than one company: the books PC keeps other companies' installs, and this must never read one.
 */
export async function readArchiveBooks(gz: Buffer, from: string, to: string): Promise<ArchiveBooks> {
  const companies = new Set<string>()
  const records: RawRecord[] = []
  let cur: RawRecord | null = null
  let root = '', company = '', table = '', date = '', field = '', eik: string | undefined, first = '', last = ''
  let stack: TreeNode[] = [], skipBelow = Infinity
  const out: { accounts: TreeNode | null; analytics: TreeNode | null } = { accounts: null, analytics: null }
  await walkDump(gz, r => {
    if (r.depth === 0) { root = decode1251(r.bytes); table = ''; return }
    if (root !== 'ФИРМИ') return
    if (r.depth === 1) { company = decode1251(r.bytes); table = ''; return }
    if (r.depth === 2) { table = decode1251(r.bytes); if (table === 'ОПЕРАЦИИ') companies.add(company); return }
    if (table === 'ПАРАМЕТРИ') {
      if (r.depth === 3) field = decode1251(r.bytes)
      else if (r.depth === 4 && field === 'Булстат' && eik === undefined) eik = decode1251(r.bytes).trim()
      return
    }
    if (table === 'ОПЕРАЦИИ') {
      if (r.depth === 3) { date = decode1251(r.bytes); if (!first || date < first) first = date; if (date > last) last = date; return }
      if (date < from || date > to) return
      if (r.depth === 4) { cur = { date, seq: decode1251(r.bytes), f: {} }; records.push(cur); return }
      if (r.depth === 5) { field = decode1251(r.bytes); return }
      if (r.depth === 6 && cur && !(field in cur.f)) cur.f[field] = r.tag === FLOAT64_TAG ? r.bytes.readDoubleLE(0) : decode1251(r.bytes)
      return
    }
    if (table !== 'СМЕТКОПЛАН') return
    if (r.depth >= skipBelow) return
    skipBelow = Infinity
    const name = r.tag === FLOAT64_TAG ? '' : decode1251(r.bytes)
    if (r.depth === 3) {
      const node: TreeNode = { name, kids: [] }
      if (name === 'СМЕТКИ') out.accounts = node
      else if (name === 'АНАЛИТИЧНИ ПРИЗНАЦИ') out.analytics = node
      else { skipBelow = 4; return }
      stack = [node]
      return
    }
    // Operation indexes: the journal comes from ОПЕРАЦИИ. Employees: the ПЕРСОНАЛ root, and each account's АНАЛИТ index.
    if (name === 'ОПЕРАЦИИ' ||
        (r.depth === 4 && name === 'ПЕРСОНАЛ' && stack[0]?.name === 'АНАЛИТИЧНИ ПРИЗНАЦИ') ||
        (r.depth === 5 && name === 'АНАЛИТ' && stack[0]?.name === 'СМЕТКИ')) { skipBelow = r.depth + 1; return }
    const parent = stack[r.depth - 4]
    if (!parent) return
    const node: TreeNode = { name, ...(r.tag === FLOAT64_TAG ? { value: r.bytes.readDoubleLE(0) } : {}), kids: [] }
    parent.kids.push(node)
    stack.length = r.depth - 3
    stack[r.depth - 3] = node
  })
  if (companies.size !== 1) throw new Error(`plusminus-archive: the dump holds ${companies.size} companies with operations; expected exactly one`)
  return { company: [...companies][0], eik, records, span: first ? { first, last } : null, ...out }
}

// ── numbers and text as the GUI export prints them ───────────────────────────────────────────────

/**
 * A number rounded to 10 decimals, as the export prints it: the database keeps float noise (`837.5699999999999`) and computed values
 * to full precision; the import has always been given `837.57`. `NaN` (PlusMinus's own "no rate") is blank.
 */
export function archiveNumber(v: FieldValue | undefined): number | undefined {
  if (v === undefined) return undefined
  let n: number
  if (typeof v === 'number') n = v
  else {
    const s = v.trim()
    if (!s || s === 'NaN') return undefined
    n = Number(s.replace(',', '.'))
    if (!Number.isFinite(n)) throw new Error(`plusminus-archive: "${s}" is not a number`)
  }
  return Number(n.toFixed(10))
}
const asText = (v: FieldValue | undefined) => (v === undefined ? '' : String(v).trim())
const iso = (d: string) => `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`

// ── a document's header, beyond what the export shows (FR-25a) ──────────────────────────────────

/** A number where one is optional: a value that is none is left out, never a reason to refuse the document. */
function optionalNumber(v: unknown): number | undefined {
  if (typeof v !== 'string' && typeof v !== 'number') return undefined
  try {
    return archiveNumber(v)
  } catch {
    return undefined
  }
}

/** A real calendar day, as YYYY-MM-DD; anything else is none. */
function calendarDay(year: string, month: string, day: string): string | undefined {
  const d = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)))
  return d.getUTCFullYear() === Number(year) && d.getUTCMonth() === Number(month) - 1 && d.getUTCDate() === Number(day) ? `${year}-${month}-${day}` : undefined
}

/** `DD.MM.YYYY` (how `taxEventDate` is written) as YYYY-MM-DD. */
function dottedDay(v: unknown): string | undefined {
  const m = /^(\d\d)\.(\d\d)\.(\d{4})$/.exec(String(v ?? '').trim())
  return m ? calendarDay(m[3], m[2], m[1]) : undefined
}

/** `YYYYMMDD` (how a link's `date` is written) as YYYY-MM-DD. */
function compactDay(v: unknown): string | undefined {
  const m = /^(\d{4})(\d\d)(\d\d)$/.exec(String(v ?? '').trim())
  return m ? calendarDay(m[1], m[2], m[3]) : undefined
}

/**
 * A PlusMinus stamp (`createdOn`, `modifiedOn`) as the instant it names, in ISO 8601. It is the accountant's wall clock
 * in Bulgaria: `YYYYMMDD:HHMMSS`, newer records followed by nine more digits of the second. Read off the whole journal:
 * every stamp has one of the two shapes, and the six digits after the colon are always a time of day (they are no
 * epoch, whatever the length suggests).
 */
function stampInstant(v: unknown): string | undefined {
  const m = /^(\d{4})(\d\d)(\d\d):(\d\d)(\d\d)(\d\d)(\d{0,9})$/.exec(String(v ?? '').trim())
  if (!m) return undefined
  const day = calendarDay(m[1], m[2], m[3])
  if (!day || Number(m[4]) > 23 || Number(m[5]) > 59 || Number(m[6]) > 59) return undefined
  return localInstant(day, Number(m[4]), Number(m[5]), Number(m[6]), m[7] ? Number(m[7].padEnd(3, '0').slice(0, 3)) : 0).toISOString()
}

/** A key the program names a switch by. Anything else (a dot, a `$`) is no key of a stored map. */
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/

/**
 * `links`: a JSON array of the documents this one is tied to, each `{ doc, docNumber, date?, partner, type, param,
 * value }`. `doc` is the other document's type; `param` names what `value` holds, `paid` (and `paid|paidCurrency`,
 * two values the same way): what the payment settles of the document. `partner` is this document's own partner, so
 * it is not kept. Unreadable: no links.
 */
function linksOf(v: FieldValue | undefined): ImportLink[] | undefined {
  let raw: unknown
  try {
    raw = JSON.parse(asText(v))
  } catch {
    return undefined
  }
  if (!Array.isArray(raw)) return undefined
  const out: ImportLink[] = []
  for (const l of raw) {
    if (!l || typeof l !== 'object') continue
    const docType = String((l as any).doc ?? '').trim()
    const docNumber = String((l as any).docNumber ?? '').trim()
    if (!docType || !docNumber) continue
    const link: ImportLink = { docType, docNumber }
    const date = compactDay((l as any).date)
    if (date) link.date = date
    const names = String((l as any).param ?? '').split('|')
    const values = String((l as any).value ?? '').split('|')
    names.forEach((name, i) => {
      const n = optionalNumber(values[i])
      if (n === undefined) return
      if (name === 'paid') link.amount = n
      else if (name === 'paidCurrency') link.amountFx = n
    })
    out.push(link)
  }
  return out.length ? out : undefined
}

/** `options`: a JSON map of ~35 switches. Kept: those set, and not to `false`, under a key that is an identifier. */
function optionsOf(v: FieldValue | undefined): Record<string, string> | undefined {
  let raw: unknown
  try {
    raw = JSON.parse(asText(v))
  } catch {
    return undefined
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(raw)) {
    if (!IDENTIFIER.test(key) || value === null || typeof value === 'object') continue
    const s = String(value).trim()
    if (s && s !== 'false') out[key] = s
  }
  return Object.keys(out).length ? out : undefined
}

/**
 * What a document's header record says beyond its type, number, total and comment: `ImportDocumentProps`, field by
 * field. What the file states about the same thing twice is read once (`ВИДПЛА` is `ПЛАЩАНЕ`, `VATPER` is `vatRate`,
 * `АВТОР` is `createdBy`); what restates the entry's own date or VAT (`docDate`, `ДАТА1` on an invoice, `ДДС`) is not
 * read; nor is what FR-25a defers (`docData`, `documentList`, the goods lines of `СКЛОПЕР`, …).
 */
export function propsOf(f: Record<string, FieldValue>): ImportDocumentProps | undefined {
  const p: ImportDocumentProps = {}
  const text = (key: string) => asText(f[key])
  const paymentCode = text('ПЛАЩАНЕ') || text('ВИДПЛА')
  if (paymentCode) p.paymentCode = paymentCode
  const paidAmount = optionalNumber(f['ПЛАТЕНО'])
  if (paidAmount !== undefined) p.paidAmount = paidAmount
  const paidCash = optionalNumber(f.paidCash)
  if (paidCash !== undefined) p.paidCash = paidCash
  const taxEventDate = dottedDay(f.taxEventDate)
  if (taxEventDate) p.taxEventDate = taxEventDate
  const vatRate = optionalNumber(f.vatRate ?? f.VATPER)
  if (vatRate !== undefined) p.vatRate = vatRate
  for (const [prop, key] of [
    ['vatRule', 'vatRules'], ['vatExemptionReason', 'ОНС'], ['registerDocType', 'ВИДДОК'], ['protocolType', 'protocolType'],
    ['reasonRef', 'ОСНИЗВ'], ['customsRef', 'НОММД'], ['bankOperation', 'operation'],
  ] as const) {
    if (text(key)) p[prop] = text(key)
  }
  // As booked, `YYYYMM`: the format of `Invoice.vatPeriod` and `VatRegisterEntry.period`, which it is for a VAT document.
  if (/^\d{4}(0[1-9]|1[0-2])$/.test(text('МЕСЕЦ'))) p.reportingMonth = text('МЕСЕЦ')
  // As booked, spaces and all, like an operation's analytic: it is looked up among the paths.
  const partner = f['ПАРТНЬОР'] === undefined ? '' : String(f['ПАРТНЬОР'])
  if (partner.trim()) p.partnerPath = partner
  const links = linksOf(f.links)
  if (links) p.links = links
  const options = optionsOf(f.options)
  if (options) p.docOptions = options
  const source: ImportSource = {}
  if (text('createdBy')) source.createdBy = text('createdBy')
  const createdAt = stampInstant(f.createdOn)
  if (createdAt) source.createdAt = createdAt
  if (text('modifiedBy')) source.modifiedBy = text('modifiedBy')
  const modifiedAt = stampInstant(f.modifiedOn)
  if (modifiedAt) source.modifiedAt = modifiedAt
  if (text('version')) source.version = text('version')
  if (Object.keys(source).length) p.source = source
  return Object.keys(p).length ? p : undefined
}

// ── the journal ──────────────────────────────────────────────────────────────────────────────────

/**
 * The journal of the records, grouped exactly as `parseJournalExport` groups the GUI export's rows (its rules, copied): a header
 * (a record with neither ДЕБИТ nor КРЕДИТ) starts a document; an operation joins it only when the document directly before it is its
 * own (same date, type, number); an operation with neither type nor number is a document of its own; any other is a document
 * "without header" (PlusMinus lost the header, the operation stayed).
 */
export function journalFromRecords(records: RawRecord[]): { documents: ImportDocument[]; counts: { documents: number; operations: number }; withoutHeader: ParsedJournal['withoutHeader'] } {
  const documents: ImportDocument[] = []
  const withoutHeader: ParsedJournal['withoutHeader'] = []
  let current: ImportDocument | null = null
  let docs = 0, ops = 0
  for (const rec of records) {
    const f = rec.f, date = iso(rec.date)
    const docType = asText(f['ДОКУМЕНТ']), docNumber = asText(f['ДОКУМ.No'])
    const d = asText(f['ДЕБИТ']), k = asText(f['КРЕДИТ'])
    if (!d && !k) {
      if (!docType && !docNumber) continue // nothing to book: the export has no row for it either
      docs++
      const total = archiveNumber(f['СУМА']), kind = asText(f['ТИП']), comment = asText(f['ТЕКСТ']), props = propsOf(f)
      current = { date, docType, docNumber, ...(kind ? { vatKind: kind } : {}), ...(total !== undefined ? { total } : {}), ...(comment ? { comment } : {}), ops: [], ...(props ? { props } : {}) }
      documents.push(current)
      continue
    }
    if (!d || !k) throw new Error(`plusminus-archive: ${rec.date}\\${rec.seq} is an operation with one account`)
    const op: ImportOperation = { d, k, amount: archiveNumber(f['СУМА']) ?? 0 }
    const ad = f['АНАЛДЕБ'] === undefined ? '' : String(f['АНАЛДЕБ']), ak = f['АНАЛКРЕ'] === undefined ? '' : String(f['АНАЛКРЕ'])
    if (ad.trim()) op.ad = ad
    if (ak.trim()) op.ak = ak
    const qty = archiveNumber(f['КОЛИЧЕСТВО']); if (qty !== undefined) op.qty = qty
    const cur = asText(f['ВАЛУТА']); if (cur) op.cur = cur
    const rate = archiveNumber(f['КУРС']); if (rate !== undefined) op.rate = rate
    const fx = archiveNumber(f['СУМАВАЛ']); if (fx !== undefined) op.fx = fx
    const comment = asText(f['ТЕКСТ']); if (comment) op.comment = comment
    const journal = asText(f['НОМЕР']); if (journal) op.journal = journal
    const tax = asText(f['ДАНЪК']); if (tax) op.tax = tax
    ops++
    if (!docType && !docNumber) { documents.push({ date, ops: [op] }); current = null; continue }
    if (!current || current.docType !== docType || current.docNumber !== docNumber || current.date !== date) {
      withoutHeader.push({ at: `archive ${rec.date}\\${rec.seq}`, date, docType, docNumber })
      current = { date, docType, docNumber, ops: [] }
      documents.push(current)
    }
    current.ops.push(op)
  }
  return { documents, counts: { documents: docs, operations: ops }, withoutHeader }
}

/** The currency a year was booked in: BGN before the changeover, EUR from it. */
export const currencyOfYear = (year: number): LedgerCurrency => (`${year}-01-01` < EUR_CHANGEOVER ? 'BGN' : 'EUR')

/**
 * A year's journal in `ParsedJournal`'s shape, ready for the import: the whole year when it is over, else up to `asOf` (YYYY-MM-DD,
 * the archive's day). The import replaces every month of `period`, so it never reaches past what the archive holds.
 */
export function journalOfYear(b: ArchiveBooks, year: number, asOf: string): ParsedJournal {
  const from = `${year}0101`, to = `${year}1231`
  const j = journalFromRecords(b.records.filter(r => r.date >= from && r.date <= to))
  const end = asOf < `${year}-12-31` ? asOf : `${year}-12-31`
  return {
    eik: b.eik,
    period: { from: `${year}-01-01`, to: end },
    currency: currencyOfYear(year),
    filters: [],
    documents: j.documents,
    counts: j.counts,
    declared: { ...j.counts },
    withoutHeader: j.withoutHeader,
  }
}

// ── the chart ────────────────────────────────────────────────────────────────────────────────────

const kid = (n: TreeNode | undefined, name: string) => n?.kids.find(k => k.name === name)
/** A field node's value: its first child (a float64 child carries `value`, a text one its name). */
const valueOf = (n: TreeNode | undefined): FieldValue | undefined => (n?.kids[0] ? (n.kids[0].value ?? n.kids[0].name) : undefined)

/** The chart as „Сметкоплан" exports it for `year`: every account in the database's order, its name and that year's stored opening. */
export function chartOfYear(accounts: TreeNode, year: number): ParsedChartRow[] {
  return accounts.kids.map(acc => {
    const y = kid(kid(kid(acc, 'САЛДА И ОБОРОТИ'), 'НАЧАЛНИ'), String(year))
    const bal = kid(y, 'НАЧАЛНО САЛДО'), turn = kid(y, 'НАЧАЛНИ ОБОРОТИ')
    return {
      // trimmed, as the export prints it: the database holds a junk "503 " beside 503, and the export shows it as a second 503
      code: acc.name.trim(),
      name: asText(valueOf(kid(acc, 'ИМЕ'))),
      openingDebit: archiveNumber(valueOf(kid(bal, 'ДЕБИТ'))) ?? 0,
      openingCredit: archiveNumber(valueOf(kid(bal, 'КРЕДИТ'))) ?? 0,
      openingTurnoverDebit: archiveNumber(valueOf(kid(turn, 'ДЕБИТ'))) ?? 0,
      openingTurnoverCredit: archiveNumber(valueOf(kid(turn, 'КРЕДИТ'))) ?? 0,
    }
  })
}

// ── the analytics ────────────────────────────────────────────────────────────────────────────────

/**
 * An analytic node's children that are its properties, not analytics under it. ВАЛУТИ is a foreign-currency bank account's
 * per-currency balances: its presence is exactly what `ap_*.json` writes as `"currency":"true"`.
 */
export const ANALYTIC_PROPS = new Set(['createdBy', 'createdOn', 'modifiedBy', 'modifiedOn', 'ПАРАМЕТРИ', 'САЛДА И ОБОРОТИ', 'ОПЕРАЦИИ', 'ВАЛУТИ'])

export interface ArchiveAnalyticNode {
  path: string
  group: boolean
  currency: boolean
  params: Record<string, string>
  /** The stored opening of each year it has one: debit, credit, and quantity where the root counts quantities. */
  openings: Record<string, { debit: number; credit: number; quantity?: number }>
}

/** Every analytic under every root, as `ROOT:group:…:item`, in dump order. Roots themselves are not listed. ПЕРСОНАЛ is never read. */
export function analyticNodes(tree: TreeNode): { root: string; nodes: ArchiveAnalyticNode[] }[] {
  return tree.kids.map(root => {
    const nodes: ArchiveAnalyticNode[] = []
    const visit = (n: TreeNode, path: string) => {
      for (const c of n.kids) {
        if (ANALYTIC_PROPS.has(c.name)) continue
        const p = `${path}:${c.name}`
        const params: Record<string, string> = {}
        // A number as the export prints it (10 decimals), not with the float noise the database keeps: FR-25a stores these.
        for (const pk of kid(c, 'ПАРАМЕТРИ')?.kids ?? []) {
          const v = valueOf(pk)
          params[pk.name] = typeof v === 'number' ? (Number.isFinite(v) ? String(archiveNumber(v)) : '') : asText(v)
        }
        const openings: ArchiveAnalyticNode['openings'] = {}
        for (const y of kid(kid(c, 'САЛДА И ОБОРОТИ'), 'НАЧАЛНИ')?.kids ?? []) {
          const bal = kid(y, 'НАЧАЛНО САЛДО'), q = archiveNumber(valueOf(kid(y, 'КОЛИЧЕСТВО')))
          openings[y.name] = { debit: archiveNumber(valueOf(kid(bal, 'ДЕБИТ'))) ?? 0, credit: archiveNumber(valueOf(kid(bal, 'КРЕДИТ'))) ?? 0, ...(q !== undefined ? { quantity: q } : {}) }
        }
        nodes.push({ path: p, group: c.kids.some(k => !ANALYTIC_PROPS.has(k.name)), currency: !!kid(c, 'ВАЛУТИ'), params, openings })
        visit(c, p)
      }
    }
    visit(root, root.name)
    return { root: root.name, nodes }
  })
}

/** A root's rows exactly as its `ap_<root>_<eik>.json` holds them (the root's own group row first), for a file or for the import. */
export function analyticsFileRows(root: string, nodes: ArchiveAnalyticNode[]): object[] {
  return [
    { ap: root, params: {}, group: 'true' },
    ...nodes.map(n => ({ ap: n.path, params: n.params, ...(n.group ? { group: 'true' } : {}), ...(n.currency ? { currency: 'true' } : {}) })),
  ]
}

/** The import's analytic items: the rows read by `parseAnalyticsFile` itself, so the two sources cannot drift apart. */
export function analyticItems(roots: { root: string; nodes: ArchiveAnalyticNode[] }[]): AnalyticItem[] {
  return roots.flatMap(r => parseAnalyticsFile(new TextEncoder().encode(JSON.stringify(analyticsFileRows(r.root, r.nodes)))))
}

/** A root's openings for `year`, booked to `account`, as `--opening-analytics <trial balance>=<account>` gives them. */
export function analyticOpenings(nodes: ArchiveAnalyticNode[], year: number, account: string): OpeningAnalyticLine[] {
  const out: OpeningAnalyticLine[] = []
  for (const n of nodes) {
    const o = n.openings[String(year)]
    if (!o || (!o.debit && !o.credit && !o.quantity)) continue
    out.push({ code: account, path: n.path, debit: o.debit, credit: o.credit, ...(o.quantity ? { quantity: o.quantity } : {}) })
  }
  return out
}
