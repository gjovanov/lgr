/**
 * The daily PlusMinus → LGR import, as checks.
 *
 * Two kinds of thing live here, both import-pure (files in, findings out, no network):
 *   - readers of the PULLED documents: what changed since the last pull (`diffPulls`), whether PlusMinus moved while a
 *     day was being booked (`sameDay`), and which documents of a day moved no stock (`scanDay`);
 *   - readers of the IMPORTERS' own console output (`parse…`), so that "read the dry run" is the same reading every day.
 *
 * A parser that does not find the line it reads answers `null` for that figure, and the caller treats an unread
 * figure as a failed check: a format that drifted must never read as "nothing to report".
 *
 * Used by `.claude/skills/daily-import/daily.ts`.
 */
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

// ── The pulled documents ────────────────────────────────────────────────────────────────────────────────────────────

/** A pulled document file: `<family>_<number>[.<tag>].json` (`.fea` is an annulment sharing its invoice's number). */
export const DOC_FILE = /^(invoicem|stokrazp|sklrazp|sklisk|storeOperations)_(\d+)(\.[^.]+)?\.json$/

/** PlusMinus's store for a line that moved no stock (a till sale invoiced later, goods handled on another document). */
export const NO_STORE = /БЕЗСКЛАД/

const readJson = (path: string): any => JSON.parse(readFileSync(path, 'utf8'))

export const docFiles = (dir: string): string[] => (existsSync(dir) ? readdirSync(dir).filter(f => DOC_FILE.test(f)).sort() : [])

function loadPulls(dirs: readonly string[]): Map<string, any> {
  const m = new Map<string, any>()
  for (const d of dirs) for (const f of docFiles(d)) m.set(f, readJson(join(d, f)))
  return m
}

/** What a document says that stock or money depends on: its header, and per line the item, quantity and operations. */
function signature(doc: any): { head: string; lines: string[] } {
  const h = doc?.header ?? {}
  const lines = (doc?.lines ?? []).map((l: any) =>
    `${l.item}|${l.quantity}|${(l.operations ?? []).map((o: any) => `${o.type}@${o.store}:${o.quantity}`).join(',')}`)
  return { head: `${h.docDate}|${h.sum}|${h.partner ?? ''}|${h.status ?? ''}`, lines }
}

export interface ChangedDoc {
  file: string
  date: string
  /** The header before and after, when it changed. */
  head?: [string, string]
  removed: string[]
  added: string[]
}

export interface PullDiff {
  compared: number
  same: number
  /** Documents PlusMinus edited in place since the old pull. */
  changed: ChangedDoc[]
  /** Documents the old pull held and the new one does not: PlusMinus deleted them. */
  onlyOld: string[]
  /** Documents new since the old pull, with their dates. */
  onlyNew: { file: string; date: string }[]
}

/** Compare two pulls of a store's history, by file name across all folders of each side. */
export function diffPulls(oldDirs: readonly string[], newDirs: readonly string[]): PullDiff {
  const before = loadPulls(oldDirs)
  const now = loadPulls(newDirs)
  const out: PullDiff = { compared: before.size, same: 0, changed: [], onlyOld: [], onlyNew: [] }
  for (const [file, was] of before) {
    const is = now.get(file)
    if (!is) { out.onlyOld.push(file); continue }
    const a = signature(was)
    const b = signature(is)
    if (a.head === b.head && a.lines.join('\n') === b.lines.join('\n')) { out.same++; continue }
    const inA = new Set(a.lines)
    const inB = new Set(b.lines)
    out.changed.push({
      file,
      date: String(was?.header?.docDate ?? ''),
      ...(a.head === b.head ? {} : { head: [a.head, b.head] as [string, string] }),
      removed: a.lines.filter(x => !inB.has(x)),
      added: b.lines.filter(x => !inA.has(x)),
    })
  }
  for (const [file, doc] of now) if (!before.has(file)) out.onlyNew.push({ file, date: String(doc?.header?.docDate ?? '') })
  return out
}

/**
 * Numbers missing from a store's WHOLE pulled history, per family: documents PlusMinus deleted (or never issued).
 * Read across every folder at once, because a document's number and its date need not fall in the same chunk.
 */
export function numberGaps(dirs: readonly string[]): { family: string; missing: number[] }[] {
  const byFamily = new Map<string, Set<number>>()
  for (const d of dirs) for (const f of docFiles(d)) {
    const [, family, number] = DOC_FILE.exec(f)!
    if (!byFamily.has(family)) byFamily.set(family, new Set())
    byFamily.get(family)!.add(Number(number))
  }
  const out: { family: string; missing: number[] }[] = []
  for (const [family, numbers] of byFamily) {
    const sorted = [...numbers].sort((a, b) => a - b)
    const missing: number[] = []
    for (let i = 1; i < sorted.length; i++) {
      // A jump of thousands is another number series of the same family, not a run of deleted documents.
      if (sorted[i] - sorted[i - 1] > 1000) continue
      for (let n = sorted[i - 1] + 1; n < sorted[i]; n++) missing.push(n)
    }
    if (missing.length) out.push({ family, missing })
  }
  return out
}

/**
 * New documents against the day folder that is about to be booked. `backdated`: new in the history and absent from
 * the day folder (created now, dated earlier: the day pull cannot see them). `notNew`: in the day folder but already
 * in the old history (a day pulled twice).
 */
export function newOutsideDay(diff: PullDiff, dayDir: string): { backdated: { file: string; date: string }[]; notNew: string[] } {
  const day = new Set(docFiles(dayDir))
  const fresh = new Set(diff.onlyNew.map(n => n.file))
  return {
    backdated: diff.onlyNew.filter(n => !day.has(n.file)),
    notNew: [...day].filter(f => !fresh.has(f)),
  }
}

const sha = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex')

const snapshotFile = (dir: string) => (existsSync(dir) ? readdirSync(dir).find(f => /^storeAvailability_\d+\.json$/.test(f)) : undefined)

/** `{ "<store>": { "<item key>": { quantity } } }` → `store | item` → quantity. */
function snapshotQuantities(path: string): Map<string, number> {
  const m = new Map<string, number>()
  for (const [store, items] of Object.entries<Record<string, any>>(readJson(path) ?? {})) {
    for (const [key, row] of Object.entries(items ?? {})) m.set(`${store} | ${key}`, Number(row?.quantity ?? 0))
  }
  return m
}

export interface SameDay {
  first: number
  after: number
  onlyFirst: string[]
  onlyAfter: string[]
  byteDifferent: string[]
  /** null: one side has no snapshot. */
  snapshot: { rowsFirst: number; rowsAfter: number; moved: { name: string; from: number | null; to: number | null }[] } | null
}

/** Did PlusMinus move between the first pull of a day and the pull made after booking? Every file, byte for byte. */
export function sameDay(firstDir: string, afterDir: string): SameDay {
  const files = (d: string) => (existsSync(d) ? readdirSync(d).filter(f => f.endsWith('.json') && !f.startsWith('storeAvailability_')).sort() : [])
  const a = files(firstDir)
  const b = files(afterDir)
  const inB = new Set(b)
  const inA = new Set(a)
  const s1 = snapshotFile(firstDir)
  const s2 = snapshotFile(afterDir)
  let snapshot: SameDay['snapshot'] = null
  if (s1 && s2) {
    const q1 = snapshotQuantities(join(firstDir, s1))
    const q2 = snapshotQuantities(join(afterDir, s2))
    const moved = [...new Set([...q1.keys(), ...q2.keys()])]
      .filter(n => Math.abs((q1.get(n) ?? 0) - (q2.get(n) ?? 0)) > 1e-9)
      .map(name => ({ name, from: q1.get(name) ?? null, to: q2.get(name) ?? null }))
    snapshot = { rowsFirst: q1.size, rowsAfter: q2.size, moved }
  }
  return {
    first: a.length,
    after: b.length,
    onlyFirst: a.filter(f => !inB.has(f)),
    onlyAfter: b.filter(f => !inA.has(f)),
    byteDifferent: a.filter(f => inB.has(f) && sha(join(firstDir, f)) !== sha(join(afterDir, f))),
    snapshot,
  }
}

/** Item groups PlusMinus prefixes an item key with. Only СТОКИ is what the prediction counts. */
const ITEM_GROUP = /^([^:]+):/

export interface DayScan {
  /** Receipts, transfers and write-offs, one row per document. */
  stock: { file: string; family: string; number: string; lines: number; noStock: boolean; stores: string[]; otherGroups: string[] }[]
  invoices: { stockMoving: string[]; noStock: { file: string; from: string[] }[]; mixed: string[]; empty: string[] }
  /** Till tickets (a store whose till is a document family) and their negative lines: a return or an exchange. */
  till: { tickets: number; lines: number; negative: { file: string; item: string; quantity: number }[] }
  /** POS receipts (a store whose till is the POS module): entries, and lines with a negative quantity. */
  pos: { entries: number; lines: number; negative: number }
}

/** Which documents of a pulled day moved no stock, and the other things a booking run must know before it starts. */
export function scanDay(dir: string): DayScan {
  const out: DayScan = {
    stock: [],
    invoices: { stockMoving: [], noStock: [], mixed: [], empty: [] },
    till: { tickets: 0, lines: 0, negative: [] },
    pos: { entries: 0, lines: 0, negative: 0 },
  }
  for (const file of docFiles(dir)) {
    const [, family, number, tag] = DOC_FILE.exec(file)!
    if (tag) continue // an annulment's own file
    const doc = readJson(join(dir, file))
    const lines: any[] = doc?.lines ?? []
    if (family === 'invoicem') {
      const without = lines.filter(l => NO_STORE.test(String(l.store ?? '')))
      if (!lines.length) out.invoices.empty.push(file)
      else if (!without.length) out.invoices.stockMoving.push(file)
      else if (without.length === lines.length) out.invoices.noStock.push({ file, from: [...new Set(lines.map(l => String(l.fromDocument ?? '')))] })
      else out.invoices.mixed.push(file)
      continue
    }
    if (family === 'storeOperations' && doc?.header?.doc === 'СР') {
      out.till.tickets++
      for (const l of lines) {
        out.till.lines++
        if (Number(l.quantity) < 0) out.till.negative.push({ file, item: String(l.item ?? l.name ?? ''), quantity: Number(l.quantity) })
      }
      continue
    }
    const stores = new Set<string>()
    const groups = new Set<string>()
    for (const l of lines) {
      stores.add(String(l.store ?? '-'))
      for (const o of l.operations ?? []) stores.add(String(o.store ?? '-'))
      const group = ITEM_GROUP.exec(String(l.item ?? ''))?.[1]
      if (group && group !== 'СТОКИ') groups.add(group)
    }
    out.stock.push({ file, family, number, lines: lines.length, noStock: [...stores].some(s => NO_STORE.test(s)), stores: [...stores].sort(), otherGroups: [...groups].sort() })
  }
  for (const file of existsSync(dir) ? readdirSync(dir).filter(f => /^posReceipts_\d{8}\.json$/.test(f)) : []) {
    const receipts = readJson(join(dir, file))
    for (const r of Array.isArray(receipts) ? receipts : []) {
      out.pos.entries++
      for (const l of r?.lines ?? []) {
        out.pos.lines++
        if (Number(l.quantity) < 0) out.pos.negative++
      }
    }
  }
  return out
}

// ── The importers' console output ───────────────────────────────────────────────────────────────────────────────────

const int = (s: string | undefined | null): number | null => (s === undefined || s === null || s === '' ? null : Number(s))
const all = (text: string, re: RegExp): RegExpExecArray[] => [...text.matchAll(re)] as RegExpExecArray[]
/** The lines that follow `index`, while they are indented at least `indent` spaces. */
function indentedAfter(lines: string[], index: number, indent: number): string[] {
  const out: string[] = []
  for (let i = index + 1; i < lines.length; i++) {
    if (!lines[i].startsWith(' '.repeat(indent))) break
    out.push(lines[i].trim())
  }
  return out
}

export interface PullSummary {
  families: { prefix: string; count: number; first: string | null; last: string | null; gaps: string | null }[]
  snapshot: { products: number; zero: number } | null
  pos: { kind: string; count: number; days: number }[]
  /** The partner directory (`--families partners`): how many entries, and per group. null: that pull said nothing about it. */
  partners: { entries: number; groups: string } | null
  secondary: number
}

/** pull-api.ts's summary: one line per family, the snapshot, the POS pseudo-families. */
export function parsePull(text: string): PullSummary {
  const families = all(text, /^(invoicem|stokrazp|sklrazp|sklisk|storeOperations)\s+(\d+)(?:\s+(\d+)\.\.(\d+))?(?:\s+GAPS:(\S+))?\s*$/gm)
    .map(m => ({ prefix: m[1], count: Number(m[2]), first: m[3] ?? null, last: m[4] ?? null, gaps: m[5] ?? null }))
  const snap = /^snapshot\s+(\d+) products, (\d+) at zero quantity/m.exec(text)
  const pos = all(text, /^(posReceipts|posLayaways|posReversals)\s+(\d+) \w+ on (\d+) day\(s\)/gm).map(m => ({ kind: m[1], count: Number(m[2]), days: Number(m[3]) }))
  const secondary = all(text, /\+ (\d+) secondary-type doc/g).reduce((s, m) => s + Number(m[1]), 0)
  const partners = /^partners\s+(\d+) entries: (.*)$/m.exec(text)
  return { families, snapshot: snap ? { products: Number(snap[1]), zero: Number(snap[2]) } : null, pos, partners: partners ? { entries: Number(partners[1]), groups: partners[2].trim() } : null, secondary }
}

export interface CompareSummary {
  /** Quantity differences on products matched by exact name. null: the line was not found. */
  qtyDiffs: number | null
  /** The fallback pass: the same article under a different-looking name, with a different quantity. */
  differentQty: string[]
  sameUnderOtherName: number | null
  missingNonzero: number | null
  missing: string[]
  lgrOnlyNonzero: number | null
  lgrOnly: string[]
}

/** compare-stock-api.ts: LGR against a PlusMinus snapshot. */
export function parseCompare(text: string): CompareSummary {
  const lines = text.split(/\r?\n/)
  const at = (re: RegExp) => lines.findIndex(l => re.test(l))
  const diffAt = at(/^\s*\d+ same item, DIFFERENT qty/)
  const missAt = at(/^\s*truly missing in LGR:/)
  const onlyAt = at(/^\s*truly LGR-only:/)
  return {
    qtyDiffs: int(/Qty diffs on matched products[^:]*:\s*(\d+)/.exec(text)?.[1]),
    differentQty: diffAt < 0 ? [] : indentedAfter(lines, diffAt, 4),
    sameUnderOtherName: int(/^\s*(\d+) confirmed same stock under a different-looking name/m.exec(text)?.[1]),
    missingNonzero: int(/truly missing in LGR:\s*(\d+) nonzero/.exec(text)?.[1]),
    missing: missAt < 0 ? [] : indentedAfter(lines, missAt, 4),
    lgrOnlyNonzero: int(/truly LGR-only:\s*(\d+) nonzero/.exec(text)?.[1]),
    lgrOnly: onlyAt < 0 ? [] : indentedAfter(lines, onlyAt, 4),
  }
}

export interface PredictSummary {
  documents: number | null
  now: number | null
  /** Matched products that would still differ after booking the day. Must be 0, or each one named. */
  after: number | null
  residuals: string[]
  /** Articles the day moves that LGR has no product for under that name. */
  fresh: { name: string; effect: number; snapshot: string }[]
}

export function parsePredict(text: string): PredictSummary {
  const head = /^\S+: (\d+) documents\/receipts/m.exec(text)
  const verdict = /matched-product differences now: (\d+) \| predicted after booking: (\d+)/.exec(text)
  return {
    documents: int(head?.[1]),
    now: int(verdict?.[1]),
    after: int(verdict?.[2]),
    residuals: all(text, /^\s+RESID (.*)$/gm).map(m => m[1].trim()),
    fresh: all(text, /^\s+NEW\s+"(.*)" effect=(-?[\d.]+) snapshot=(\S+)\s*$/gm).map(m => ({ name: m[1], effect: Number(m[2]), snapshot: m[3] })),
  }
}

export interface ReceiptDoc {
  number: string
  date: string
  partner: string | null
  receiptLines: number
  priceOnlyLines: number
  adjustmentLines: number
  /** Outgoing lines whose name matched no product: the importer would book the others and block these for good. */
  unmatched: string[]
  /** Price-only lines whose product does not exist (yet). */
  noMatch: string[]
  creates: { sku: string; name: string }[]
  /** Movements this run confirmed. */
  movements: string[]
  /** The receipt half was booked by an earlier run. */
  alreadyBooked: string | null
  /** The outgoing half was booked by an earlier run. */
  adjustmentAlready: string | null
  wouldAdjust: boolean
  pricesApplied: boolean
  typos: string[]
  noSupplier: string | null
  errors: string[]
}

export interface ReceiptsLog {
  docs: ReceiptDoc[]
  processed: { documents: number; failed: number; executed: boolean } | null
  /** `✗ <file>: …` lines outside any document block. */
  errors: string[]
}

const RECEIPT_HEAD = /^── (\d+) \((\d{4}-\d{2}-\d{2})\)(?: — (.*))?: (\d+) receipt line\(s\), (\d+) price-only line\(s\), (\d+) adjustment line\(s\) ──\s*$/

/** receive-stock-api.ts, dry or executed: one block per document. */
export function parseReceiptsLog(text: string): ReceiptsLog {
  const out: ReceiptsLog = { docs: [], processed: null, errors: [] }
  let doc: ReceiptDoc | null = null
  for (const raw of text.split(/\r?\n/)) {
    const head = RECEIPT_HEAD.exec(raw)
    if (head) {
      doc = {
        number: head[1], date: head[2], partner: head[3] ?? null,
        receiptLines: Number(head[4]), priceOnlyLines: Number(head[5]), adjustmentLines: Number(head[6]),
        unmatched: [], noMatch: [], creates: [], movements: [], alreadyBooked: null, adjustmentAlready: null,
        wouldAdjust: false, pricesApplied: false, typos: [], noSupplier: null, errors: [],
      }
      out.docs.push(doc)
      continue
    }
    const done = /^(Would process|Processed): (\d+) document\(s\), (\d+) failed/.exec(raw)
    if (done) { out.processed = { documents: Number(done[2]), failed: Number(done[3]), executed: done[1] === 'Processed' }; doc = null; continue }
    const line = raw.trim()
    if (!doc) { if (line.startsWith('✗')) out.errors.push(line); continue }
    let m: RegExpExecArray | null
    if ((m = /^⚠ UNMATCHED \d+ adjustment line\(s\)[^:]*: (.*)$/.exec(line))) doc.unmatched.push(...m[1].split('; ').map(s => s.trim()).filter(Boolean))
    else if ((m = /^! NO MATCH "(.*)": /.exec(line))) doc.noMatch.push(m[1])
    else if ((m = /^\+ CREATE (\S+)\s+"(.*)"\s+qty /.exec(line))) doc.creates.push({ sku: m[1], name: m[2] })
    else if ((m = /^✓ (SM-[\w-]+) \|/.exec(line))) doc.movements.push(m[1])
    else if ((m = /^✓ adjustment (SM-[\w-]+) confirmed/.exec(line))) doc.movements.push(m[1])
    else if ((m = /^Quantity already booked \((SM-[\w-]+)\)/.exec(line))) doc.alreadyBooked = m[1]
    else if ((m = /^= adjustment already booked: (\S+)/.exec(line))) doc.adjustmentAlready = m[1]
    else if (/^would book adjustment:/.test(line)) doc.wouldAdjust = true
    else if (/^✓ Prices applied to \d+ product/.test(line)) doc.pricesApplied = true
    else if (line.startsWith('⚠ PlusMinus price typo?')) doc.typos.push(line)
    else if ((m = /^⚠ supplier: no active supplier is named "(.*)"/.exec(line))) doc.noSupplier = m[1]
    else if (line.startsWith('✗')) doc.errors.push(line)
  }
  return out
}

export interface MovesLog {
  /** `Would book` or `Booked`. null: the summary line was not found. */
  booked: number | null
  skipped: number | null
  unmatched: number | null
  executed: boolean
  movements: string[]
  errors: string[]
}

/** transfer-stock-api.ts and adjust-stock-api.ts share one summary line. */
export function parseMovesLog(text: string): MovesLog {
  const m = /^(Would book|Booked): (\d+) \| skipped\(dup\): (\d+) \| unmatched lines: (\d+)/m.exec(text)
  return {
    booked: int(m?.[2]), skipped: int(m?.[3]), unmatched: int(m?.[4]), executed: m?.[1] === 'Booked',
    movements: all(text, /✓ (SM-[\w-]+) confirmed/g).map(x => x[1]),
    errors: all(text, /^\s*(✗.*)$/gm).map(x => x[1].trim()),
  }
}

export interface ContactsLog {
  /** The `Planned:` line. null: not found. */
  planned: { create: number; update: number; aliases: number; roles: number; fills: number; same: number; ambiguous: number; conflict: number; inactive: number; skip: number; merged: number } | null
  /** The `Done:` line of a run that wrote. null: this run only planned (or the line is missing). */
  done: { created: number; updated: number; failed: number } | null
  /** `--max-create` refused the run. */
  overLimit: boolean
  /** Names of the contacts to create (or created). */
  created: string[]
  /** Partners the import cannot place: ambiguous, a different ЕИК under the same name, only a deactivated contact fits. */
  held: string[]
  /** Partners PlusMinus holds nothing about: left to the document import. */
  noData: string[]
  failures: string[]
  directory: number | null
}

/** import-contacts-api.ts: the plan, and what a writing run did. */
export function parseContactsLog(text: string): ContactsLog {
  const p = /^Planned: (\d+) to create, (\d+) to update \((\d+) other name\(s\), (\d+) role\(s\), (\d+) field\(s\) to fill\), (\d+) unchanged, (\d+) ambiguous, (\d+) conflict\(s\), (\d+) inactive, (\d+) skipped, (\d+) merged/m.exec(text)
  const d = /^Done: created (\d+) \| updated (\d+) \| failed (\d+)/m.exec(text)
  return {
    planned: p ? { create: Number(p[1]), update: Number(p[2]), aliases: Number(p[3]), roles: Number(p[4]), fills: Number(p[5]), same: Number(p[6]), ambiguous: Number(p[7]), conflict: Number(p[8]), inactive: Number(p[9]), skip: Number(p[10]), merged: Number(p[11]) } : null,
    done: d ? { created: Number(d[1]), updated: Number(d[2]), failed: Number(d[3]) } : null,
    overLimit: /is more than --max-create/.test(text),
    created: all(text, /^\s+\+ CREATE (?:customer|supplier|both) „(.*?)" \(/gm).map(m => m[1]),
    held: all(text, /^\s+[?!] (?:AMBIGUOUS|CONFLICT|INACTIVE) (.*)$/gm).map(m => m[1].trim()),
    noData: all(text, /^\s+- skip „(.*?)": PlusMinus holds nothing/gm).map(m => m[1]),
    failures: all(text, /^\s*(✗.*)$/gm).map(m => m[1].trim()),
    directory: int(/^Directory: (\d+) entries/m.exec(text)?.[1]),
  }
}

export interface TillDay {
  date: string
  entries: string
  items: number | null
  net: number | null
  grossPaid: number | null
  matched: [number, number] | null
  /** `dry`: would post. `posted`: this run posted it. `already`: an earlier run did. null: none of the three was said. */
  result: 'dry' | 'posted' | 'already' | null
  document: string | null
  total: number | null
  unmatched: string[]
  errors: string[]
}

/** import-cash-register-sales-api.ts: one block per till day. */
export function parseTillLog(text: string): TillDay[] {
  const days: TillDay[] = []
  let day: TillDay | null = null
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    let m: RegExpExecArray | null
    if ((m = /^── (\d{4}-\d{2}-\d{2}): (.*) ──$/.exec(line))) {
      day = { date: m[1], entries: m[2], items: null, net: null, grossPaid: null, matched: null, result: null, document: null, total: null, unmatched: [], errors: [] }
      days.push(day)
      continue
    }
    if (!day) continue
    if ((m = /^Items: (\d+) \| net total: ([\d.-]+) EUR \| gross paid: ([\d.-]+) EUR/.exec(line))) { day.items = Number(m[1]); day.net = Number(m[2]); day.grossPaid = Number(m[3]) }
    else if ((m = /^Matched products: (\d+)\/(\d+)/.exec(line))) day.matched = [Number(m[1]), Number(m[2])]
    else if ((m = /^✗ unmatched: (.*)$/.exec(line))) day.unmatched.push(m[1])
    else if ((m = /^DRY RUN, nothing posted \|.*= ([\d.-]+) EUR/.exec(line))) { day.result = 'dry'; day.total = Number(m[1]) }
    else if ((m = /^✓ (\S+) \| \d{4}-\d{2}-\d{2} \|.*= ([\d.-]+) EUR/.exec(line))) { day.result = 'posted'; day.document = m[1]; day.total = Number(m[2]) }
    else if ((m = /^Already imported: (\S+)/.exec(line))) { day.result = 'already'; day.document = m[1] }
    else if (line.startsWith('✗')) day.errors.push(line)
  }
  return days
}

export interface InvoicesLog {
  found: number | null
  newToImport: number | null
  already: number | null
  byHand: number | null
  ok: string[]
  refused: string[]
  /** Documents with a line that has a quantity and no product: they would stay drafts. */
  noProduct: string[]
  movesNoStock: string[]
  newCustomers: number
  eligible: [number, number] | null
  converted: [number, number] | null
  /** Stock movements the convert added. */
  dispatches: number | null
  notIssued: string[]
  attached: string[]
  notAttached: string[]
  counterOk: boolean | null
}

/** import-sales-invoices-api.ts, analysis only or with `--convert`. */
export function parseInvoicesLog(text: string): InvoicesLog {
  const news = /New to import: (\d+) \| already issued\/drafted: (\d+) \| entered by hand: (\d+)/.exec(text)
  const eligible = /Eligible for commit: (\d+)\/(\d+)/.exec(text)
  const converted = /Converted: (\d+)\/(\d+) \| stock movements: \d+ → \d+ \(\+(-?\d+)\)/.exec(text)
  const counter = /SALES_DOC counter: .* (OK|⚠ NOT BUMPED)\s*$/m.exec(text)
  const rows = all(text, /^\s{2}(OK|✗)\s+(\d+) .*$/gm)
  return {
    found: int(/Files found: (\d+)/.exec(text)?.[1]),
    newToImport: int(news?.[1]), already: int(news?.[2]), byHand: int(news?.[3]),
    ok: rows.filter(r => r[1] === 'OK').map(r => r[2]),
    refused: rows.filter(r => r[1] === '✗').map(r => r[0].trim()),
    noProduct: rows.filter(r => /NO PRODUCT on \d+ line/.test(r[0])).map(r => r[2]),
    movesNoStock: all(text, /^\s+moves no stock: (\d+)/gm).map(m => m[1]),
    newCustomers: all(text, /new customer, created by --convert/g).length,
    eligible: eligible ? [Number(eligible[1]), Number(eligible[2])] : null,
    converted: converted ? [Number(converted[1]), Number(converted[2])] : null,
    dispatches: int(converted?.[3]),
    notIssued: all(text, /^\s+✗ (\d+) → .*$/gm).map(m => m[0].trim()),
    attached: all(text, /^\s+✓ (\d+) \(.*\) attached to (\S+)/gm).map(m => `${m[1]} → ${m[2]}`),
    notAttached: all(text, /^\s+(?:✗|⚠) (\d+ \(.*\).*(?:NOT attached|not attached).*)$/gm).map(m => m[1]),
    counterOk: counter ? counter[1] === 'OK' : null,
  }
}

export interface AuditSummary {
  invoices: { plusminus: number; asInv: number; handEntered: number; drafts: number; noCounterpart: number } | null
  /** Invoices with no counterpart in LGR, dated after the baseline. */
  missingAfterBaseline: string[]
  families: { family: string; plusminus: number; booked: number; unbooked: number; post: number; pre: number; priceOnly: number }[]
  /** Unbooked documents dated after the baseline, per family line. */
  postBaseline: string[]
  /** Trading days after the baseline without a cash-sale document. null: the line was not found. */
  tillDaysWithout: string[] | null
  /** Guard verdicts that say LGR already agrees with the snapshot without the document. */
  guardAlready: string[]
  different: string[]
}

/** audit-coverage-api.ts: which PlusMinus documents are in LGR. `baseline` is the org's `YYYY-MM-DD`. */
export function parseAudit(text: string, baseline: string): AuditSummary {
  const inv = /PlusMinus (\d+) · as INV-<number> in LGR (\d+) · not under that number \d+: (\d+) hand-entered[^,]*, (\d+) still an unissued draft, (\d+) NO counterpart/.exec(text)
  const families = all(text, /^(stokrazp|sklrazp|sklisk)\s+PlusMinus (\d+) .*? · booked (\d+) · unbooked (\d+): (\d+) post-baseline, (\d+) pre-baseline, (\d+) price-only\/empty/gm)
    .map(m => ({ family: m[1], plusminus: Number(m[2]), booked: Number(m[3]), unbooked: Number(m[4]), post: Number(m[5]), pre: Number(m[6]), priceOnly: Number(m[7]) }))
  const till = /trading days WITHOUT a cash-sale document: (\d+)(?: → (.*))?$/m.exec(text)
  const tillDays = till ? (till[2] ?? '').split(',').map(s => s.trim()).filter(Boolean) : null
  return {
    invoices: inv ? { plusminus: Number(inv[1]), asInv: Number(inv[2]), handEntered: Number(inv[3]), drafts: Number(inv[4]), noCounterpart: Number(inv[5]) } : null,
    missingAfterBaseline: all(text, /^\s+MISSING (\d+) (\d{4}-\d{2}-\d{2}) /gm).filter(m => m[2] > baseline).map(m => `${m[1]} ${m[2]}`),
    families,
    postBaseline: all(text, /^\s{2}POST\s{2}(\d+) (\d{4}-\d{2}-\d{2}) /gm).map(m => `${m[1]} ${m[2]}`),
    tillDaysWithout: tillDays === null ? null : tillDays.filter(d => d.slice(0, 10) > baseline),
    guardAlready: all(text, /^\s+POST (\w+) (\d+) (\d{4}-\d{2}-\d{2}) .*?\b(ALREADY:\d+.*)$/gm).map(m => `${m[1]} ${m[2]} ${m[3]}  ${m[4].trim()}`),
    different: all(text, /^\s+DIFF\s+(\d+ \d{4}-\d{2}-\d{2}.*)$/gm).map(m => m[1].trim()),
  }
}

export interface PriceDiffSummary {
  changed: number | null
  unexplained: number | null
  protectedChanged: string[]
  unexplainedLines: string[]
}

/** price-diff.ts: every price change of a run must be named by a receipt line of its logs. */
export function parsePriceDiff(text: string): PriceDiffSummary {
  const m = /^price-diff: changed (\d+) \| unexplained (\d+) \|/m.exec(text)
  return {
    changed: int(m?.[1]),
    unexplained: int(m?.[2]),
    protectedChanged: all(text, /^\s+PROTECTED changed (.*)$/gm).map(x => x[1].trim()),
    unexplainedLines: all(text, /^\s+(?:UNEXPLAINED|NEW not in logs) (.*)$/gm).map(x => x[1].trim()),
  }
}

// ── Findings ────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * `ok`: checked and fine. `note`: worth a line in the report. `act`: a person decides or does something before the
 * run goes on. `stop`: do not go on.
 */
export type Level = 'ok' | 'note' | 'act' | 'stop'
export interface Finding { level: Level; text: string; detail?: string[] }

export const finding = (level: Level, text: string, detail?: string[]): Finding => ({ level, text, ...(detail?.length ? { detail } : {}) })

/** A figure a parser could not read is a failed check, never a pass. */
export const unread = (what: string): Finding => finding('stop', `could not read ${what}: the tool's output changed, read the log yourself`)

// ── The gates: what each phase of a day's import must say before the next one starts ────────────────────────────────

/**
 * In booking order. `contacts` is first on purpose: a receipt links its supplier and an invoice its customer by name, and
 * both can only find a contact that exists. The others are as before: a receipt creates the products an invoice sells, and
 * the till day must exist before an invoice of a till sale attaches to it.
 */
export const FAMILIES = ['contacts', 'receipts', 'transfers', 'writeoffs', 'till', 'invoices'] as const
export type Family = (typeof FAMILIES)[number]

/** The history of a store since the previous run, against the day about to be booked. */
export function gateHistory(d: PullDiff, outside: ReturnType<typeof newOutsideDay>, period: string): Finding[] {
  const out: Finding[] = [finding('ok', `history: compared ${d.compared}, same ${d.same}, new ${d.onlyNew.length}`)]
  if (d.changed.length) out.push(finding('act', `${d.changed.length} booked document(s) EDITED in PlusMinus since the previous run. Do not book them again: each is a residual the prediction must show and a true-up absorbs. A changed customer needs the owner's word.`, d.changed.map(ch => `${ch.file} (${ch.date}): -${ch.removed.length} +${ch.added.length} line(s)${ch.head ? ', header changed' : ''}`)))
  if (d.onlyOld.length) out.push(finding('act', `${d.onlyOld.length} document(s) DELETED in PlusMinus since the previous run. If LGR booked one, a true-up absorbs it; one that was held and never booked owes nothing.`, d.onlyOld))
  if (outside.backdated.length) out.push(finding('act', `${outside.backdated.length} new document(s) dated OUTSIDE ${period}: the day pull cannot see them. Book them by number from their history chunk, before the day's own receipts.`, outside.backdated.map(n => `${n.file} date ${n.date}`)))
  if (outside.notNew.length) out.push(finding('act', `${outside.notNew.length} file(s) of the day folder were already in the previous history: the day was pulled before, so check what is booked (the rerun phase says)`, outside.notNew.slice(0, 5)))
  if (!d.changed.length && !d.onlyOld.length && !outside.backdated.length && !outside.notNew.length) out.push(finding('ok', 'nothing edited, nothing deleted, nothing back-dated: the new documents are exactly the day folder'))
  return out
}

export function gateScan(s: DayScan): Finding[] {
  const out: Finding[] = []
  const noStock = s.stock.filter(d => d.noStock)
  if (noStock.length) out.push(finding('act', `${noStock.length} receipt/transfer/write-off document(s) with a line or an operation on БЕЗСКЛАД: PlusMinus moved no stock for them, and the importers WOULD. Hold them (book the others with --only) and tell the owner.`, noStock.map(d => `${d.file}: ${d.stores.join(' ')}`)))
  else out.push(finding('ok', `${s.stock.length} receipt/transfer/write-off document(s), every line and operation on a real store`))
  const groups = s.stock.filter(d => d.otherGroups.length)
  if (groups.length) out.push(finding('note', `${groups.length} document(s) carry items outside the СТОКИ group: the prediction skips those lines, check them in compare's fallback pass`, groups.map(d => `${d.file}: ${d.otherGroups.join(', ')}`)))
  if (s.invoices.mixed.length) out.push(finding('act', `${s.invoices.mixed.length} invoice(s) mix stock lines with БЕЗСКЛАД lines: the importer refuses them, they need a person`, s.invoices.mixed))
  out.push(finding('ok', `invoices: ${s.invoices.stockMoving.length} move stock, ${s.invoices.noStock.length} move none (attached to their till day), ${s.invoices.empty.length} without lines`))
  if (s.till.tickets) out.push(finding(s.till.negative.length ? 'note' : 'ok', `till: ${s.till.tickets} ticket(s), ${s.till.lines} line(s), ${s.till.negative.length} with a negative quantity (a return or an exchange: the day row carries the sign and puts the stock back)`, s.till.negative.map(n => `${n.file}: ${n.quantity}`)))
  if (s.pos.entries) out.push(finding('ok', `POS: ${s.pos.entries} entries, ${s.pos.lines} line(s), ${s.pos.negative} with a negative quantity`))
  return out
}

export function gateCompare(text: string, when: 'before' | 'after'): Finding[] {
  const cmp = parseCompare(text)
  if (cmp.qtyDiffs === null || cmp.missingNonzero === null) return [unread('the stock comparison')]
  const out: Finding[] = []
  if (when === 'before') out.push(finding('ok', `before booking: ${cmp.qtyDiffs} quantity difference(s), ${cmp.missingNonzero} article(s) with stock missing in LGR`))
  else out.push(finding(cmp.qtyDiffs === 0 ? 'ok' : 'act', `after booking: ${cmp.qtyDiffs} quantity difference(s) on matched products${cmp.qtyDiffs ? '. A true-up only for what the history phase and the prediction NAMED; for anything else, find the document.' : ''}`))
  if (cmp.differentQty.length) out.push(finding('act', `${cmp.differentQty.length} article(s) that LGR holds under a different-looking name, with a different quantity. ${when === 'before' ? 'The importers match by exact name: an outgoing line of one is left unbooked, an incoming one creates a duplicate. Book such a document from a corrected copy.' : 'A line was not booked onto its product.'}`, cmp.differentQty))
  if (when === 'after' && cmp.missingNonzero) out.push(finding('act', `${cmp.missingNonzero} article(s) with stock in PlusMinus and none in LGR`, cmp.missing))
  if (cmp.lgrOnlyNonzero) out.push(finding('note', `${cmp.lgrOnlyNonzero} article(s) with stock in LGR that the snapshot does not list (compare with the previous report: standing ones are not differences)`, cmp.lgrOnly))
  return out
}

/** The audit before booking: what is not in LGR yet, and which unbooked documents the guard doubts. */
export function gateAuditBefore(text: string, baseline: string): Finding[] {
  const a = parseAudit(text, baseline)
  if (!a.invoices || !a.families.length) return [unread('the audit')]
  const out: Finding[] = [finding('ok', `audit: ${a.missingAfterBaseline.length} invoice(s) and ${a.postBaseline.length} receipt/transfer/write-off document(s) not in LGR yet${a.tillDaysWithout?.length ? `, till day(s) missing: ${a.tillDaysWithout.join(', ')}` : ''}`)]
  if (a.invoices.drafts) out.push(finding('act', `${a.invoices.drafts} unissued draft(s) carry a PlusMinus number: issue them with POST /doc-import/convert, never /send`))
  // Each document is judged alone here. Two things explain an ALREADY, and each has its own check: another document of
  // the day undoes the line (the prediction nets the whole day and then says 0), or the line moved no stock (the scan).
  if (a.guardAlready.length) out.push(finding('note', `the guard says LGR already agrees with the snapshot without ${a.guardAlready.length} unbooked document(s), each judged alone. Fine when the scan is clean and the prediction says 0; \`doc.ts find\` shows the other document of the pair.`, a.guardAlready))
  return out
}

/** The audit after booking: nothing dated after the baseline may be left out. */
export function gateAuditAfter(text: string, baseline: string): Finding[] {
  const a = parseAudit(text, baseline)
  if (!a.invoices || !a.families.length || a.tillDaysWithout === null) return [unread('the audit')]
  const out: Finding[] = []
  if (a.missingAfterBaseline.length) out.push(finding('act', `${a.missingAfterBaseline.length} invoice(s) dated after the baseline are not in LGR`, a.missingAfterBaseline))
  if (a.invoices.drafts) out.push(finding('act', `${a.invoices.drafts} unissued draft(s) carry a PlusMinus number`))
  if (a.postBaseline.length) out.push(finding('act', `${a.postBaseline.length} receipt/transfer/write-off document(s) dated after the baseline are not booked (a held one belongs here: say so in the report)`, a.postBaseline))
  if (a.tillDaysWithout.length) out.push(finding('act', `till day(s) without a cash-sale document: ${a.tillDaysWithout.join(', ')}`))
  if (a.different.length) out.push(finding('note', `${a.different.length} invoice(s) differ from PlusMinus beyond rounding (compare with the previous report: standing ones are known)`, a.different))
  out.push(finding('ok', `audit: ${a.invoices.asInv} invoices under their number, ${a.invoices.handEntered} entered by hand, ${a.invoices.noCounterpart} with no counterpart (the opening day's are known); ${a.families.map(f => `${f.family} ${f.booked} booked`).join(', ')}`))
  return out
}

export function gatePredict(text: string): Finding[] {
  const p = parsePredict(text)
  if (p.after === null) return [unread('the prediction')]
  const out: Finding[] = [finding(p.after === 0 ? 'ok' : 'act', `prediction: ${p.now} difference(s) now, ${p.after} after booking${p.after ? '. Name every residual (an edit or a deletion the history phase listed, a back-dated or a held document) before any write.' : ''}`, p.residuals)]
  const outgoing = p.fresh.filter(f => f.effect < 0)
  const incoming = p.fresh.filter(f => f.effect >= 0)
  if (outgoing.length) out.push(finding('act', `${outgoing.length} article(s) leave stock today that LGR has no product for under that name: a name that differs, not a new product. Find the LGR product (compare's fallback pass) and book the document from a corrected copy.`, outgoing.map(f => `"${f.name}" effect ${f.effect}, snapshot ${f.snapshot}`)))
  if (incoming.length) out.push(finding('note', `${incoming.length} article(s) new to LGR: a receipt of the day creates each. Check none is an existing product under another spelling.`, incoming.map(f => `"${f.name}" effect ${f.effect}, snapshot ${f.snapshot}`)))
  return out
}

/** What a dry run of one family says. `rerun`: the day is booked, so nothing may be left to book. */
export function gateDry(family: Family, text: string, code: number, rerun: boolean): Finding[] {
  const nothingMapped = family === 'writeoffs' && /Nothing mapped/.test(text)
  // The contacts importer exits 1 when --max-create refuses the run; that is a finding below, not a failed tool.
  if (code !== 0 && !nothingMapped && !(family === 'contacts' && parseContactsLog(text).overLimit)) return [finding('stop', `the ${family} dry run failed (exit ${code})`)]
  const out: Finding[] = []
  if (family === 'contacts') {
    const c = parseContactsLog(text)
    if (!c.planned) return [unread('the contacts plan')]
    const p = c.planned
    if (c.overLimit) out.push(finding('act', `${p.create} contact(s) to create is more than --max-create allows: read the list, and raise it only if the list is right`))
    if (c.held.length) out.push(finding('act', `${c.held.length} partner(s) the import cannot place (several contacts fit, a contact of that name holds a different ЕИК, or only a deactivated contact fits): a person decides, and nothing is written for them`, c.held))
    if (rerun && (p.create || p.update)) out.push(finding('act', `contacts are NOT settled: ${p.create} to create, ${p.update} to update`))
    if (!rerun && p.create) out.push(finding('note', `${p.create} contact(s) are created with what PlusMinus knows (a customer or supplier nobody holds)`, c.created))
    if (!rerun && p.update) out.push(finding('note', `${p.update} contact(s) are filled where empty, given the documents' name as another name, or widened to both (${p.aliases} other name(s), ${p.roles} role(s), ${p.fills} field(s))`))
    if (c.noData.length) out.push(finding('note', `${c.noData.length} partner(s) PlusMinus holds nothing about: left to the document import (a customer is still created by name when an invoice needs it)`, c.noData))
    out.push(finding('ok', `contacts: ${p.create} to create, ${p.update} to update, ${p.same} unchanged, ${p.skip} skipped${p.merged ? `, ${p.merged} merged into a planned contact` : ''}`))
    return out
  }
  if (family === 'receipts') {
    const r = parseReceiptsLog(text)
    if (!r.processed) return [unread('the receipts dry run')]
    if (r.processed.failed || r.errors.length) out.push(finding('stop', `${r.processed.failed} receipt(s) failed`, r.errors))
    const created = new Set<string>()
    for (const d of r.docs) {
      if (d.errors.length) out.push(finding('stop', `${d.number}: ${d.errors[0]}`))
      if (d.unmatched.length) out.push(finding('act', `${d.number}: ${d.unmatched.length} outgoing line(s) match no product. Do NOT execute this document as it is: the matched lines would be booked under its marker and the marker then blocks these for good. Book it whole from a corrected copy (--dir, --only).`, d.unmatched))
      const orphan = d.noMatch.filter(n => !created.has(n))
      if (orphan.length) out.push(finding('act', `${d.number}: ${orphan.length} price-only line(s) name a product that does not exist and that no earlier receipt of this run creates`, orphan))
      else if (d.noMatch.length) out.push(finding('note', `${d.number}: ${d.noMatch.length} price-only line(s) wait for a product an earlier receipt of this run creates (in the executed log they must read REPRICE)`))
      for (const cr of d.creates) created.add(cr.name)
      if (d.creates.length) out.push(finding('note', `${d.number}: creates ${d.creates.length} product(s). An existing product under another spelling would be duplicated: check each against the prediction's NEW list.`, d.creates.map(x => x.name)))
      for (const t of d.typos) out.push(finding('note', `${d.number}: ${t}`))
      if (rerun) {
        if (d.receiptLines && !d.alreadyBooked) out.push(finding('act', `${d.number}: its receipt lines are NOT booked`))
        if (d.adjustmentLines && !d.adjustmentAlready) out.push(finding('act', `${d.number}: its outgoing lines are NOT booked`))
      }
    }
    const none = r.docs.filter(d => d.noSupplier)
    if (none.length) out.push(finding('note', `${none.length} receipt(s) name a partner that is no active supplier, so they carry none`, [...new Set(none.map(d => d.noSupplier!))]))
    out.push(finding('ok', rerun
      ? `receipts rerun: ${r.docs.length} document(s), ${r.docs.filter(d => d.alreadyBooked).length} receipt halves and ${r.docs.filter(d => d.adjustmentAlready).length} outgoing halves already booked`
      : `receipts: ${r.docs.length} document(s): ${r.docs.filter(d => d.receiptLines).length} with stock in, ${r.docs.filter(d => d.adjustmentLines).length} with stock out, ${r.docs.filter(d => !d.receiptLines && !d.adjustmentLines).length} price-only`))
    return out
  }
  if (family === 'transfers' || family === 'writeoffs') {
    const m = parseMovesLog(text)
    if (m.booked === null) return [nothingMapped ? finding('ok', `${family}: nothing to map`) : unread(`the ${family} dry run`)]
    if (m.errors.length) out.push(finding('stop', `${family}: ${m.errors.length} error(s)`, m.errors))
    if (m.unmatched) out.push(finding('act', `${family}: ${m.unmatched} line(s) match no product: they would not be booked and stock stays too high`))
    out.push(finding(rerun && m.booked ? 'act' : 'ok', `${family}: would book ${m.booked}, ${m.skipped} already booked`))
    return out
  }
  if (family === 'till') {
    const days = parseTillLog(text)
    if (!days.length) return [unread('the till dry run')]
    for (const d of days) {
      if (d.errors.length) out.push(finding('stop', `till ${d.date}: ${d.errors[0]}`))
      else if (d.result === 'already') out.push(finding('ok', `till ${d.date}: already imported as ${d.document}`))
      else if (d.result === 'dry') {
        if (rerun) out.push(finding('act', `till ${d.date}: NOT booked`))
        if (d.matched && d.matched[0] < d.matched[1]) out.push(finding('act', `till ${d.date}: ${d.matched[1] - d.matched[0]} line(s) match no product and would be free text: they dispatch nothing`, d.unmatched))
        const apart = d.total !== null && d.grossPaid !== null && Math.abs(d.total - d.grossPaid) > 0.005
        out.push(finding('ok', `till ${d.date}: ${d.items} line(s), ${d.total} EUR to book, ${d.grossPaid} EUR taken${apart ? ` (${(d.total! - d.grossPaid!).toFixed(2)}: the till rounds each line's price with VAT)` : ''}`))
      } else out.push(unread(`the till day ${d.date}`))
    }
    return out
  }
  const i = parseInvoicesLog(text)
  if (i.newToImport === null) return [unread('the invoice analysis')]
  if (i.refused.length) out.push(finding('act', `${i.refused.length} invoice(s) the analysis refuses`, i.refused))
  if (i.noProduct.length) out.push(finding('act', `${i.noProduct.length} invoice(s) have a line with a quantity and no product: they would stay drafts. If a receipt of the day creates the product, book the receipts and analyze again; else link the product.`, i.noProduct))
  if (i.eligible && i.eligible[0] < i.eligible[1]) out.push(finding('act', `only ${i.eligible[0]} of ${i.eligible[1]} analyzed invoices are eligible`))
  if (rerun && i.newToImport) out.push(finding('act', `${i.newToImport} invoice(s) are NOT in LGR`))
  out.push(finding('ok', `invoices: ${i.newToImport} new, ${i.already} already in LGR, ${i.byHand} entered by hand; ${i.movesNoStock.length} move no stock; ${i.newCustomers} new customer(s)`))
  return out
}

/** What an importer said after it WROTE. */
export function gateBooked(family: Family, text: string, code: number): Finding[] {
  const out: Finding[] = []
  if (code !== 0) out.push(finding('stop', `the ${family} importer exited ${code}: read its log before anything else, part of it may be booked`))
  if (family === 'contacts') {
    const c = parseContactsLog(text)
    if (!c.done) return [...out, unread('the contacts run')]
    if (c.done.failed || c.failures.length) out.push(finding('stop', `${c.done.failed} contact(s) failed to write`, c.failures))
    out.push(finding('ok', `contacts booked: ${c.done.created} created, ${c.done.updated} updated`))
    return out
  }
  if (family === 'receipts') {
    const r = parseReceiptsLog(text)
    if (!r.processed) return [...out, unread('the receipts run')]
    const errors = [...r.errors, ...r.docs.flatMap(d => d.errors.map(e => `${d.number}: ${e}`))]
    if (r.processed.failed || errors.length) out.push(finding('stop', `${r.processed.failed} receipt(s) failed`, errors))
    for (const d of r.docs) {
      if (d.unmatched.length || d.noMatch.length) out.push(finding('act', `${d.number}: ${d.unmatched.length} outgoing and ${d.noMatch.length} price-only line(s) were NOT applied`, [...d.unmatched, ...d.noMatch]))
      if (d.receiptLines && !d.movements.length && !d.alreadyBooked) out.push(finding('act', `${d.number}: no receipt movement confirmed`))
    }
    out.push(finding('ok', `receipts booked: ${r.docs.length} document(s), movements ${r.docs.flatMap(d => d.movements).join(' ') || '(none: price-only)'}`))
    return out
  }
  if (family === 'transfers' || family === 'writeoffs') {
    const m = parseMovesLog(text)
    if (m.booked === null) return [...out, unread(`the ${family} run`)]
    if (m.unmatched || m.errors.length) out.push(finding('act', `${family}: ${m.unmatched} unmatched line(s), ${m.errors.length} error(s)`, m.errors))
    out.push(finding('ok', `${family} booked: ${m.booked} (${m.movements.join(' ')}), ${m.skipped} already there`))
    return out
  }
  if (family === 'till') {
    const days = parseTillLog(text)
    if (!days.length) return [...out, unread('the till run')]
    for (const d of days) {
      if (d.result === 'posted') out.push(finding('ok', `till ${d.date}: ${d.document}, ${d.total} EUR (${d.grossPaid} taken)`))
      else if (d.result === 'already') out.push(finding('ok', `till ${d.date}: already imported as ${d.document}`))
      else out.push(finding('stop', `till ${d.date}: not posted`, d.errors))
    }
    return out
  }
  const i = parseInvoicesLog(text)
  if (!i.converted) return [...out, unread('the invoice convert')]
  const moving = i.converted[0] - i.movesNoStock.length
  if (i.notIssued.length || i.converted[0] < i.converted[1]) out.push(finding('act', `${i.converted[1] - i.converted[0]} invoice(s) were NOT issued and stay drafts. Link the product on the named line, then POST /doc-import/convert {target:'sales_invoice', ids}; a plain /send would take the next number.`, i.notIssued))
  if (i.dispatches !== moving) out.push(finding('act', `${i.dispatches} stock movement(s) for ${moving} issued invoice(s) that move stock: one issued without dispatching, or something else moved meanwhile`))
  if (i.notAttached.length) out.push(finding('act', `${i.notAttached.length} till invoice(s) not attached to their till day`, i.notAttached))
  if (i.counterOk === false) out.push(finding('act', 'the sales-document counter was not moved past the imported numbers'))
  out.push(finding('ok', `invoices issued: ${i.converted[0]} of ${i.converted[1]}, ${i.dispatches} dispatch(es), ${i.attached.length} attached to a till day, ${i.newCustomers} new customer(s)`))
  return out
}

export function gateSameDay(s: SameDay): Finding[] {
  if (!s.snapshot) return [unread('the two snapshots')]
  const moved = s.onlyFirst.length + s.onlyAfter.length + s.byteDifferent.length
  if (moved || s.snapshot.moved.length) return [finding('stop', `PlusMinus MOVED while the day was booked: ${s.onlyAfter.length} new, ${s.onlyFirst.length} gone, ${s.byteDifferent.length} changed document(s), ${s.snapshot.moved.length} quantity change(s). What was booked is the first pull: book what is new by number, then compare against the pull made after.`, [...s.onlyAfter, ...s.byteDifferent])]
  return [finding('ok', `PlusMinus stood still: ${s.first} documents byte-identical, 0 quantity changes in ${s.snapshot.rowsAfter} snapshot rows`)]
}

export function gatePrices(text: string, code: number): Finding[] {
  const p = parsePriceDiff(text)
  if (code !== 0 || p.changed === null) return [unread('the price diff')]
  const out: Finding[] = []
  if (p.protectedChanged.length) out.push(finding('stop', `${p.protectedChanged.length} purchase price(s) or cost tier(s) changed: an import never writes those on a product that existed`, p.protectedChanged))
  if (p.unexplained) out.push(finding('act', `${p.unexplained} price change(s) or new product(s) that no receipt line of this run names: someone or something else wrote them, find out what`, p.unexplainedLines))
  out.push(finding('ok', `prices: ${p.changed} product(s) repriced${p.unexplained ? '' : ', every change named by a receipt line'} (list: price-list.tsv)`))
  return out
}
