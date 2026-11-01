/**
 * The audited import of a fenced export (FR-20.84, FR-20.51, plan step P3-6e, second half): a person
 * asks for it on the Servers page, and global's tick brings the replaced server's work into the books.
 *
 * - **Kept as it was** (Прил. 42): a document new to lgrai.app is inserted with its own id, number,
 *   dates and content. An invoice also gets `importedFrom`: the source (the server, the promotion,
 *   the export), the method, when, and who asked. What the site's documents point at that stays
 *   behind (its journal entries, the stock movements its sales made) is dropped, and lgrai.app books
 *   each document itself, as it would have:
 *   - an issued sale: its stock, below zero if need be (the goods left), its journal entry, its
 *     payments' entries, and the orders it fulfils;
 *   - a till sale: its stock; its till session, imported with it, is journaled at its close;
 *   - a stock movement of its own (a delivery, a transfer, a write-off): confirmed here;
 *   - documents and their files, put where their rows say; the site's audit trail.
 * - **All or nothing per document**: a sale whose stock cannot be booked is taken out again, and listed.
 * - **Never overwritten, never deleted**: a document lgrai.app already has (changed on both sides), a
 *   deletion, a sale naming what lgrai.app does not hold, and every kind not listed here are left for a
 *   person, each with its reason.
 * - ⚠ **A legal number lgrai.app gave to another document** is not imported here: that collision is
 *   resolved by a credit note and a re-issue, never by an edit (FR-20.51). A draft's number is no legal
 *   number: a draft whose number is taken gets the next one, and keeps the site's in `importedFrom`.
 * - **Numbering continues above** every number imported (`ensureSequenceAtLeast`), the УНП included.
 * - **Resumable**: one row per document (`fenced_import_items`), written when it is done, and every
 *   booking checks what it would create first: a crash, a restart or another pod repeats nothing.
 */
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { mongo } from 'mongoose'
import { mongoose } from 'db/connection'
import { FencedExport, FencedImportItem, Invoice, StockMovement } from 'db/models'
import { assertHomeIsHere } from 'db/home/home'
import { getRepos } from '../../context.js'
import { logger } from '../../logger/logger.js'
import { postInvoiceJournal, postPaymentJournal, postPosSessionJournal } from '../../events/handlers.js'
import { createAuditEntry, recordAuditEntry } from '../audit-log.service.js'
import { createInvoiceStockMovement, getNextMovementNumber } from '../invoicing.service.js'
import { draftSequenceKeyFor, getNextDraftInvoiceNumber, sequenceKeyFor } from '../invoice-numbering.service.js'
import { syncOrderForInvoice } from '../reservation.service.js'
import { ensureSequenceAtLeast } from '../sequence.service.js'
import { confirmMovement } from '../warehouse.service.js'
import { normalizeStored, resolveStored } from '../files/stored-path.js'
import { idKey } from '../replication/pages.js'
import { fencedExportPath, readFencedExport, type FencedItem } from './fenced-export.service.js'
import { MoveError } from './move.service.js'

type ObjectId = mongo.ObjectId
type Doc = Record<string, any>

/** Documents a tick handles at most; the next one goes on. */
export const IMPORT_BATCH = 200
/** How long one process holds an import before another may take it over. */
export const IMPORT_LEASE_MS = 2 * 60_000

const MASTER = ['contacts', 'productcategories', 'products', 'warehouses', 'tags']
/** In this order: what a sale names before the sale, a session before its sales, the files with their rows. */
const PHASES: string[][] = [MASTER, ['possessions'], ['invoices'], ['stockmovements'], ['docfiles', 'files'], ['auditlogs']]
const IMPORTED = new Set(PHASES.flat())
/** A sale that moves money or goods once issued. */
const DEAD = new Set(['voided', 'cancelled', 'converted'])

const oid = (v: unknown) => new mongoose.Types.ObjectId(String(v)) as unknown as ObjectId
const db = () => mongoose.connection.db as any
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex')
const EJSON = mongoose.mongo.BSON.EJSON
const same = (a: unknown, b: unknown) => EJSON.stringify(a as any, { relaxed: false }) === EJSON.stringify(b as any, { relaxed: false })
/**
 * A document's id as the import's rows and the review name it: an ObjectId's hex, a string as it is.
 * ⚠ Not `idKey`, whose `o:` prefix is the replication's own: a session posted under it, or a review
 * looking a sale up by its hex, would find nothing.
 */
export const keyOf = (id: unknown): string => ((id as any)?._bsontype === 'ObjectId' ? String(id) : typeof id === 'string' ? id : idKey(id))
/** A movement that moved stock on the site: `confirmMovement` leaves `completed`, older ones say `confirmed`. */
const APPLIED = new Set(['completed', 'confirmed'])

export interface Outcome {
  outcome: 'imported' | 'skipped' | 'failed'
  reason?: string
  detail?: string
  number?: string
}
const imported = (reason?: string, number?: string, detail?: string): Outcome => ({ outcome: 'imported', ...(reason ? { reason } : {}), ...(number ? { number } : {}), ...(detail ? { detail } : {}) })
const skipped = (reason: string, detail?: string, number?: string): Outcome => ({ outcome: 'skipped', reason, ...(detail ? { detail: detail.slice(0, 2000) } : {}), ...(number ? { number } : {}) })
const failed = (detail: string, number?: string): Outcome => ({ outcome: 'failed', reason: 'booking_failed', detail: detail.slice(0, 2000), ...(number ? { number } : {}) })

/**
 * One import run. `runId` is what its rows carry (`fenced_import_items.exportId`): the export's id, or
 * the re-seed's (P3-7g, `kept-import.service.ts`). `source` is what the documents it brings in say they
 * came from (`importedFrom`, with when and who).
 */
export interface Ctx {
  orgId: string
  org: ObjectId
  runId: ObjectId
  source: { kind: 'fenced_export'; exportId: ObjectId; moveId: ObjectId; nodeId: string } | { kind: 'reseed_kept'; moveId: ObjectId; nodeId: string }
  by: string
  at: Date
}

/** A document this run brought in, on an earlier tick or before a crash. */
function isOurs(from: any, ctx: Ctx): boolean {
  if (from?.kind !== ctx.source.kind) return false
  return ctx.source.kind === 'fenced_export' ? String(from.exportId) === String(ctx.source.exportId) : String(from.moveId) === String(ctx.source.moveId)
}
/** The filter that matches only what this run brought in: an undo never takes anything else. */
function oursFilter(ctx: Ctx): Record<string, unknown> {
  return ctx.source.kind === 'fenced_export'
    ? { 'importedFrom.exportId': ctx.source.exportId }
    : { 'importedFrom.kind': 'reseed_kept', 'importedFrom.moveId': ctx.source.moveId }
}
/** Where the documents came from, as the audit trail says it. */
function sourceText(ctx: Ctx): string {
  return ctx.source.kind === 'fenced_export'
    ? `fenced export of ${ctx.source.nodeId} (promotion ${String(ctx.source.moveId)})`
    : `kept by the re-seed ${String(ctx.source.moveId)} on ${ctx.source.nodeId}`
}

// ── What is imported, and what stays for a person ──────────────────────────────────────────────

/** How lgrai.app books a sale once it is in: as `/send`, `/receive` or the till would have. */
export function bookingOf(doc: Doc): 'none' | 'sale' | 'bill' | 'register' {
  if (doc.status === 'draft' || DEAD.has(String(doc.status)) || doc.type === 'proforma') return 'none'
  // FR-23: a payment's receipt books nothing. Its invoice comes in with the stock, the entry and the
  // payment row; `createInvoiceStockMovement` below would dispatch its lines a second time.
  if (doc.type === 'payment_receipt') return 'none'
  if (doc.type === 'cash_sale' || doc.type === 'cash_storno') return 'register'
  return doc.direction === 'incoming' ? 'bill' : 'sale'
}

/** What a sale names that lgrai.app must hold before it can be booked: its customer, its goods and stores. */
async function missingFor(org: ObjectId, doc: Doc): Promise<string | null> {
  const need: Array<[string, unknown]> = []
  if (doc.contactId) need.push(['contacts', doc.contactId])
  for (const l of doc.lines ?? []) {
    if (l?.productId) need.push(['products', l.productId])
    if (l?.warehouseId) need.push(['warehouses', l.warehouseId])
  }
  if (doc.register?.warehouseId) need.push(['warehouses', doc.register.warehouseId])
  for (const [coll, id] of need) {
    if (!(await db().collection(coll).findOne({ _id: id, orgId: org }, { projection: { _id: 1 } }))) return `${coll} ${keyOf(id)}`
  }
  return null
}

/** `INV-2026-00042` → its year and running number. */
function seriesPart(number: unknown): { year: number; n: number } | null {
  const m = /-(\d{4})-(\d+)$/.exec(String(number ?? ''))
  return m ? { year: Number(m[1]), n: Number(m[2]) } : null
}

/** Numbering goes on above every number imported: lgrai.app never issues one of them again. */
async function continueSeries(orgId: string, doc: Doc): Promise<void> {
  const part = seriesPart(doc.invoiceNumber)
  const key = doc.status === 'draft' ? draftSequenceKeyFor(doc.type, doc.direction) : sequenceKeyFor(doc.type, doc.direction)
  if (part && key) await ensureSequenceAtLeast(orgId, key, part.year, part.n)
  // The УНП: `<device>-<operator>-<number>`, counted per device.
  const unp = /^([^-]{8})-[^-]+-(\d+)$/.exec(String(doc.register?.unp ?? ''))
  if (unp) await ensureSequenceAtLeast(orgId, `UNP-${unp[1]}`, 0, Number(unp[2]))
}

/** A site's sale as lgrai.app keeps it: every field as written, without what pointed at what stays behind. */
function asKept(doc: Doc, ctx: Ctx, number?: string): Doc {
  const out: Doc = { ...doc }
  delete out.journalEntryId
  delete out.leaseUntil
  if (Array.isArray(out.payments)) out.payments = out.payments.map((p: Doc) => { const q = { ...p }; delete q.journalEntryId; return q })
  if (out.register) {
    out.register = { ...out.register }
    delete out.register.movementId
    delete out.register.stockError
    // FR-23: a receipt whose request died on the site. Its device stayed behind and its lease did not
    // travel, so nothing here could ever finish it, and its hold would lock its invoice. A person
    // settles it, as anything that cannot be proved.
    if (out.type === 'payment_receipt' && !out.completedAt && out.register.fiscal?.state === 'pending') {
      out.register.fiscal = { ...out.register.fiscal, state: 'unknown', inDoubt: true }
    }
  }
  if (out.issue) {
    out.issue = { ...out.issue }
    delete out.issue.leaseUntil
  }
  out.importedFrom = { ...ctx.source, at: ctx.at, by: oid(ctx.by), ...(number ? { number } : {}) }
  return out
}

// ── One document each ─────────────────────────────────────────────────────────────────────────

export async function importPlain(ctx: Ctx, coll: string, doc: Doc): Promise<Outcome> {
  const there = await db().collection(coll).findOne({ _id: doc._id }, { promoteValues: false })
  // Ours from an earlier tick, or the same document all along.
  if (there) return same(there, doc) ? imported('already_here') : skipped('same_id', 'lgrai.app holds this document, changed since the cutoff')
  try {
    await db().collection(coll).insertOne(doc)
  } catch (e: any) {
    if (e?.code === 11000) return skipped('unique_conflict', e?.message)
    throw e
  }
  return imported()
}

async function bookSale(ctx: Ctx, doc: Doc): Promise<void> {
  const kind = bookingOf(doc)
  if (kind === 'none') return
  const r = getRepos()
  const id = String(doc._id)
  const entity: any = await r.invoices.findOne({ id, orgId: ctx.orgId } as any)
  // Stock, once: the goods left the shop, so below zero if lgrai.app's count says otherwise.
  if (!(await StockMovement.exists({ orgId: ctx.org, invoiceId: doc._id }).exec())) {
    await createInvoiceStockMovement(entity, ctx.by, r, { allowNegative: true })
  }
  if (kind === 'register') {
    const m: any = await StockMovement.findOne({ orgId: ctx.org, invoiceId: doc._id }, { _id: 1 }).lean().exec()
    if (m) await Invoice.collection.updateOne({ _id: doc._id } as any, { $set: { 'register.movementId': m._id } })
    // Its journal entry is its till session's, posted at the session's close.
    return
  }
  await syncOrderForInvoice(ctx.orgId, entity, ctx.by)
  // #171: an invoice for a cash sale books nothing of its own; the cash sale carries it.
  if (doc.cashSaleRef?.cashSaleId) return
  if (kind === 'sale') {
    const fresh: any = await Invoice.collection.findOne({ _id: doc._id } as any, { projection: { journalEntryId: 1 } })
    if (!fresh?.journalEntryId) await postInvoiceJournal({ orgId: ctx.orgId, invoiceId: id, userId: ctx.by })
  }
  for (const p of doc.payments ?? []) {
    if (p?._id) await postPaymentJournal({ orgId: ctx.orgId, invoiceId: id, paymentId: String(p._id), userId: ctx.by })
  }
}

export async function importSale(ctx: Ctx, doc: Doc): Promise<Outcome> {
  const number = String(doc.invoiceNumber ?? '')
  /** The other document of this number, when the number was issued twice (AC 51). */
  let clashed: string | null = null
  const there: any = await Invoice.collection.findOne({ _id: doc._id } as any, { projection: { importedFrom: 1, invoiceNumber: 1, numberClash: 1 } })
  if (there && !isOurs(there.importedFrom, ctx)) return skipped('same_id', 'lgrai.app holds this document, changed since the cutoff', number)
  if (!there) {
    const missing = await missingFor(ctx.org, doc)
    if (missing) return skipped('missing_reference', `it names ${missing}, which lgrai.app does not hold`, number)
    let kept = asKept(doc, ctx)
    // The document that holds this number here, a pair's second never being one.
    const clash: any = await Invoice.collection.findOne({ orgId: ctx.org, invoiceNumber: number, _id: { $ne: doc._id }, 'numberClash.withId': { $exists: false } } as any, { projection: { _id: 1 } })
    if (clash) {
      if (doc.status !== 'draft') {
        // ⚠ FR-20.51, AC 51: a legal number issued twice. Both exist on paper, so both are in the
        // books: this one keeps its number, flagged with the other, and the later of the two is
        // annulled by a credit note and re-issued (`number-clash.service.ts`), never edited here.
        kept = { ...kept, numberClash: { withId: clash._id, withNumber: number, source: ctx.source.kind, at: ctx.at } }
        clashed = String(clash._id)
      } else {
        const next = await getNextDraftInvoiceNumber(ctx.orgId, doc.direction, doc.type)
        if (!next) return skipped('number_taken', `no draft series for ${doc.type}`, number)
        kept = { ...asKept(doc, ctx, number), invoiceNumber: next }
      }
    }
    try {
      await Invoice.collection.insertOne(kept as any)
    } catch (e: any) {
      // Before migration 0010 the key holds one document per number; or a pair already holds it.
      if (e?.code === 11000 && /invoiceNumber/.test(String(e?.message))) return skipped('number_taken', `lgrai.app gave ${number} to another document`, number)
      throw e
    }
    await continueSeries(ctx.orgId, kept)
    createAuditEntry({
      orgId: ctx.orgId, userId: ctx.by, action: 'import', module: 'invoicing', entityType: 'invoice', entityId: String(doc._id), entityName: String(kept.invoiceNumber),
      changes: [
        { field: 'source', oldValue: null, newValue: sourceText(ctx) },
        ...(clashed ? [{ field: 'numberClash', oldValue: null, newValue: `${number} was issued twice: also ${clashed}` }] : []),
      ],
    })
  }
  try {
    await bookSale(ctx, doc)
  } catch (e: any) {
    // All or nothing: a sale that cannot be booked goes back to the export, and is listed.
    if (!(await StockMovement.exists({ orgId: ctx.org, invoiceId: doc._id }).exec())) {
      await Invoice.collection.deleteOne({ _id: doc._id, ...oursFilter(ctx) } as any)
    }
    return failed(e?.message ?? String(e), number)
  }
  if (clashed) return imported('number_clash', number, `${number} is also ${clashed}: the later is annulled by a credit note and re-issued`)
  // A run cut short after this one came in: its flag says so.
  if (there?.numberClash?.withId) return imported('number_clash', number, `${number} is also ${String(there.numberClash.withId)}: the later is annulled by a credit note and re-issued`)
  return imported(undefined, number)
}

export async function importSession(ctx: Ctx, doc: Doc): Promise<Outcome> {
  const kept = { ...doc }
  // Posted here at its close, from the sales imported with it.
  delete kept.journalEntryId
  const there = await db().collection('possessions').findOne({ _id: doc._id }, { promoteValues: false })
  if (there) return same(there, kept) ? imported('already_here') : skipped('same_id', 'lgrai.app holds this session, changed since the cutoff')
  await db().collection('possessions').insertOne(kept)
  return imported(undefined, undefined, doc.status === 'closed' ? 'closed' : undefined)
}

export async function importMovement(ctx: Ctx, doc: Doc): Promise<Outcome> {
  // Made by a sale: the sale's import books it again here, or the sale stayed behind with it.
  if (doc.invoiceId) return skipped('made_by_its_sale', `the stock of ${keyOf(doc.invoiceId)}`, String(doc.movementNumber ?? ''))
  const there: any = await StockMovement.collection.findOne({ _id: doc._id } as any, { projection: { importedFrom: 1, status: 1 } })
  if (there && !isOurs(there.importedFrom, ctx)) return skipped('same_id', 'lgrai.app holds this movement, changed since the cutoff')
  // Applied on the site, so applied here: inserted as a draft, then confirmed against lgrai.app's stock.
  const confirm = APPLIED.has(String(doc.status))
  if (!there) {
    const kept: Doc = { ...doc, status: confirm ? 'draft' : doc.status, importedFrom: { ...ctx.source, at: ctx.at, by: oid(ctx.by) } }
    delete kept.journalEntryId
    const taken = await StockMovement.collection.findOne({ orgId: ctx.org, movementNumber: doc.movementNumber, _id: { $ne: doc._id } } as any, { projection: { _id: 1 } })
    // A movement number is no legal number: one lgrai.app has since used is given the next.
    if (taken) {
      kept.movementNumber = await getNextMovementNumber(ctx.orgId, getRepos())
      kept.importedFrom.number = doc.movementNumber
    }
    await StockMovement.collection.insertOne(kept as any)
  }
  if (confirm && (!there || there.status === 'draft')) {
    try {
      await confirmMovement(String(doc._id), getRepos())
    } catch (e: any) {
      await StockMovement.collection.deleteOne({ _id: doc._id, status: 'draft', ...oursFilter(ctx) } as any)
      return failed(e?.message ?? String(e), String(doc.movementNumber ?? ''))
    }
  }
  return imported(undefined, String(doc.movementNumber ?? ''))
}

/** A document row and its bytes, put where the row says; a file there with other bytes is not overwritten. */
async function importDocument(ctx: Ctx, coll: string, doc: Doc, bytes: Map<string, Buffer>): Promise<Outcome> {
  const stored = coll === 'docfiles' ? doc.currentPath : doc.storagePath
  const local = coll === 'docfiles' ? doc.archived !== true : (doc.storageProvider ?? 'local') === 'local'
  let note: string | undefined
  if (local && typeof stored === 'string') {
    const rel = normalizeStored(stored)
    const abs = resolveStored(rel, ctx.orgId)
    const content = bytes.get(rel)
    if (existsSync(abs)) {
      if (content && sha(Buffer.from(await Bun.file(abs).arrayBuffer())) !== sha(content)) return skipped('file_conflict', `${rel} holds other bytes on lgrai.app`)
    } else if (content) {
      await mkdir(dirname(abs), { recursive: true })
      await writeFile(abs, content)
    } else {
      note = 'without_file'
    }
  }
  const o = await importPlain(ctx, coll, doc)
  return o.outcome === 'imported' && note ? { ...o, reason: note } : o
}

// ── The run ──────────────────────────────────────────────────────────────────────────────────

export async function record(ctx: Ctx, coll: string, docKey: string, o: Outcome, sessionKey?: string): Promise<void> {
  await FencedImportItem.updateOne(
    { exportId: ctx.runId, coll, docKey },
    {
      $setOnInsert: {
        orgId: ctx.org, outcome: o.outcome, ...(o.reason ? { reason: o.reason } : {}), ...(o.detail ? { detail: o.detail } : {}), ...(o.number ? { number: o.number } : {}),
        ...(sessionKey ? { sessionKey } : {}), at: new Date(),
      },
    },
    { upsert: true },
  )
}

async function* itemsOf(row: any): AsyncGenerator<FencedItem> {
  const gen = readFencedExport(fencedExportPath(String(row.orgId), String(row.moveId)), { orgId: String(row.orgId), moveId: String(row.moveId) })
  for (;;) {
    const r = await gen.next()
    if (r.done) return
    yield r.value
  }
}

/** One batch of an import: up to `budget` documents not done yet, phase by phase. True when none is left. */
export async function runImportBatch(row: any, budget = IMPORT_BATCH): Promise<{ processed: number; finished: boolean }> {
  // ⚠ The writes below are raw: they hold only while the org is written HERE. The request was
  // home-gated, but the org may have moved since; then nothing is written, and the error says why.
  await assertHomeIsHere(row.orgId, { fresh: true })
  const ctx: Ctx = {
    orgId: String(row.orgId), org: row.orgId, runId: row._id,
    source: { kind: 'fenced_export', exportId: row._id, moveId: row.moveId, nodeId: row.nodeId },
    by: String(row.import.requestedBy), at: new Date(),
  }
  const done = new Set((await FencedImportItem.find({ exportId: row._id }, { coll: 1, docKey: 1 }).lean()).map((i: any) => `${i.coll}|${i.docKey}`))
  let processed = 0
  const handle = async (coll: string, docKey: string, run: () => Promise<Outcome>, sessionKey?: string) => {
    const o = await run()
    await record(ctx, coll, docKey, o, sessionKey)
    done.add(`${coll}|${docKey}`)
    processed++
  }
  for (const phase of PHASES) {
    const files = phase.includes('docfiles')
    const rows: Array<{ coll: string; doc: Doc }> = []
    const bytes = new Map<string, Buffer>()
    for await (const it of itemsOf(row)) {
      if (it.kind === 'file') {
        if (files) bytes.set(it.path, it.bytes)
        continue
      }
      if (it.kind !== 'doc' || !phase.includes(it.coll) || done.has(`${it.coll}|${keyOf(it.doc._id)}`)) continue
      if (files) {
        // A row waits for the files section, which comes after every document.
        if (rows.length < budget - processed) rows.push({ coll: it.coll, doc: it.doc })
        continue
      }
      if (processed >= budget) return { processed, finished: false }
      const key = keyOf(it.doc._id)
      if (it.coll === 'invoices') await handle(it.coll, key, () => importSale(ctx, it.doc), it.doc.register?.sessionId ? keyOf(it.doc.register.sessionId) : undefined)
      else if (it.coll === 'possessions') await handle(it.coll, key, () => importSession(ctx, it.doc))
      else if (it.coll === 'stockmovements') await handle(it.coll, key, () => importMovement(ctx, it.doc))
      else await handle(it.coll, key, () => importPlain(ctx, it.coll, it.doc))
    }
    for (const r of rows) await handle(r.coll, keyOf(r.doc._id), () => importDocument(ctx, r.coll, r.doc, bytes))
    if (processed >= budget) return { processed, finished: false }
  }
  // What is not imported here, each listed with why: deletions and the kinds a person brings in.
  const left: Array<{ coll: string; key: string; o: Outcome }> = []
  for await (const it of itemsOf(row)) {
    if (it.kind === 'deleted') {
      const key = `deleted:${keyOf(it.id)}`
      if (!done.has(`${it.coll}|${key}`)) left.push({ coll: it.coll, key, o: skipped('deletion', 'a deletion is never applied by an import') })
    } else if (it.kind === 'doc' && !IMPORTED.has(it.coll) && !done.has(`${it.coll}|${keyOf(it.doc._id)}`)) {
      left.push({ coll: it.coll, key: keyOf(it.doc._id), o: skipped('not_imported_kind', `${it.coll} is brought in by a person`) })
    }
  }
  for (const l of left) {
    await record(ctx, l.coll, l.key, l.o)
    processed++
  }
  return { processed, finished: true }
}

/**
 * A run's end: the till sessions journaled from the sales imported with them, and the counts. Shared
 * with the re-seed's kept import (P3-7g).
 */
export async function finishRun(orgId: string, runId: ObjectId, by: string): Promise<Record<string, number>> {
  const sessions = await FencedImportItem.find({ exportId: runId, coll: 'possessions', outcome: 'imported', detail: 'closed' }, { docKey: 1 }).lean()
  for (const s of sessions as any[]) {
    // Only once every sale of it is here: an entry over part of a day would be wrong for good.
    const behind = await FencedImportItem.exists({ exportId: runId, coll: 'invoices', outcome: { $ne: 'imported' }, sessionKey: s.docKey })
    if (behind) {
      await FencedImportItem.updateOne({ _id: s._id }, { $set: { reason: 'session_not_journaled', detail: 'closed; some of its sales stayed behind, so its journal entry waits for a person' } })
      continue
    }
    await postPosSessionJournal({ orgId, sessionId: s.docKey, userId: by })
  }
  const counts: Record<string, number> = {}
  for (const c of await FencedImportItem.aggregate([{ $match: { exportId: runId } }, { $group: { _id: { o: '$outcome', r: '$reason' }, n: { $sum: 1 } } }])) {
    counts[`${c._id.o}${c._id.r ? `:${c._id.r}` : ''}`] = c.n
  }
  return counts
}

/** The import's end: the sessions and counts (`finishRun`), and the trail. */
async function finishImport(row: any): Promise<Record<string, number>> {
  const by = String(row.import.requestedBy)
  const counts = await finishRun(String(row.orgId), row._id, by)
  await recordAuditEntry({
    orgId: String(row.orgId), userId: by, action: 'import', module: 'admin', entityType: 'fenced_export', entityId: String(row._id), entityName: `from ${row.nodeId}`,
    changes: Object.entries(counts).map(([field, n]) => ({ field, oldValue: null, newValue: n })),
  })
  return counts
}

/** Global's tick: one batch of one import, under a lease. */
export async function fencedImportTick(now = new Date()): Promise<number> {
  const row: any = await FencedExport.findOneAndUpdate(
    { 'import.state': { $in: ['requested', 'running'] }, $or: [{ 'import.leaseUntil': { $exists: false } }, { 'import.leaseUntil': null }, { 'import.leaseUntil': { $lt: now } }] },
    { $set: { 'import.state': 'running', 'import.leaseUntil': new Date(now.getTime() + IMPORT_LEASE_MS) }, $min: { 'import.startedAt': now } },
    { new: true },
  ).lean()
  if (!row) return 0
  try {
    const r = await runImportBatch(row)
    if (!r.finished) {
      await FencedExport.updateOne({ _id: row._id }, { $set: { 'import.leaseUntil': null } })
      return r.processed
    }
    const counts = await finishImport(row)
    await FencedExport.updateOne({ _id: row._id }, { $set: { 'import.state': 'done', 'import.doneAt': new Date(), 'import.counts': counts, 'import.leaseUntil': null }, $unset: { 'import.error': '' } })
    logger.warn({ orgId: String(row.orgId), exportId: String(row._id), counts }, 'Fenced import: what the replaced server did after the cutoff is in the books, the rest listed for a person')
    return r.processed + 1
  } catch (e: any) {
    logger.error({ orgId: String(row.orgId), exportId: String(row._id), err: e?.message ?? String(e) }, 'Fenced import: a batch failed; it goes on at the next tick')
    await FencedExport.updateOne({ _id: row._id }, { $set: { 'import.error': String(e?.message ?? e).slice(0, 2000), 'import.leaseUntil': null } })
    return 0
  }
}

/** A person asks for the import of a received export. Once: the tick does the rest. */
export async function requestFencedImport(orgId: string, exportId: string, by: { id: string; operatorCode?: string }) {
  if (!/^[0-9a-f]{24}$/.test(exportId)) throw new MoveError(404, 'not_found', 'No such export.')
  const row: any = await FencedExport.findOne({ _id: oid(exportId), orgId: oid(orgId) }).lean()
  if (!row) throw new MoveError(404, 'not_found', 'No such export.')
  if (row.state !== 'received') throw new MoveError(409, 'not_received', 'Only a received export, checked whole, is imported.')
  const now = new Date()
  const r = await FencedExport.updateOne({ _id: row._id, 'import.state': { $exists: false } }, { $set: { import: { state: 'requested', requestedBy: oid(by.id), requestedAt: now } } })
  if (!r.modifiedCount) throw new MoveError(409, 'already_imported', 'This export\'s import was already asked for.')
  await recordAuditEntry({ orgId, userId: by.id, operatorCode: by.operatorCode, action: 'import', module: 'admin', entityType: 'fenced_export', entityId: exportId, entityName: `from ${row.nodeId}`, changes: [{ field: 'import', oldValue: null, newValue: 'requested' }] })
  return FencedExport.findById(row._id).lean()
}

/** What the import did with each sale of an export: for the review's list. */
export async function importOutcomes(exportId: unknown): Promise<Map<string, { outcome: string; reason?: string; detail?: string }>> {
  const rows: any[] = await FencedImportItem.find({ exportId, coll: 'invoices' }, { docKey: 1, outcome: 1, reason: 1, detail: 1 }).lean()
  return new Map(rows.map(r => [r.docKey, { outcome: r.outcome, ...(r.reason ? { reason: r.reason } : {}), ...(r.detail ? { detail: r.detail } : {}) }]))
}
