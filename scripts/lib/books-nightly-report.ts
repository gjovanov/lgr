/**
 * What the unattended books run (`.claude/skills/pull-plusminus-books/nightly.ts`) reads out of
 * `import-accounting-books.ts`: the importer prints one JSON line a step (`chart: {…}`, `analytics: {…}`,
 * `opening 2026: {…}`, `journal 2026-01: {…}`, `journal total: {…}`, `finish: {…}`), and the run decides from
 * those alone whether anything changed and whether it has to stop. Also how it asks whether its docs root answers at
 * all, when a docs root that does not answer is worth a mail, and which documents an import changed.
 */
import { gunzipSync, gzipSync } from 'node:zlib'
import { documentsByMonth } from '../../packages/services/src/biz/accounting-books/plusminus-exports.js'
import { headerContentOf, planMonth, sha256 } from '../../packages/services/src/biz/accounting-books/journal-plan.js'
import { exchangeRateOf, ledgerCurrencyOn } from '../../packages/services/src/biz/accounting-books/registry.js'
import type { ImportDocument, ImportOperation, OpeningLine } from '../../packages/services/src/biz/accounting-books/import.types.js'

export interface ParsedImport {
  steps: Record<string, any>
  months: any[]
}

export interface YearResult {
  year: number
  changes: number
  text: string
}

export function parseImport(out: string): ParsedImport {
  const steps: Record<string, any> = {}
  const months: any[] = []
  for (const line of out.split(/\r?\n/)) {
    const m = /^(chart|analytics|finish|journal total|opening \d{4}|journal \d{4}-\d{2}): (\{.*\})$/.exec(line)
    if (!m) continue
    if (/^journal \d/.test(m[1])) months.push(JSON.parse(m[2]))
    else steps[m[1].startsWith('opening') ? 'opening' : m[1]] = JSON.parse(m[2])
  }
  return { steps, months }
}

/** What a run has to stop on. A step with no line counts: the importer stopped before it. */
export function problems(r: ParsedImport): string[] {
  const out = ['chart', 'analytics', 'opening', 'journal total', 'finish'].filter(s => !r.steps[s]).map(s => `the import printed no ${s} line`)
  for (const m of r.months) {
    if (m.balanced !== m.entries) out.push(`${m.month}: ${m.entries - m.balanced} entries not balanced`)
    if (m.unknownDocTypes?.length) out.push(`${m.month}: ${m.unknownDocTypes.length} unknown document types`)
    if (m.unknownAccounts?.length) out.push(`${m.month}: ${m.unknownAccounts.length} unknown accounts`)
  }
  const o = r.steps.opening
  if (o?.balanced === false) out.push('opening: not balanced')
  if (o?.unknownAccounts?.length) out.push(`opening: ${o.unknownAccounts.length} unknown accounts`)
  if (o?.continuity?.differing?.length) out.push(`opening: continuity differs on ${o.continuity.differing.length} accounts`)
  return out
}

/** Counts only: the mail and the log carry no name and no amount. */
export function summarize(year: number, r: ParsedImport): YearResult {
  const { chart: c = {}, analytics: a = {}, opening: o = {}, finish: f = {} } = r.steps
  const j = r.steps['journal total'] ?? {}
  const changes = (c.created ?? 0) + (c.updated ?? 0) + (a.created ?? 0) + (a.updated ?? 0) + (a.contacts?.created ?? 0)
    + (o.outcome && o.outcome !== 'unchanged' ? 1 : 0) + (j.new ?? 0) + (j.changed ?? 0) + (j.gone ?? 0) + (f.changed ?? 0)
  const text = `${year}: journal ${j.new ?? 0} new, ${j.changed ?? 0} changed, ${j.gone ?? 0} gone (${j.entries ?? 0} entries)`
    + ` · opening ${o.outcome ?? '?'} · chart ${(c.created ?? 0) + (c.updated ?? 0)} · analytics ${(a.created ?? 0) + (a.updated ?? 0)}`
    + `, contacts ${a.contacts?.created ?? 0} · finish ${f.changed ?? 0} accounts`
  return { year, changes, text }
}

// ── Several orgs: books split over a group (FR-25 R7) ───────────────────────────────────────────────

/**
 * The orgs a run imports: `BOOKS_NIGHTLY_ORGS` (comma-separated, every org of a split), else the one
 * `BOOKS_NIGHTLY_ORG`. One org is the run as it always was.
 */
export function orgsOf(list: string | undefined, single: string): string[] {
  const named = [...new Set(String(list ?? '').split(',').map(s => s.trim()).filter(Boolean))]
  return named.length ? named : [single]
}

/** One org's import of a year, as the run read it. */
export interface OrgImport {
  org: string
  parsed: ParsedImport
}

/** Counts add up, an outcome is the one that is not `unchanged`, a flag holds if it holds everywhere. */
function addUp(values: unknown[]): unknown {
  const present = values.filter(v => v !== undefined && v !== null)
  if (!present.length) return values.includes(null) ? null : undefined
  if (present.every(v => typeof v === 'number')) return (present as number[]).reduce((a, b) => a + b, 0)
  if (present.every(v => typeof v === 'boolean')) return present.every(Boolean)
  if (present.every(v => typeof v === 'string')) return present.find(v => v !== 'unchanged') ?? present[0]
  if (present.every(Array.isArray)) return (present as unknown[][]).flat()
  if (present.every(v => typeof v === 'object')) {
    const keys = [...new Set(present.flatMap(v => Object.keys(v as object)))]
    return Object.fromEntries(keys.map(k => [k, addUp(present.map(v => (v as Record<string, unknown>)[k]))]))
  }
  return present[0]
}

/** The orgs' imports of one year as one: each step's counts added up, the months side by side. */
export function sumImports(parts: readonly ParsedImport[]): ParsedImport {
  const names = [...new Set(parts.flatMap(p => Object.keys(p.steps)))]
  return {
    steps: Object.fromEntries(names.map(name => [name, addUp(parts.map(p => p.steps[name]))])),
    months: parts.flatMap(p => p.months),
  }
}

/**
 * A year over the orgs it was imported into. One org reads exactly as it always has; several read as
 * their sum, then a line each. The documents behind the counts are the archive's, listed once.
 */
export function summarizeOrgs(year: number, imports: readonly OrgImport[]): YearResult {
  if (imports.length === 1) return summarize(year, imports[0].parsed)
  const each = imports.map(i => ({ org: i.org, result: summarize(year, i.parsed) }))
  const whole = summarize(year, sumImports(imports.map(i => i.parsed)))
  return {
    year,
    changes: each.reduce((n, e) => n + e.result.changes, 0),
    text: [whole.text, ...each.map(e => `  ${e.org}: ${e.result.text.slice(`${year}: `.length)}`)].join('\n'),
  }
}

/** Whether an import was into an org of a split: its journal says how many entries the whole file makes. */
export const isSplitImport = (r: ParsedImport) => typeof r.steps['journal total']?.fileEntries === 'number'

/**
 * What a split must hold as a group, which no one org can see (FR-25 R7): every org was sent the same
 * file, and the shares add up to it, no entry held twice and none by nobody. A group configured with
 * different stores in different orgs, or one org of it left out of the run, fails here.
 */
export function splitProblems(year: number, imports: readonly OrgImport[]): string[] {
  const split = imports.filter(i => isSplitImport(i.parsed))
  if (!split.length) return []
  const out: string[] = []
  if (split.length !== imports.length) out.push(`${year}: ${imports.length - split.length} of the orgs keep books of their own, beside a split`)
  const files = [...new Set(split.map(i => i.parsed.steps['journal total'].fileEntries as number))]
  if (files.length > 1) out.push(`${year}: the orgs were sent files of different sizes (${files.join(', ')} entries)`)
  const held = split.reduce((n, i) => n + (i.parsed.steps['journal total'].entries ?? 0), 0)
  if (files.length === 1 && held !== files[0]) out.push(`${year}: the orgs hold ${held} entries of the file's ${files[0]}: every org of the split must be in BOOKS_NIGHTLY_ORGS, with the same stores`)
  const homes = split.filter(i => i.parsed.steps.opening?.split?.role === 'home').length
  if (homes !== 1) out.push(`${year}: ${homes} orgs answered as the split's home, not one`)
  return out
}

/** A year's openings per account, signed: debit positive. */
const netOf = (lines: readonly OpeningLine[]) => {
  const out = new Map<string, number>()
  for (const l of lines) out.set(l.code, (out.get(l.code) ?? 0) + l.debit - l.credit)
  return out
}

/**
 * §5.3's continuity for a split, from the archive alone: the year before's opening plus its journal is its
 * closing, which at the rate where the currency changed must be this year's opening, per account. The
 * server checks the same against what it imported, but only a books org of its own can: a share's closing
 * is not the company's. The import is proven equal to the file by its dry rerun, so the file stands in.
 * Account numbers only.
 */
export function continuityOfFiles(year: number, before: { opening: readonly OpeningLine[]; documents: readonly ImportDocument[] }, opening: readonly OpeningLine[]) {
  const closing = netOf(before.opening)
  for (const doc of before.documents) {
    for (const op of doc.ops) {
      closing.set(op.d, (closing.get(op.d) ?? 0) + op.amount)
      closing.set(op.k, (closing.get(op.k) ?? 0) - op.amount)
    }
  }
  const rate = ledgerCurrencyOn(`${year - 1}-12-31`) === ledgerCurrencyOn(`${year}-01-01`) ? 1 : exchangeRateOf('BGN')
  const next = netOf(opening)
  const differing: string[] = []
  let equal = 0
  for (const code of new Set([...closing.keys(), ...next.keys()])) {
    if (Math.abs((closing.get(code) ?? 0) * rate - (next.get(code) ?? 0)) < 0.011) equal++
    else differing.push(code)
  }
  return { checked: equal + differing.length, equal, differing: differing.sort() }
}

/**
 * Whether `dir` lists within `ms`, asked of a child process. A WSL share whose distro is stuck does not fail a read, it
 * HANGS it (2026-11-05, 22:52 to 23:00 UTC: every `wsl -d` answered E_UNEXPECTED, and an `ls` of the share sat there for
 * minutes). Read in the run's own process, that would hang the run with it; a child is killed instead.
 *
 * `cmd` is for the test of the kill: a child that never answers stands in for the hung share (#569). A 0 ms deadline
 * on a real listing was a race the child sometimes won.
 */
export async function listsWithin(
  dir: string,
  ms: number,
  cmd: string[] = [process.execPath, '-e', `require('node:fs').readdirSync(${JSON.stringify(dir)})`],
): Promise<boolean> {
  const child = Bun.spawn(cmd, { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' })
  const timer = setTimeout(() => child.kill(), ms)
  const code = await child.exited
  clearTimeout(timer)
  return code === 0
}

/** Since when the docs root has not answered. Kept on the PC, not on the share: the share cannot say it is down. */
export interface DocsRootDown {
  since: string
  mailedAt?: string
}

/**
 * The docs root did not answer this run either. `prev` is what the last run left, nothing when the root answered then. It
 * is worth a mail once it has been down `afterHours`, then once a day while it lasts.
 */
export function docsRootDown(prev: DocsRootDown | undefined, at: string, afterHours: number): { down: DocsRootDown; hours: number; mail: boolean } {
  const since = prev?.since ?? at
  const hours = (Date.parse(at) - Date.parse(since)) / 3600_000
  const mailedToday = !!prev?.mailedAt && Date.parse(at) - Date.parse(prev.mailedAt) < 24 * 3600_000
  return { down: { since, ...(prev?.mailedAt ? { mailedAt: prev.mailedAt } : {}) }, hours, mail: hours >= afterHours && !mailedToday }
}

/**
 * One document of an import as the next run compares it, under the importer's own `importKey` (`journal-plan.ts`).
 * The importer answers with counts per month, and a mail of counts alone could not say which documents the accountant
 * touched (2026-11-06: "64 change(s)", from an archive the books PC had already written again). The label is a date, a
 * type and a number, never a name or an amount: an importKey names the partner, so the keys stay on the docs root
 * beside the journals they come from, and only labels go into a mail.
 */
export interface ImportedDocument {
  month: string
  /** `planMonth`'s contentHash, shortened: what `changed` means to the importer. */
  hash: string
  label: string
  /**
   * The operation count, then a hash per part of the document, to say what changed. The last two split the amounts into
   * the cost of goods and the rest; a file kept before they existed has neither.
   */
  parts: string
}
export type ImportedDocuments = Map<string, ImportedDocument>

/** The parts `parts` hashes, in its order, by the words a change is described with. */
const PARTS = ['total', 'VAT kind or comment', 'amounts or quantities', 'accounts', 'analytics', 'operation notes']

/**
 * An operation that takes goods out of stock: an inventory account (30x) credited against anything but another one, a
 * sale's cost (70x) or a write-off (601). Its amount is the cost of the goods, which PlusMinus works out again when a
 * delivery is entered back-dated. On 2026-11-06 a mail listed 49 documents as changed in "amounts or quantities" alone,
 * and every one of them had changed only these amounts: its total, revenue and VAT were as before.
 */
const takesFromStock = (op: ImportOperation) => /^30/.test(op.k) && !/^30/.test(op.d)

function partsOf(doc: ImportDocument): string {
  const h = (v: unknown) => sha256(JSON.stringify(v ?? null)).slice(0, 8)
  return [
    String(doc.ops.length),
    h(doc.total),
    h([doc.vatKind, doc.comment]),
    h(doc.ops.map(op => [op.amount, op.qty, op.cur, op.rate, op.fx])),
    h(doc.ops.map(op => [op.d, op.k])),
    h(doc.ops.map(op => [op.ad, op.ak])),
    h(doc.ops.map(op => [op.comment, op.journal, op.tax])),
    // Appended rather than put in place of the amounts, so that a file kept before them still compares part by part.
    h(doc.ops.map(op => (takesFromStock(op) ? op.amount : null))),
    h(doc.ops.map(op => [takesFromStock(op) ? null : op.amount, op.qty, op.cur, op.rate, op.fx])),
    // FR-25a: the rest of the header (what was paid, the links, …), a part only a document that has one gets: every
    // other document's parts read as before. An invoice paid later changes here alone.
    ...(headerContentOf(doc.props) ? [h(headerContentOf(doc.props))] : []),
  ].join('.')
}

/** Date, type and number; an operation with no document, by its accounts. Never an analytic path: those name people. */
export function labelOf(doc: ImportDocument): string {
  if (doc.docType) return [doc.date, doc.docType, doc.docNumber].filter(Boolean).join(' ')
  const op = doc.ops[0]
  return op ? `${doc.date} D${op.d} K${op.k}` : doc.date
}

/** A journal's documents, keyed and grouped the way the importer plans them: by month, in file order. */
export function importedDocuments(documents: ImportDocument[]): ImportedDocuments {
  const out: ImportedDocuments = new Map()
  for (const [month, docs] of documentsByMonth(documents)) {
    for (const entry of planMonth(docs, [])) {
      out.set(entry.importKey, { month, hash: entry.contentHash.slice(0, 16), label: labelOf(entry.doc), parts: partsOf(entry.doc) })
    }
  }
  return out
}

export interface DocumentChange {
  month: string
  kind: 'new' | 'changed' | 'moved' | 'gone'
  label: string
  /** What differs, for `changed` and `moved`. */
  what?: string
}

function whatDiffers(before: string, after: string, moved: boolean): string {
  const [n0, ...p0] = before.split('.')
  const [n1, ...p1] = after.split('.')
  const out = moved ? ['another customer or supplier'] : []
  if (n0 !== n1) out.push(`${n0} → ${n1} operations`)
  // Whether both sides keep the cost of goods apart from the other amounts.
  const [cost, rest] = [PARTS.length, PARTS.length + 1]
  const split = p0.length > rest && p1.length > rest
  PARTS.forEach((name, i) => {
    if (p0[i] === p1[i]) return
    // With another operation count every per-operation part differs, and a move always changes the analytics.
    if (n0 !== n1 && i >= 2) return
    if (moved && name === 'analytics') return
    if (split && name === 'amounts or quantities') {
      if (p0[rest] !== p1[rest]) out.push(name)
      if (p0[cost] !== p1[cost]) out.push('cost of goods')
      return
    }
    out.push(name)
  })
  // FR-25a: the header's part, which a document without one does not have.
  const header = PARTS.length + 2
  if ((p0[header] ?? '') !== (p1[header] ?? '')) out.push('header (paid, links, …)')
  return out.join(', ')
}

/** A document's identity without its partner: `doc|type|number|date`. An operation with no document has none. */
const stemOf = (key: string) => (key.startsWith('doc|') ? key.replace(/#\d+$/, '').split('|').slice(0, 4).join('|') : undefined)

const KINDS: DocumentChange['kind'][] = ['new', 'changed', 'moved', 'gone']

/**
 * What differs between the documents of two imports. The partner is part of a document's importKey, so a document moved
 * to another customer or supplier is gone under one key and new under another: one of each with the same type, number and
 * date is reported once, as `moved`.
 */
export function documentChanges(before: ImportedDocuments, after: ImportedDocuments): DocumentChange[] {
  const out: DocumentChange[] = []
  const gone = [...before].filter(([key]) => !after.has(key))
  const goneByStem = new Map<string, ImportedDocument[]>()
  for (const [key, doc] of gone) {
    const stem = stemOf(key)
    if (stem) goneByStem.set(stem, [...(goneByStem.get(stem) ?? []), doc])
  }
  const moved = new Set<ImportedDocument>()
  for (const [key, doc] of after) {
    const was = before.get(key)
    if (was) {
      if (was.hash !== doc.hash) out.push({ month: doc.month, kind: 'changed', label: doc.label, what: whatDiffers(was.parts, doc.parts, false) })
      continue
    }
    const stem = stemOf(key)
    const twin = stem ? goneByStem.get(stem)?.shift() : undefined
    if (twin) {
      moved.add(twin)
      out.push({ month: doc.month, kind: 'moved', label: doc.label, what: whatDiffers(twin.parts, doc.parts, true) })
    } else out.push({ month: doc.month, kind: 'new', label: doc.label })
  }
  for (const [, doc] of gone) if (!moved.has(doc)) out.push({ month: doc.month, kind: 'gone', label: doc.label })
  return out.sort((a, b) => a.month.localeCompare(b.month) || a.label.localeCompare(b.label) || KINDS.indexOf(a.kind) - KINDS.indexOf(b.kind))
}

/** A line per month with its counts, then a line per document. */
export function documentChangesText(changes: DocumentChange[]): string[] {
  const lines: string[] = []
  for (const month of [...new Set(changes.map(c => c.month))]) {
    const of = changes.filter(c => c.month === month)
    const counts = KINDS.map(kind => [kind, of.filter(c => c.kind === kind).length] as const).filter(([, n]) => n)
    lines.push(`${month}: ${counts.map(([kind, n]) => `${n} ${kind}`).join(', ')}`)
    for (const c of of) lines.push(`  ${c.kind.padEnd(7)} ${c.label}${c.what ? ` (${c.what})` : ''}`)
  }
  return lines
}

/** What the run keeps of an import's documents for the next one to compare with. */
export interface ImportedDocumentsFile {
  archive: string
  sha12: string
  at: string
  documents: ImportedDocuments
}

export function serializeImported(file: ImportedDocumentsFile): Uint8Array {
  const { documents, ...head } = file
  return gzipSync(JSON.stringify({ v: 1, ...head, documents: [...documents].map(([key, d]) => [key, d.month, d.hash, d.label, d.parts]) }))
}

/** Nothing when the bytes are not such a file: the run then lists nothing rather than fail. */
export function parseImported(bytes: Uint8Array): ImportedDocumentsFile | undefined {
  try {
    const held = JSON.parse(gunzipSync(bytes).toString('utf8'))
    if (held?.v !== 1 || !Array.isArray(held.documents)) return undefined
    const documents: ImportedDocuments = new Map(held.documents.map(([key, month, hash, label, parts]: string[]) => [key, { month, hash, label, parts }]))
    return { archive: held.archive, sha12: held.sha12, at: held.at, documents }
  } catch {
    return undefined
  }
}
