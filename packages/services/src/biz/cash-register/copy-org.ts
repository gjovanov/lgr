/**
 * FR-21.21 / FR-21.22 — every POS transaction of an org becomes its cash-register document (§5.3).
 *
 * Migration `0008-cash-register-copy` runs this per org, and so does a restore of a bundle taken
 * before R2. Five steps, each safe to run again:
 *
 * 1. **Preflight.** Blockers stop the org before anything is written; warnings are reported.
 *    `scripts/cash-register-preflight.ts` prints the same report and writes nothing.
 * 2. **Copy.** `postransactions` in batches of 500, each row inserted by its `_id` only if absent,
 *    through the one mapping (`mapping.ts#fromPosTransaction`), each copy validated by the model
 *    before the raw insert.
 * 3. **Link.** A row's `movementId` movement gets `invoiceId = _id`, where it has none.
 * 4. **Backfill** `register.origin` on the org's other cash sales (§3.2): `import` for a till day
 *    (tagged, `salesAnalysis:<date>`, or committed by Files), `backoffice` otherwise.
 * 5. **Parity.** Every copy against its row, every session and day, and SUPTO 18.1–18.5 cell for
 *    cell. Any mismatch throws: a migration that throws is not recorded, so it runs again.
 *
 * ⚠ Raw driver writes (listed in `home-write-guard.flow.test.ts`): each org's home is asserted
 * first (FR-20.4). The replication capture is a change stream, so a master journals them anyway.
 */
import type { mongo } from 'mongoose'
import { Invoice } from 'db/models'
import { assertHomeIsHere } from 'db/home/home'
import { CashRegisterMappingError, exchangeRateFor, fromPosTransaction, toPosTransaction } from './mapping.js'
import { REGISTER_TYPES } from './pos-union.js'
import { keptByMethod, posRowSign } from './counting.js'
import { BULGARIAN_TIME_ZONE } from '../local-day.js'

type Db = mongo.Db
type Log = (message: string, extra?: Record<string, unknown>) => void

const BATCH = 500
const round2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100
const cents = (n: unknown) => Math.round((Number(n) || 0) * 100)
const oid = (v: unknown) => new Invoice.base.Types.ObjectId(String(v))
const DAY_FORMAT = new Intl.DateTimeFormat('en-CA', { timeZone: BULGARIAN_TIME_ZONE })
const day = (d: unknown) => DAY_FORMAT.format(new Date(d as any))

export interface PreflightIssue {
  code: string
  message: string
  /** The rows (or sessions, days) it is about; capped. */
  ids?: string[]
}

export interface PreflightReport {
  orgId: string
  /** POS rows in the org, and how many already have their document. */
  rows: number
  copied: number
  blockers: PreflightIssue[]
  warnings: PreflightIssue[]
}

const CAP = 20
const issue = (code: string, message: string, ids: unknown[] = []): PreflightIssue =>
  ({ code, message, ...(ids.length ? { ids: ids.slice(0, CAP).map(String) } : {}) })

/** What would stop the copy of one org, and what it would merely report (§5.3 step 1). */
export async function cashRegisterPreflight(db: Db, orgId: string): Promise<PreflightReport> {
  const org = oid(orgId)
  const pos = db.collection('postransactions')
  const invoices = db.collection('invoices')
  const blockers: PreflightIssue[] = []
  const warnings: PreflightIssue[] = []

  const rows: any[] = await pos.find({ orgId: org }, {
    projection: {
      type: 1, status: 1, sessionId: 1, transactionNumber: 1, clientKey: 1, originalTransactionId: 1,
      unpNumber: 1, payments: 1, stockError: 1, createdAt: 1,
    },
  }).toArray()

  // The terminal never sends a return or an exchange: a human decides what they were (§6 edge 7).
  const odd = rows.filter(r => r.type !== 'sale' && r.type !== 'storno')
  if (odd.length) blockers.push(issue('return_exchange_rows', `${odd.length} POS row(s) are a return or an exchange, which has no cash-register document`, odd.map(r => r._id)))

  // The ids and numbers the copies would take.
  const ids = rows.map(r => r._id)
  const present: any[] = []
  for (let i = 0; i < ids.length; i += BATCH) {
    present.push(...await invoices.find({ _id: { $in: ids.slice(i, i + BATCH) } }, { projection: { type: 1, 'register.legacy': 1 } }).toArray())
  }
  const isCopy = (d: any) => REGISTER_TYPES.includes(d.type) && d.register?.legacy?.source === 'postransactions'
  const foreign = present.filter(d => !isCopy(d))
  if (foreign.length) blockers.push(issue('id_taken', `${foreign.length} POS row id(s) already belong to another document`, foreign.map(d => d._id)))
  const copiedIds = new Set(present.filter(isCopy).map(d => String(d._id)))

  const numbers = rows.map(r => r.transactionNumber).filter(Boolean)
  const byNumber: any[] = []
  for (let i = 0; i < numbers.length; i += BATCH) {
    byNumber.push(...await invoices.find({ orgId: org, invoiceNumber: { $in: numbers.slice(i, i + BATCH) } }, { projection: { invoiceNumber: 1 } }).toArray())
  }
  const rowByNumber = new Map(rows.map(r => [r.transactionNumber, String(r._id)]))
  const takenNumbers = byNumber.filter(d => rowByNumber.get(d.invoiceNumber) !== String(d._id))
  if (takenNumbers.length) blockers.push(issue('number_taken', `${takenNumbers.length} POS number(s) are already another document's number`, takenNumbers.map(d => d.invoiceNumber)))

  const keyed = rows.filter(r => r.clientKey)
  if (keyed.length) {
    const sameKey: any[] = await invoices.find({ orgId: org, clientKey: { $in: keyed.map(r => r.clientKey) } }, { projection: { clientKey: 1 } }).toArray()
    const rowByKey = new Map(keyed.map(r => [r.clientKey, String(r._id)]))
    const clash = sameKey.filter(d => rowByKey.get(d.clientKey) !== String(d._id))
    if (clash.length) blockers.push(issue('key_in_both', `${clash.length} Idempotency-Key(s) are on a POS row and on another document`, clash.map(d => d.clientKey)))
  }

  const rowIds = new Set(rows.map(r => String(r._id)))
  const originals = [...new Set(rows.filter(r => r.type === 'storno' && r.originalTransactionId).map(r => String(r.originalTransactionId)))]
  const missingOriginals = originals.filter(id => !rowIds.has(id))
  const docOriginals = missingOriginals.length
    ? new Set((await invoices.find({ _id: { $in: missingOriginals.map(oid) }, orgId: org }, { projection: { _id: 1 } }).toArray()).map(d => String(d._id)))
    : new Set<string>()
  const orphans = missingOriginals.filter(id => !docOriginals.has(id))
  const noOriginal = rows.filter(r => r.type === 'storno' && !r.originalTransactionId)
  if (orphans.length || noOriginal.length) {
    blockers.push(issue('storno_original_missing', `${orphans.length + noOriginal.length} storno(s) point at a sale that does not exist`, [...orphans, ...noOriginal.map(r => r._id)]))
  }

  const sessionIds = [...new Set(rows.map(r => String(r.sessionId)))]
  const sessions: any[] = sessionIds.length
    ? await db.collection('possessions').find({ _id: { $in: sessionIds.filter(s => Invoice.base.Types.ObjectId.isValid(s)).map(oid) }, orgId: org }, { projection: { currency: 1 } }).toArray()
    : []
  const sessionById = new Map(sessions.map(s => [String(s._id), s]))
  const sessionless = rows.filter(r => !sessionById.has(String(r.sessionId)))
  if (sessionless.length) blockers.push(issue('session_missing', `${sessionless.length} POS row(s) belong to no session of this org`, sessionless.map(r => r._id)))

  const orgDoc: any = await db.collection('orgs').findOne({ _id: org }, { projection: { 'settings.baseCurrency': 1 } })
  const base = orgDoc?.settings?.baseCurrency
  const unmapped = sessions.filter(s => exchangeRateFor(s.currency, base) === null)
  if (unmapped.length) blockers.push(issue('currency_unmapped', `${unmapped.length} session(s) are in a currency with no fixed rate to ${base || 'the base currency'}`, unmapped.map(s => s._id)))

  // Warnings: reported, never blocking.
  const byUnp = new Map<string, number>()
  for (const r of rows) if (r.unpNumber) byUnp.set(r.unpNumber, (byUnp.get(r.unpNumber) || 0) + 1)
  const duplicateUnps = [...byUnp].filter(([, n]) => n > 1).map(([u]) => u)
  if (duplicateUnps.length) warnings.push(issue('duplicate_unp', `${duplicateUnps.length} УНП(s) are on more than one POS row`, duplicateUnps))
  const legacyMethods = rows.filter(r => (r.payments || []).some((p: any) => p.method === 'mobile' || p.method === 'voucher'))
  if (legacyMethods.length) warnings.push(issue('legacy_payment_methods', `${legacyMethods.length} POS row(s) were paid by mobile or voucher; reports count them as "other"`, legacyMethods.map(r => r._id)))
  const stockErrors = rows.filter(r => r.stockError)
  if (stockErrors.length) warnings.push(issue('stock_error', `${stockErrors.length} POS row(s) recorded stock that did not move`, stockErrors.map(r => r._id)))
  const posOut = await db.collection('stockmovements').countDocuments({ orgId: org, movementNumber: { $regex: '^POS-OUT-' } })
  if (posOut) warnings.push(issue('pos_out', `${posOut} POS-OUT batch movement(s) exist; migration 0006 marks them record-only`))

  // A parallel run (§6 edge 6): a day with till sales AND an imported till day counts the goods twice.
  const tillDays = new Set(rows.filter(r => r.type === 'sale').map(r => day(r.createdAt)))
  if (tillDays.size) {
    const imported: any[] = await invoices.find({
      orgId: org, type: 'cash_sale',
      $or: [{ 'register.origin': 'import' }, { tags: 'cash-register-import' }, { reference: { $regex: '^salesAnalysis:' } }],
    }, { projection: { issueDate: 1 } }).toArray()
    const both = [...new Set(imported.map(d => day(d.issueDate)))].filter(d => tillDays.has(d)).sort()
    if (both.length) warnings.push(issue('parallel_run', `${both.length} day(s) have till sales and an imported till day: the same goods counted twice`, both))
  }

  return { orgId, rows: rows.length, copied: copiedIds.size, blockers, warnings }
}

export class CashRegisterCopyError extends Error {
  constructor(public orgId: string, public problems: string[]) {
    super(`org ${orgId}: ${problems.slice(0, 5).join('; ')}${problems.length > 5 ? ` (+${problems.length - 5} more)` : ''}`)
    this.name = 'CashRegisterCopyError'
  }
}

export interface CopyStats {
  copied: number
  linked: number
  origins: { import: number; backoffice: number }
}

/** Steps 2 and 3: every POS row of the org without a document gets its copy; its movement is linked. */
export async function copyPosRows(db: Db, orgId: string): Promise<{ copied: number; linked: number }> {
  await assertHomeIsHere(orgId)
  const org = oid(orgId)
  const pos = db.collection('postransactions')
  const invoices = db.collection('invoices')
  const orgDoc: any = await db.collection('orgs').findOne({ _id: org }, { projection: { 'settings.baseCurrency': 1 } })
  const baseCurrency = orgDoc?.settings?.baseCurrency
  const sessions = new Map<string, any>()
  let copied = 0
  let linked = 0

  const flush = async (rows: any[]) => {
    if (!rows.length) return
    const have = new Set((await invoices.find({ _id: { $in: rows.map(r => r._id) } }, { projection: { _id: 1 } }).toArray()).map(d => String(d._id)))
    const todo = rows.filter(r => !have.has(String(r._id)))

    const wanted = [...new Set(todo.map(r => String(r.sessionId)))].filter(s => !sessions.has(s) && Invoice.base.Types.ObjectId.isValid(s))
    if (wanted.length) {
      for (const s of await db.collection('possessions').find({ _id: { $in: wanted.map(oid) }, orgId: org }).toArray()) sessions.set(String(s._id), s)
    }
    const sales = todo.filter(r => r.type === 'sale').map(r => r._id)
    const stornoedBy = new Map<string, unknown[]>()
    if (sales.length) {
      for (const s of await pos.find({ orgId: org, type: 'storno', status: 'completed', originalTransactionId: { $in: sales } }, { projection: { originalTransactionId: 1 } }).toArray()) {
        const k = String(s.originalTransactionId)
        stornoedBy.set(k, [...(stornoedBy.get(k) || []), s._id])
      }
    }
    const productIds = [...new Set(todo.flatMap(r => (r.lines || []).map((l: any) => l.productId)).filter(Boolean).map(String))]
    const units = new Map<string, string>()
    if (productIds.length) {
      for (const p of await db.collection('products').find({ orgId: org, _id: { $in: productIds.map(oid) } }, { projection: { unit: 1 } }).toArray()) {
        if (p.unit) units.set(String(p._id), String(p.unit))
      }
    }

    const docs = todo.map(row => {
      const doc = fromPosTransaction(row, sessions.get(String(row.sessionId)), {
        baseCurrency,
        unitOf: productId => units.get(String(productId)),
        stornoedBy: stornoedBy.get(String(row._id)),
      })
      // The model checks every copy before the raw write: a mapping that broke the schema stops here.
      const invalid = new Invoice(doc).validateSync()
      if (invalid) throw new CashRegisterCopyError(orgId, [`${row.transactionNumber}: ${invalid.message}`])
      return doc
    })
    // ⚠ Each copy against its row BEFORE it is written: a copy is read instead of its row from then
    // on, and one that is wrong is skipped by every later run (it is "already copied").
    const wrong = docs.flatMap((doc, i) => rowDifferences(todo[i], doc))
    if (wrong.length) throw new CashRegisterCopyError(orgId, wrong)
    if (docs.length) {
      try {
        const res = await db.collection('invoices').insertMany(docs, { ordered: false })
        copied += res.insertedCount
      } catch (e: any) {
        // A copy made in the meantime (a storno or a keyed retry copies one on the spot) is the same
        // document. Anything else is not.
        const errors: any[] = e?.writeErrors ?? []
        if (e?.code !== 11000 && !errors.length) throw e
        if (errors.some(w => (w.code ?? w.err?.code) !== 11000 || !/_id_/.test(String(w.errmsg ?? w.err?.errmsg ?? '')))) throw e
        copied += e?.result?.insertedCount ?? e?.insertedCount ?? 0
      }
    }

    const links = rows.filter(r => r.movementId).map(r => ({
      updateOne: { filter: { _id: r.movementId, orgId: org, invoiceId: { $exists: false } }, update: { $set: { invoiceId: r._id } } },
    }))
    if (links.length) linked += (await db.collection('stockmovements').bulkWrite(links, { ordered: false })).modifiedCount
  }

  let batch: any[] = []
  for await (const row of pos.find({ orgId: org }).sort({ _id: 1 })) {
    batch.push(row)
    if (batch.length >= BATCH) {
      await flush(batch)
      batch = []
    }
  }
  await flush(batch)
  return { copied, linked }
}

/** Step 4: where each of the org's other cash sales came from (§3.2), for those that do not say. */
export async function backfillCashSaleOrigin(db: Db, orgId: string): Promise<{ import: number; backoffice: number }> {
  await assertHomeIsHere(orgId)
  const org = oid(orgId)
  const invoices = db.collection('invoices')
  const committed = new Set<string>()
  for await (const f of db.collection('docfiles').find({ orgId: org, committedTarget: 'invoice', 'committedIds.0': { $exists: true } }, { projection: { committedIds: 1 } })) {
    for (const id of f.committedIds || []) committed.add(String(id))
  }
  const out = { import: 0, backoffice: 0 }
  let ops: any[] = []
  const flush = async () => {
    if (ops.length) await db.collection('invoices').bulkWrite(ops, { ordered: false })
    ops = []
  }
  // Read first, then write: a cursor over the documents being updated could meet one twice.
  const todo = await invoices.find(
    { orgId: org, type: 'cash_sale', 'register.origin': { $exists: false } },
    { projection: { tags: 1, reference: 1 } },
  ).toArray()
  for (const d of todo) {
    const imported = (d.tags || []).includes('cash-register-import') || /^salesAnalysis:/.test(d.reference || '') || committed.has(String(d._id))
    const origin = imported ? 'import' : 'backoffice'
    out[origin]++
    ops.push({ updateOne: { filter: { _id: d._id, 'register.origin': { $exists: false } }, update: { $set: { 'register.origin': origin } } } })
    if (ops.length >= BATCH) await flush()
  }
  await flush()
  return out
}

// ── Step 5: parity ───────────────────────────────────────────────────────────

const netLine = (l: any) => cents(l.lineTotal)
const idOr = (v: unknown) => (v ? String(v) : '')
/**
 * ⚠ Every field the aggregates and the SUPTO cells below read, so that a copy which passes
 * `rowDifferences` before its insert cannot fail parity after it. A copy that failed only then was
 * already written, every later run skipped it as copied, and 0008 failed on every start.
 */
const rowKey = (t: any) => JSON.stringify([
  String(t._id), t.transactionNumber, t.type, t.status, new Date(t.createdAt).getTime(),
  t.unpNumber || '', t.fiscalReceiptNumber || '', t.fiscalDeviceNumber || '',
  cents(t.subtotal), cents(t.discountTotal), cents(t.taxTotal), cents(t.total), cents(t.changeDue),
  idOr(t.originalTransactionId), idOr(t.movementId), idOr(t.sessionId), idOr(t.customerId),
  t.originalUNP || '', t.originalFiscalReceiptNumber || '',
  t.originalTransactionDate ? new Date(t.originalTransactionDate).getTime() : '', t.stornoReason || '',
])

/** The payments SUPTO 18.2 prints, each with its amount in cents and its reference. */
function tenderedCents(t: any): string {
  return JSON.stringify((t.payments || []).map((p: any) => [p.method, cents(p.amount), p.reference || '']).sort())
}

function linesKey(t: any): string {
  return JSON.stringify((t.lines || []).map((l: any) => [
    l.productId ? String(l.productId) : '', l.name, l.quantity, cents(l.unitPrice), l.discount || 0, cents(l.taxAmount), netLine(l), l.taxRate || 0,
  ]))
}

/** One row against its copy read back as a row: the differences, or nothing. */
function rowDifferences(row: any, copy: any): string[] {
  const back = toPosTransaction(copy)
  const out: string[] = []
  const label = row.transactionNumber || String(row._id)
  if (rowKey(row) !== rowKey(back)) out.push(`${label}: header ${rowKey(row)} ≠ ${rowKey(back)}`)
  // The time of a stornoed sale's cancellation, which 18.5 prints as "Cancelled".
  if (row.status === 'cancelled' && new Date(row.updatedAt).getTime() !== new Date(back.updatedAt).getTime()) out.push(`${label}: cancelled at ${row.updatedAt} ≠ ${back.updatedAt}`)
  if (tenderedCents(row) !== tenderedCents(back)) out.push(`${label}: payments ${tenderedCents(row)} ≠ ${tenderedCents(back)}`)
  if (linesKey(row) !== linesKey(back)) out.push(`${label}: lines ${linesKey(row)} ≠ ${linesKey(back)}`)
  if (copy.register?.origin !== 'pos') out.push(`${label}: origin ${copy.register?.origin}`)
  return out
}

/** Σ per session, per day: count, total, kept per method, net per VAT rate — signed as readers count. */
function aggregates(rows: any[]): Map<string, string> {
  const acc = new Map<string, { n: number; total: number; cash: number; card: number; other: number; vat: Map<number, number> }>()
  const add = (k: string, t: any) => {
    const sign = posRowSign(t)
    const a = acc.get(k) ?? { n: 0, total: 0, cash: 0, card: 0, other: 0, vat: new Map() }
    a.n++
    a.total += sign * cents(t.total)
    const kept = keptByMethod(t)
    a.cash += sign * cents(kept.cash)
    a.card += sign * cents(kept.card)
    a.other += sign * cents(kept.other)
    for (const l of t.lines || []) a.vat.set(l.taxRate || 0, (a.vat.get(l.taxRate || 0) || 0) + sign * netLine(l))
    acc.set(k, a)
  }
  for (const t of rows) {
    add(`session ${String(t.sessionId)}`, t)
    add(`day ${day(t.createdAt)}`, t)
  }
  return new Map([...acc].map(([k, a]) => [k, JSON.stringify([a.n, a.total, a.cash, a.card, a.other, [...a.vat].sort()])]))
}

/** The cells SUPTO 18.1–18.5 print for these rows — `reporting/excel/supto.excel.ts` reads exactly these. */
function suptoCells(rows: any[]): Record<string, string[]> {
  const t181 = rows.filter(t => t.type === 'sale').map(t => JSON.stringify([
    t.unpNumber || '', t.transactionNumber, t.type, t.status, new Date(t.createdAt).getTime(), t.fiscalDeviceNumber || '',
    t.fiscalReceiptNumber || '', cents(t.subtotal), cents(t.discountTotal), cents(t.taxTotal), cents(t.total), t.customerId ? String(t.customerId) : '',
  ]))
  const t182 = rows.flatMap(t => (t.payments || []).map((p: any) => JSON.stringify([
    t.unpNumber || '', t.transactionNumber, cents(t.total), p.method, cents(p.amount), p.reference || '', t.fiscalDeviceNumber || '',
  ])))
  const t183 = rows.filter(t => t.type === 'sale').flatMap(t => (t.lines || []).map((l: any) => JSON.stringify([
    t.unpNumber || '', t.transactionNumber, l.productId ? String(l.productId) : '', l.name, l.quantity,
    cents(l.unitPrice), l.discount || 0, l.taxRate || 0, cents(l.taxAmount), netLine(l),
  ])))
  const t184 = rows.filter(t => t.type === 'storno').flatMap(t => (t.lines || []).map((l: any) => JSON.stringify([
    t.unpNumber || '', t.transactionNumber, t.originalUNP || '', t.originalFiscalReceiptNumber || '',
    t.originalTransactionDate ? new Date(t.originalTransactionDate).getTime() : '', t.stornoReason || '',
    t.fiscalReceiptNumber || '', cents(t.total), l.name, l.quantity, cents(l.unitPrice),
  ])))
  const t185 = rows.filter(t => t.status === 'cancelled').flatMap(t => (t.lines || []).map((l: any) => JSON.stringify([
    t.unpNumber || '', t.transactionNumber, t.type, new Date(t.updatedAt).getTime(), cents(t.total), l.name, l.quantity, cents(l.unitPrice),
  ])))
  return { '18.1': t181.sort(), '18.2': t182.sort(), '18.3': t183.sort(), '18.4': t184.sort(), '18.5': t185.sort() }
}

/**
 * Step 5: what differs between what the readers read before the copy and after it. Empty when
 * nothing does.
 *
 * Before, a reader read a row's copy where it had one, and the row elsewhere. They agree except in
 * one way, and on purpose: a sale stornoed under R2 before this ran was copied on the spot and
 * stornoed as the copy — its frozen row still says `completed`. That row is read as the copy reads
 * it; anything else that differs is a mismatch.
 */
export async function cashRegisterParity(db: Db, orgId: string): Promise<string[]> {
  const org = oid(orgId)
  const rows: any[] = await db.collection('postransactions').find({ orgId: org }).toArray()
  if (!rows.length) return []
  const copies: any[] = []
  for (let i = 0; i < rows.length; i += BATCH) {
    copies.push(...await db.collection('invoices').find({ _id: { $in: rows.slice(i, i + BATCH).map(r => r._id) } }).toArray())
  }
  const copyById = new Map(copies.map(d => [String(d._id), d]))

  // The stornos R2 wrote (documents, not copies of a POS row), of copied sales whose row knows nothing of them.
  const reversedByR2 = new Set<string>()
  const candidates = rows.filter(r => r.status === 'completed' && copyById.get(String(r._id))?.register?.stornoState === 'full')
  if (candidates.length) {
    const stornoIds = candidates.flatMap(r => copyById.get(String(r._id)).register.stornoedBy || [])
    const stornos: any[] = stornoIds.length
      ? await db.collection('invoices').find({ _id: { $in: stornoIds }, type: 'cash_storno', status: 'paid' }, { projection: { relatedInvoiceId: 1, 'register.legacy': 1 } }).toArray()
      : []
    for (const st of stornos) if (!st.register?.legacy) reversedByR2.add(String(st.relatedInvoiceId))
  }
  const asReadBefore = (row: any) => {
    const copy = copyById.get(String(row._id))
    return reversedByR2.has(String(row._id)) ? { ...row, status: 'cancelled', updatedAt: copy.register.cancelledAt } : row
  }

  const problems: string[] = []
  for (const row of rows) {
    const copy = copyById.get(String(row._id))
    if (!copy) problems.push(`${row.transactionNumber}: no copy`)
    else problems.push(...rowDifferences(asReadBefore(row), copy))
  }
  if (problems.length) return problems

  const read = rows.map(asReadBefore)
  const back = rows.map(r => toPosTransaction(copyById.get(String(r._id))))
  const before = aggregates(read)
  const after = aggregates(back)
  for (const [k, v] of before) if (after.get(k) !== v) problems.push(`${k}: ${v} ≠ ${after.get(k)}`)
  for (const k of after.keys()) if (!before.has(k)) problems.push(`${k}: appeared`)

  const cellsBefore = suptoCells(read)
  const cellsAfter = suptoCells(back)
  for (const table of Object.keys(cellsBefore)) {
    if (JSON.stringify(cellsBefore[table]) !== JSON.stringify(cellsAfter[table])) {
      problems.push(`SUPTO ${table}: ${cellsBefore[table].length} cell row(s) before, ${cellsAfter[table].length} after, and they differ`)
    }
  }
  return problems
}

/**
 * The whole per-org copy: preflight (throws on a blocker), copy, link, backfill, parity (throws on
 * a mismatch). What migration 0008 and a restore run.
 */
export async function copyCashRegisterOrg(db: Db, orgId: string, log: Log = () => {}): Promise<CopyStats & { report: PreflightReport }> {
  const report = await cashRegisterPreflight(db, orgId)
  for (const w of report.warnings) log(`org ${orgId}: ${w.message}`, { code: w.code, ids: w.ids })
  if (report.blockers.length) throw new CashRegisterCopyError(orgId, report.blockers.map(b => `${b.message}${b.ids ? ` (${b.ids.slice(0, 5).join(', ')})` : ''}`))
  const { copied, linked } = await copyPosRows(db, orgId)
  const origins = await backfillCashSaleOrigin(db, orgId)
  const problems = await cashRegisterParity(db, orgId)
  if (problems.length) throw new CashRegisterCopyError(orgId, problems)
  log(`org ${orgId}: ${copied} POS row(s) copied (${report.copied} already were), ${linked} movement(s) linked, origins backfilled: ${origins.import} import, ${origins.backoffice} back office`)
  return { copied, linked, origins, report }
}

export { CashRegisterMappingError }
