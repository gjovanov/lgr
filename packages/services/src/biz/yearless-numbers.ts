/**
 * The sales documents an org issued as `<prefix>-<year>-<number>` before it chose to number that series without a
 * year (the sequences page's option, `invoice-numbering.service`), brought to the form everything issued after the
 * choice has: `<prefix>-<ten digits>`.
 *
 * Why: an org that takes its numbers from another system holds the documents brought in from it as
 * `INV-3000004104` and the ones typed in here as `INV-2026-3000004106`: one series read two ways (owner,
 * 2026-11-15). The option settles what is issued from then on. This brings the earlier ones along, for an org
 * that asks for it.
 *
 * What a run changes on a document, and nothing else:
 *   - `invoiceNumber`: the year goes, the running number stays (padded to ten digits);
 *   - `numberHistory`: it gains the number the document had, when no entry names it yet, and the new one;
 *   - `updatedAt`, as any save does.
 * The running number never changes, so no counter, no legal mark and no link by id moves. Text that quotes the old
 * number (a reversal movement's note, a journal entry's description, the audit log) is history and stays as
 * written: the run counts the movements and journal entries that do.
 *
 * Left as they are, and counted by reason:
 *   - `taken`: another document already holds the year-less number;
 *   - `twice`: documents of different years would get the same number (a series that started again each year);
 *   - `clash_pair`: either document of a number issued twice (FR-20.51). The pair is read by that number, on both;
 *   - `draft`: a draft that carries an issued-looking number;
 *   - `other_series`: the number reads like the sales series' and the document is not of it (a bill, a receipt).
 *
 * Only a series that IS continuous is touched: in a series numbered per year, the year is part of the number.
 *
 * `scripts/drop-year-from-sales-numbers.ts` is the command line; `integration/yearless-numbers.flow.test.ts` holds
 * this to a real database.
 */
import { closeSync, createReadStream, fsyncSync, openSync, writeSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { Invoice, JournalEntry, StockMovement } from 'db/models'
import { seriesPrefixes } from './invoice-numbering.service.js'
import { CONTINUOUS_PAD, isContinuousSeries } from './sequence.service.js'

/** The series an org may number without a year. */
const SERIES = 'SALES_DOC'
/**
 * What that series numbers: the invoice and the notes that correct it, on the sales side. Named in each read, not
 * derived from the registry: `sequenceGroupFor` answers "invoice" for a type it does not know, and a payment's
 * receipt is an Invoice row too (FR-23).
 */
const SERIES_TYPES = ['invoice', 'credit_note', 'debit_note']

export type YearlessLeftReason = 'taken' | 'twice' | 'clash_pair' | 'draft' | 'other_series'

export interface YearlessRename {
  id: string
  from: string
  to: string
  status: string
  /** What `numberHistory` held before the run. */
  history: Array<{ number: string; allocatedAt: Date; status: string }>
  /** When the document took the number it has: the entry the run adds for it, if none names it. */
  heldSince: Date
}

export interface YearlessPlan {
  rename: YearlessRename[]
  left: Array<{ id: string; number: string; reason: YearlessLeftReason }>
  /** Documents elsewhere whose text quotes a number the run changes. They stay as written. */
  quoted: { stockMovements: number; journalEntries: number }
}

export class YearlessNumbersError extends Error {
  constructor(public code: 'series_not_continuous', message: string) {
    super(message)
  }
}

/** One line of the backup file: what a document held before the run, and the number the run gave it. */
export interface YearlessBackupLine {
  _id: string
  invoiceNumber: string
  to: string
  numberHistory: Array<{ number: string; allocatedAt: string; status: string }>
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Read what a run would do. Writes nothing. */
export async function planYearlessNumbers(orgId: string): Promise<YearlessPlan> {
  if (!(await isContinuousSeries(orgId, SERIES))) {
    throw new YearlessNumbersError(
      'series_not_continuous',
      'this org numbers its sales documents per year: the year is part of the number. Turn on "No year" on the sequences page first.',
    )
  }
  const prefixes = await seriesPrefixes(orgId, SERIES)
  const yearly = new RegExp(`^(${prefixes.map(escapeRe).join('|')})-\\d{4}-(\\d+)$`)
  const docs: any[] = await Invoice.find(
    { orgId, direction: 'outgoing', type: { $in: SERIES_TYPES }, invoiceNumber: { $regex: yearly } },
    { invoiceNumber: 1, status: 1, numberHistory: 1, numberClash: 1, sentAt: 1, createdAt: 1 },
  ).sort({ invoiceNumber: 1 }).lean().exec()
  // A number that reads like the series' on a document that is not of it: named, never touched.
  const strangers: any[] = await Invoice.find(
    { orgId, invoiceNumber: { $regex: yearly }, $nor: [{ direction: 'outgoing', type: { $in: SERIES_TYPES } }] },
    { invoiceNumber: 1 },
  ).lean().exec()

  // A number issued twice is read by that number on BOTH documents: the one that names the other, and the one named.
  const named = new Set<string>()
  for (let i = 0; i < docs.length; i += 500) {
    const rows: any[] = await Invoice.find(
      { orgId, 'numberClash.withId': { $in: docs.slice(i, i + 500).map(d => d._id) } },
      { 'numberClash.withId': 1 },
    ).lean().exec()
    for (const r of rows) named.add(String(r.numberClash.withId))
  }

  const plan: YearlessPlan = { rename: [], left: [], quoted: { stockMovements: 0, journalEntries: 0 } }
  for (const d of strangers) plan.left.push({ id: String(d._id), number: d.invoiceNumber, reason: 'other_series' })
  const wanted = new Map<string, YearlessRename[]>()
  for (const d of docs) {
    const m = yearly.exec(String(d.invoiceNumber))!
    const leave = (reason: YearlessLeftReason) => plan.left.push({ id: String(d._id), number: d.invoiceNumber, reason })
    if (d.numberClash?.withId || named.has(String(d._id))) { leave('clash_pair'); continue }
    if (d.status === 'draft') { leave('draft'); continue }
    // From the digits as written, not through a Number: a long running number would lose its last digits there.
    const to = `${m[1]}-${m[2].replace(/^0+(?=\d)/, '').padStart(CONTINUOUS_PAD, '0')}`
    const row: YearlessRename = {
      id: String(d._id), from: d.invoiceNumber, to, status: d.status,
      history: (d.numberHistory || []).map((h: any) => ({ number: h.number, allocatedAt: h.allocatedAt, status: h.status })),
      heldSince: d.sentAt || d.createdAt || new Date(0),
    }
    wanted.set(to, [...(wanted.get(to) || []), row])
  }

  // A number two documents would share is given to neither: which of them is "the" one is not this run's to say.
  const single: YearlessRename[] = []
  for (const rows of wanted.values()) {
    if (rows.length === 1) single.push(rows[0])
    else for (const r of rows) plan.left.push({ id: r.id, number: r.from, reason: 'twice' })
  }
  // A year-less number some document already holds stays that document's.
  const held = new Set<string>()
  for (let i = 0; i < single.length; i += 500) {
    const rows: any[] = await Invoice.find({ orgId, invoiceNumber: { $in: single.slice(i, i + 500).map(r => r.to) } }, { invoiceNumber: 1 }).lean().exec()
    for (const r of rows) held.add(r.invoiceNumber)
  }
  for (const r of single) {
    if (held.has(r.to)) plan.left.push({ id: r.id, number: r.from, reason: 'taken' })
    else plan.rename.push(r)
  }
  plan.rename.sort((a, b) => a.from.localeCompare(b.from))
  plan.left.sort((a, b) => a.number.localeCompare(b.number))

  // Text that names an old number. `(?![0-9])`: `INV-2026-00012` is not quoted by `INV-2026-000123`.
  for (let i = 0; i < plan.rename.length; i += 100) {
    const quote = new RegExp(`(?:${plan.rename.slice(i, i + 100).map(r => escapeRe(r.from)).join('|')})(?![0-9])`)
    plan.quoted.stockMovements += await StockMovement.countDocuments({ orgId, $or: [{ notes: { $regex: quote } }, { reference: { $regex: quote } }] }).exec()
    plan.quoted.journalEntries += await JournalEntry.countDocuments({ orgId, $or: [{ description: { $regex: quote } }, { reference: { $regex: quote } }] }).exec()
  }
  return plan
}

export interface YearlessApplyResult {
  /** Documents whose number the run changed. */
  written: number
  /** Planned, and not written: the document's number changed, or its new number was taken, after the plan was read. */
  raced: number
}

/**
 * Write a plan. The before-values of EVERY planned document are on disk (`backupPath`, which must not exist yet)
 * before the first write. A document is written only while it still holds the number the plan read.
 */
export async function applyYearlessNumbers(orgId: string, plan: YearlessPlan, opts: { backupPath: string; now?: Date }): Promise<YearlessApplyResult> {
  const now = opts.now ?? new Date()
  const backup = openSync(opts.backupPath, 'wx')
  try {
    for (const r of plan.rename) {
      const line: YearlessBackupLine = {
        _id: r.id, invoiceNumber: r.from, to: r.to,
        numberHistory: r.history.map(h => ({ number: h.number, allocatedAt: new Date(h.allocatedAt).toISOString(), status: h.status })),
      }
      writeSync(backup, `${JSON.stringify(line)}\n`)
    }
    fsyncSync(backup)
  } finally {
    closeSync(backup)
  }

  const res: YearlessApplyResult = { written: 0, raced: 0 }
  for (const r of plan.rename) {
    const history = [...r.history]
    if (!history.some(h => h.number === r.from)) history.push({ number: r.from, allocatedAt: r.heldSince, status: r.status })
    history.push({ number: r.to, allocatedAt: now, status: r.status })
    try {
      const w = await Invoice.updateOne({ _id: r.id, orgId, invoiceNumber: r.from }, { $set: { invoiceNumber: r.to, numberHistory: history } }).exec()
      if (w.modifiedCount === 1) res.written++
      else res.raced++
    } catch (e: any) {
      // The unique key on an org's numbers: someone took the year-less number since the plan was read.
      if (e?.code !== 11000) throw e
      res.raced++
    }
  }
  return res
}

export interface YearlessRestoreResult {
  lines: number
  restored: number
  /** The document no longer holds the number the run gave it (or is gone): left as it is. */
  skipped: number
}

/** Put a backup's numbers back. A document that has moved on since the run keeps what it has. */
export async function restoreYearNumbers(orgId: string, backupPath: string, opts: { execute?: boolean } = {}): Promise<YearlessRestoreResult> {
  const res: YearlessRestoreResult = { lines: 0, restored: 0, skipped: 0 }
  const rl = createInterface({ input: createReadStream(backupPath, 'utf8'), crlfDelay: Infinity })
  for await (const text of rl) {
    if (!text.trim()) continue
    const line = JSON.parse(text) as YearlessBackupLine
    res.lines++
    const filter = { _id: line._id, orgId, invoiceNumber: line.to }
    if (!opts.execute) {
      if (await Invoice.exists(filter)) res.restored++
      else res.skipped++
      continue
    }
    const history = line.numberHistory.map(h => ({ number: h.number, allocatedAt: new Date(h.allocatedAt), status: h.status }))
    try {
      const w = await Invoice.updateOne(filter, { $set: { invoiceNumber: line.invoiceNumber, numberHistory: history } }).exec()
      if (w.modifiedCount === 1) res.restored++
      else res.skipped++
    } catch (e: any) {
      if (e?.code !== 11000) throw e
      res.skipped++
    }
  }
  return res
}
