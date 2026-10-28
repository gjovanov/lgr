/**
 * What a re-seed kept, brought into the books on the server (FR-20.71, FR-20.51; plan step P3-7g).
 *
 * A re-seed replaces the org's data here with lgrai.app's copy, and keeps everything this server held
 * before it, for good, under the org's tree (`docs/reseed/<move>.ndjson.zst`). What the copy lacked is
 * only in that file: work this server did after its database went back, which lgrai.app never got.
 * Issued sales among it are legal records: a till printed them, a customer holds them. They must
 * not vanish. An org's admin asks once, on the server's status page, and the tick brings them in by
 * the fenced import's rules (`fenced-import.service.ts`):
 *
 * - **Brought in**, each with `importedFrom {kind: 'reseed_kept', moveId, …}`:
 *   - every issued sale only in the kept copy, kept as it was and booked here as it would have been:
 *     its stock (below zero if need be), its journal entry, its payments' entries;
 *   - the till sessions they name;
 *   - stock movements of their own that moved stock (a delivery, a transfer, a write-off);
 *   - the contacts, products, product categories and stores these name, when they are only in the
 *     kept copy. ⚠ Only those named. Nothing in the app hard-deletes them, so one that is named is new
 *     work. One that nothing names could also be one a raw script deleted, and it is listed instead.
 * - **Left for a person**, each with why:
 *   - a sale whose number the copy gave to another document (resolved by a credit note and a
 *     re-issue, never here);
 *   - a draft, which can be deleted, so it may have been;
 *   - everything else only in the kept copy, counted by kind.
 * - **Never overwritten**: what the copy holds is the org's now. A document in both is not touched.
 *
 * Resumable: one row per document (`fenced_import_items`, the re-seed's id as its run), and every booking
 * checks what it would create first. Kept on the server (`NodeState` `kept-import:<moveId>`).
 */
import { existsSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { mongo } from 'mongoose'
import { config } from 'config'
import { mongoose } from 'db/connection'
import { FencedImportItem, NodeState } from 'db/models'
import { assertHomeIsHere, thisNode } from 'db/home/home'
import { logger } from '../../logger/logger.js'
import { recordAuditEntry } from '../audit-log.service.js'
import { finishRun, importMovement, importPlain, importSale, importSession, keyOf, record, type Ctx, type Outcome } from './fenced-import.service.js'
import { readMoveBundle } from './move-bundle.js'
import { MoveError } from './move.service.js'

type ObjectId = mongo.ObjectId
type Doc = Record<string, any>

/** How long one run holds an import before another tick may take it over (a crash). */
export const KEPT_LEASE_MS = 10 * 60_000
/** The documents a person is shown per kind; the rest are counted. */
const LISTED_MAX = 500

/** What a kept sale or movement may name, imported when only the kept copy has it. */
const NAMED = ['productcategories', 'warehouses', 'contacts', 'products']
/** Read from the kept copy into memory when only it has them: the import's candidates. */
const CANDIDATES = new Set([...NAMED, 'possessions', 'invoices', 'stockmovements'])
/** A movement that moved stock on the site: `confirmMovement` leaves `completed`, older ones say `confirmed`. */
const APPLIED = new Set(['completed', 'confirmed'])
const ID_BATCH = 1000

const oid = (v: unknown) => new mongoose.Types.ObjectId(String(v)) as unknown as ObjectId
const db = () => mongoose.connection.db as any
const stateKey = (moveId: string) => `kept-import:${moveId}`
const keptDir = (orgId: string) => join(config.upload.dir, orgId, 'docs', 'reseed')
const keptFile = (orgId: string, moveId: string) => join(keptDir(orgId), `${moveId}.ndjson.zst`)
const isId = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{24}$/.test(v)

export interface KeptImportState {
  orgId: string
  state: 'requested' | 'running' | 'done'
  requestedBy: string
  requestedAt: Date
  startedAt?: Date
  doneAt?: Date
  leaseUntil?: Date | null
  counts?: Record<string, number>
  /** Only in the kept copy and not brought in, by kind: what a person looks at in the file. */
  keptOnly?: Record<string, number>
  error?: string
}

async function stateOf(moveId: string): Promise<KeptImportState | null> {
  const row: any = await NodeState.findById(stateKey(moveId)).lean()
  return row?.value?.state ? (row.value as KeptImportState) : null
}

/** The re-seeds of this org whose kept copy is on this server, newest first, with what they kept and their import. */
export async function keptOf(orgId: string) {
  if (!isId(orgId)) return []
  let names: string[] = []
  try {
    names = await readdir(keptDir(orgId))
  } catch {
    return []
  }
  const out: any[] = []
  for (const name of names) {
    const m = /^([0-9a-f]{24})\.ndjson\.zst$/.exec(name)
    if (!m) continue
    const moveId = m[1]
    const phase: any = (await NodeState.findById(`move:${moveId}`).lean())?.value ?? null
    const st = await stateOf(moveId)
    const left: any[] = st
      ? await FencedImportItem.find({ exportId: oid(moveId), outcome: { $ne: 'imported' } }, { coll: 1, docKey: 1, outcome: 1, reason: 1, detail: 1, number: 1 }).sort({ coll: 1, docKey: 1 }).limit(LISTED_MAX).lean()
      : []
    out.push({
      moveId,
      at: phase?.at ?? null,
      // Only a re-seed that finished replaced the data; an aborted one put back what it held.
      done: phase?.phase === 'active',
      kept: phase?.kept ? { documents: phase.kept.documents ?? 0, onlyThere: phase.kept.onlyThere ?? 0, sales: phase.kept.sales ?? 0, salesNumbers: phase.kept.salesNumbers ?? [] } : null,
      import: st ? { state: st.state, requestedAt: st.requestedAt, doneAt: st.doneAt ?? null, counts: st.counts ?? null, keptOnly: st.keptOnly ?? null, error: st.error ?? null } : null,
      left: left.map(l => ({ coll: l.coll, docKey: l.docKey, outcome: l.outcome, reason: l.reason ?? null, detail: l.detail ?? null, number: l.number ?? null })),
    })
  }
  return out.sort((a, b) => String(b.at ?? '').localeCompare(String(a.at ?? '')))
}

/** An org's admin asks, once, for a finished re-seed's kept sales to be brought into the books here. */
export async function requestKeptImport(orgId: string, moveId: string, by: { id: string; operatorCode?: string }) {
  if (!isId(orgId) || !isId(moveId) || !existsSync(keptFile(orgId, moveId))) throw new MoveError(404, 'not_found', 'No such kept copy here.')
  const phase: any = (await NodeState.findById(`move:${moveId}`).lean())?.value ?? null
  if (phase?.phase !== 'active') throw new MoveError(409, 'not_reseeded', 'Only a finished re-seed replaced the data; this one holds nothing to bring in.')
  await assertHomeIsHere(orgId, { fresh: true })
  const now = new Date()
  const value: KeptImportState = { orgId, state: 'requested', requestedBy: by.id, requestedAt: now }
  try {
    await NodeState.create({ _id: stateKey(moveId), value } as any)
  } catch (e: any) {
    if (e?.code === 11000) throw new MoveError(409, 'already_imported', 'This kept copy\'s import was already asked for.')
    throw e
  }
  await recordAuditEntry({ orgId, userId: by.id, operatorCode: by.operatorCode, action: 'import', module: 'admin', entityType: 'org_move', entityId: moveId, entityName: 'kept by the re-seed', changes: [{ field: 'import', oldValue: null, newValue: 'requested' }] })
  return value
}

// ── The run ──────────────────────────────────────────────────────────────────────────────────

/**
 * The ids among `ids` this org's data holds now, in `coll`. One this run brought in on an earlier pass
 * is not counted as held: it stays a candidate, so a run cut short finishes it and records it.
 */
async function presentNow(coll: string, ids: unknown[], moveId: string): Promise<Set<string>> {
  const out = new Set<string>()
  for (let i = 0; i < ids.length; i += ID_BATCH) {
    const rows: any[] = await db().collection(coll).find({ _id: { $in: ids.slice(i, i + ID_BATCH) } }, { projection: { _id: 1, importedFrom: 1 } }).toArray()
    for (const r of rows) {
      const ours = r.importedFrom?.kind === 'reseed_kept' && String(r.importedFrom.moveId) === moveId
      if (!ours) out.add(keyOf(r._id))
    }
  }
  return out
}

/** What only the kept copy holds: the candidates, whole, and the rest counted by kind. */
async function onlyInKept(path: string, moveId: string): Promise<{ docs: Map<string, Map<string, Doc>>; counts: Record<string, number> }> {
  const docs = new Map<string, Map<string, Doc>>()
  const counts: Record<string, number> = {}
  let coll = ''
  let batch: Doc[] = []
  const flush = async () => {
    if (!batch.length) return
    const here = await presentNow(coll, batch.map(d => d._id), moveId)
    for (const d of batch) {
      if (here.has(keyOf(d._id))) continue
      if (CANDIDATES.has(coll)) {
        if (!docs.has(coll)) docs.set(coll, new Map())
        docs.get(coll)!.set(keyOf(d._id), d)
      } else {
        counts[coll] = (counts[coll] ?? 0) + 1
      }
    }
    batch = []
  }
  const it = readMoveBundle(path)
  for (;;) {
    const r = await it.next()
    if (r.done) break
    if (r.value.kind !== 'doc') continue
    if (r.value.coll !== coll || batch.length >= ID_BATCH) {
      await flush()
      coll = r.value.coll
    }
    batch.push(r.value.doc)
  }
  await flush()
  return { docs, counts }
}

/** The ids a kept sale or movement names, by kind, among what may be imported with it. */
function named(doc: Doc, into: Map<string, Set<string>>): void {
  const add = (coll: string, id: unknown) => {
    if (id === undefined || id === null) return
    if (!into.has(coll)) into.set(coll, new Set())
    into.get(coll)!.add(keyOf(id))
  }
  add('contacts', doc.contactId)
  add('warehouses', doc.fromWarehouseId)
  add('warehouses', doc.toWarehouseId)
  add('warehouses', doc.warehouseId)
  add('warehouses', doc.register?.warehouseId)
  for (const l of doc.lines ?? []) {
    add('products', l?.productId)
    add('warehouses', l?.warehouseId)
  }
}

/** A run over one kept copy, whole: resumable, since every document done has its row. */
async function runKept(moveId: string, st: KeptImportState): Promise<{ counts: Record<string, number>; keptOnly: Record<string, number> }> {
  const orgId = st.orgId
  // ⚠ The writes below are raw: they hold only while the org is written HERE.
  await assertHomeIsHere(orgId, { fresh: true })
  const runId = oid(moveId)
  const ctx: Ctx = { orgId, org: oid(orgId), runId, source: { kind: 'reseed_kept', moveId: runId, nodeId: thisNode() }, by: st.requestedBy, at: new Date() }
  const done = new Set(((await FencedImportItem.find({ exportId: runId }, { coll: 1, docKey: 1 }).lean()) as any[]).map(i => `${i.coll}|${i.docKey}`))
  const handle = async (coll: string, docKey: string, run: () => Promise<Outcome>, sessionKey?: string) => {
    if (done.has(`${coll}|${docKey}`)) return
    await record(ctx, coll, docKey, await run(), sessionKey)
    done.add(`${coll}|${docKey}`)
  }
  const { docs, counts: others } = await onlyInKept(keptFile(orgId, moveId), moveId)
  const only = (coll: string) => docs.get(coll) ?? new Map<string, Doc>()
  const keptOnly: Record<string, number> = { ...others }

  // What is brought in: the issued sales, their sessions, the movements that moved stock, and what they name.
  const sales = [...only('invoices').values()].filter(d => d.status !== 'draft')
  const movements = [...only('stockmovements').values()].filter(d => !d.invoiceId && APPLIED.has(String(d.status)))
  const wanted = new Map<string, Set<string>>()
  for (const d of [...sales, ...movements]) named(d, wanted)
  // A product brought in brings its category.
  for (const key of wanted.get('products') ?? []) {
    const p = only('products').get(key)
    if (p?.categoryId) {
      if (!wanted.has('productcategories')) wanted.set('productcategories', new Set())
      wanted.get('productcategories')!.add(keyOf(p.categoryId))
    }
  }
  for (const coll of NAMED) {
    for (const [key, doc] of only(coll)) {
      if (wanted.get(coll)?.has(key)) await handle(coll, key, () => importPlain(ctx, coll, doc))
      else keptOnly[coll] = (keptOnly[coll] ?? 0) + 1
    }
  }
  const sessions = new Set(sales.map(d => (d.register?.sessionId ? keyOf(d.register.sessionId) : '')).filter(Boolean))
  for (const [key, doc] of only('possessions')) {
    if (sessions.has(key)) await handle('possessions', key, () => importSession(ctx, doc))
    else keptOnly.possessions = (keptOnly.possessions ?? 0) + 1
  }
  for (const doc of sales) {
    await handle('invoices', keyOf(doc._id), () => importSale(ctx, doc), doc.register?.sessionId ? keyOf(doc.register.sessionId) : undefined)
  }
  // A draft can be deleted, so it may have been: a person decides, by its number.
  for (const doc of only('invoices').values()) {
    if (doc.status !== 'draft') continue
    await handle('invoices', keyOf(doc._id), async () => ({ outcome: 'skipped', reason: 'kept_draft', detail: 'a draft only in the kept copy', ...(doc.invoiceNumber ? { number: String(doc.invoiceNumber) } : {}) }))
  }
  for (const doc of movements) await handle('stockmovements', keyOf(doc._id), () => importMovement(ctx, doc))
  for (const doc of only('stockmovements').values()) {
    // Made by a sale: the sale's import books its stock again.
    if (doc.invoiceId || APPLIED.has(String(doc.status))) continue
    await handle('stockmovements', keyOf(doc._id), async () => ({ outcome: 'skipped', reason: 'kept_draft', detail: 'a movement that moved nothing on the site', ...(doc.movementNumber ? { number: String(doc.movementNumber) } : {}) }))
  }
  const counts = await finishRun(orgId, runId, st.requestedBy)
  return { counts, keptOnly }
}

let running = false

/** The server's tick: one requested kept import, run whole, under a lease. */
export async function keptImportTick(now = new Date()): Promise<number> {
  if (running) return 0
  running = true
  try {
    const row: any = await NodeState.findOneAndUpdate(
      {
        _id: { $regex: '^kept-import:' },
        'value.state': { $in: ['requested', 'running'] },
        $or: [{ 'value.leaseUntil': { $exists: false } }, { 'value.leaseUntil': null }, { 'value.leaseUntil': { $lt: now } }],
      },
      { $set: { 'value.state': 'running', 'value.leaseUntil': new Date(now.getTime() + KEPT_LEASE_MS) }, $min: { 'value.startedAt': now } },
      { new: true },
    ).lean()
    if (!row) return 0
    const moveId = String(row._id).slice('kept-import:'.length)
    const st = row.value as KeptImportState
    try {
      const { counts, keptOnly } = await runKept(moveId, st)
      await NodeState.updateOne({ _id: row._id }, { $set: { 'value.state': 'done', 'value.doneAt': new Date(), 'value.counts': counts, 'value.keptOnly': keptOnly, 'value.leaseUntil': null }, $unset: { 'value.error': '' } })
      await recordAuditEntry({
        orgId: st.orgId, userId: st.requestedBy, action: 'import', module: 'admin', entityType: 'org_move', entityId: moveId, entityName: 'kept by the re-seed',
        changes: Object.entries(counts).map(([field, n]) => ({ field, oldValue: null, newValue: n })),
      })
      logger.warn({ orgId: st.orgId, moveId, counts, keptOnly }, 'Kept import: what the re-seed kept is in the books here, the rest listed for a person')
      return 1
    } catch (e: any) {
      logger.error({ orgId: st.orgId, moveId, err: e?.message ?? String(e) }, 'Kept import: the run failed; it goes on at the next tick')
      await NodeState.updateOne({ _id: row._id }, { $set: { 'value.error': String(e?.message ?? e).slice(0, 2000), 'value.leaseUntil': null } })
      return 0
    }
  } finally {
    running = false
  }
}

/** Tests only. */
export const _keptFile = keptFile
