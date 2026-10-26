#!/usr/bin/env bun
/**
 * FR-21.14 (#171, spec §5.2, D-12): remove the `regal` org's March–April 2026 test sales before R2.
 *
 * After R2 these rows would become immutable cash-register documents. FR-13.44 forbids AUTOMATIC
 * pruning of `POSTransaction`; this is a one-time removal of test records by an explicit owner
 * decision (2026-10-21), with a backup, and §5.2 is its record.
 *
 *   bun scripts/remove-test-pos-sales.ts --org regal --from 2026-03-01 --to 2026-04-30
 *       the dry run: lists every row it would touch and every reason it would refuse.
 *   bun scripts/remove-test-pos-sales.ts --org regal --from 2026-03-01 --to 2026-04-30 \
 *       --execute --expect <sales from the dry run> [--backup <file.ndjson>] [--as <userId>]
 *
 * It refuses:
 * - any org but `regal`, and any node that is not the org's home (FR-20, P0b-6);
 * - when the org has POS rows OUTSIDE the window: the window is meant to hold the whole test
 *   history, and a row outside it may be a real sale;
 * - stornos, returns and exchanges in the window: reversing a reversal is not supported here;
 * - journal entries on a session or movement it would remove (no prod org keeps journals);
 * - `--execute` without `--expect`, or with a count that is not the dry run's.
 *
 * `--execute`, newest sale first:
 * 1. every touched document goes to the NDJSON backup BEFORE anything changes;
 * 2. a completed dispatch is reversed exactly — its quantities back on the StockLevel, its
 *    cost layers restored — and the movement is deleted;
 * 3. the row is deleted;
 * 4. its session, left without rows, is deleted with its POS-OUT batch movement (record-only).
 *    Every POS row of the org lies in the window (or the run refuses), so every session holding
 *    one loses all of them: no session keeps rows with reduced totals;
 * 5. the AuditLog stays append-only: one `cleanup` entry per removed document, nothing deleted.
 *
 * Counters (TXN, УНП) are left alone: TXN becomes a closed legacy series in R2, and a device's
 * УНП numbers are the device's.
 */
import { appendFileSync, writeFileSync } from 'node:fs'
import { mongoose } from '../packages/db/src/connection.js'
import { config } from '../packages/config/src/index.js'
import { AuditLog, CostLayer, JournalEntry, Org, POSSession, POSTransaction, StockLevel, StockMovement } from '../packages/db/src/models/index.js'
import { BULGARIAN_TIME_ZONE, isDateOnly, localDayEnd, localDayStart } from '../packages/services/src/biz/local-day.js'
import { assertScriptHome } from './lib/home-guard.js'

/** The only org this script may touch (D-12). */
export const ALLOWED_ORGS = ['regal']

const SALE_TYPES = ['sale']
const round2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100

export interface SaleRow {
  id: string
  number: string
  type: string
  status: string
  createdAt: Date
  total: number
  isFiscal: boolean
  device?: string
  unp?: string
  sessionId?: string
  movementId?: string
}

export interface MovementRow {
  id: string
  number: string
  type: string
  status: string
  warehouseId?: string
  /** `sale`: a sale's dispatch; `pos-out`: a closed session's record-only batch. */
  source: 'sale' | 'pos-out'
  lines: Array<{ productId: string; quantity: number; costAllocations: Array<{ costLayerId: string; quantity: number }> }>
}

export interface SessionRow {
  id: string
  number: string
  status: string
  /** Rows the session holds now, and how many of them go. */
  rows: number
  removed: number
  /** Every row goes, so the session goes too. A session that would keep rows stops the run. */
  deleted: boolean
  batchMovementId?: string
}

export interface StockRestore {
  productId: string
  warehouseId: string
  add: number
}

export interface CleanupPlan {
  org: { id: string; slug: string; ownerId?: string }
  timeZone: string
  window: { from: Date; to: Date }
  sales: SaleRow[]
  /** POS rows of the org outside the window — any one stops the run. */
  outside: SaleRow[]
  movements: MovementRow[]
  sessions: SessionRow[]
  journalEntries: Array<{ id: string; number?: string; status?: string; sourceModule?: string; sourceId?: string }>
  stock: StockRestore[]
  blockers: string[]
}

export class CleanupRefused extends Error {}

function saleRow(t: any): SaleRow {
  return {
    id: String(t._id),
    number: t.transactionNumber,
    type: t.type,
    status: t.status,
    createdAt: t.createdAt,
    total: round2(t.total),
    isFiscal: !!t.isFiscal,
    ...(t.fiscalDeviceNumber ? { device: t.fiscalDeviceNumber } : {}),
    ...(t.unpNumber ? { unp: t.unpNumber } : {}),
    ...(t.sessionId ? { sessionId: String(t.sessionId) } : {}),
    ...(t.movementId ? { movementId: String(t.movementId) } : {}),
  }
}

function movementRow(m: any, source: MovementRow['source']): MovementRow {
  return {
    id: String(m._id),
    number: m.movementNumber,
    type: m.type,
    status: m.status,
    ...(m.fromWarehouseId ? { warehouseId: String(m.fromWarehouseId) } : {}),
    source,
    lines: (m.lines || []).map((l: any) => ({
      productId: String(l.productId),
      quantity: Number(l.quantity) || 0,
      costAllocations: (l.costAllocations || []).map((a: any) => ({ costLayerId: String(a.costLayerId), quantity: Number(a.quantity) || 0 })),
    })),
  }
}

/** The dry run: every row the removal would touch, and every reason it would refuse. Writes nothing. */
export async function planTestSaleCleanup(o: { orgSlug: string; from: string; to: string }): Promise<CleanupPlan> {
  if (!ALLOWED_ORGS.includes(o.orgSlug)) {
    throw new CleanupRefused(`Refused: this one-off removes the test sales of ${ALLOWED_ORGS.join(', ')} only (D-12), not "${o.orgSlug}".`)
  }
  if (!isDateOnly(o.from) || !isDateOnly(o.to) || o.from > o.to) {
    throw new CleanupRefused(`Refused: --from and --to must be YYYY-MM-DD, from ≤ to (got ${o.from} … ${o.to}).`)
  }
  const org: any = await Org.findOne({ slug: o.orgSlug }, { _id: 1, slug: 1, ownerId: 1, settings: 1 }).lean().exec()
  if (!org) throw new CleanupRefused(`Refused: no org "${o.orgSlug}".`)
  const timeZone = org.settings?.timezone || BULGARIAN_TIME_ZONE
  const from = localDayStart(o.from, timeZone)
  const to = localDayEnd(o.to, timeZone)
  const orgId = org._id

  const inWindow = await POSTransaction.find({ orgId, createdAt: { $gte: from, $lte: to } }).sort({ createdAt: -1, _id: -1 }).lean().exec()
  const outside = await POSTransaction.find({ orgId, $or: [{ createdAt: { $lt: from } }, { createdAt: { $gt: to } }] })
    .sort({ createdAt: 1 }).lean().exec()

  // Each sale's dispatch: its `movementId`, or — before that was kept — the movement the sale's
  // note names.
  const movements: MovementRow[] = []
  const stockMap = new Map<string, StockRestore>()
  for (const t of inWindow as any[]) {
    const m: any = (t.movementId && await StockMovement.findOne({ _id: t.movementId, orgId }).lean().exec())
      || await StockMovement.findOne({ orgId, notes: `POS sale ${t.transactionNumber}` }).lean().exec()
    if (!m) continue
    if (!t.movementId) t.movementId = m._id
    const row = movementRow(m, 'sale')
    movements.push(row)
    if (m.status !== 'completed' || m.type !== 'dispatch' || !row.warehouseId) continue
    for (const l of row.lines) {
      const k = `${l.productId}:${row.warehouseId}`
      const s = stockMap.get(k) || { productId: l.productId, warehouseId: row.warehouseId, add: 0 }
      s.add = round2(s.add + l.quantity)
      stockMap.set(k, s)
    }
  }

  // Sessions: each one holding a removed row loses all of its rows, and goes.
  const sessions: SessionRow[] = []
  const bySession = new Map<string, any[]>()
  for (const t of inWindow as any[]) {
    const k = String(t.sessionId)
    if (!bySession.has(k)) bySession.set(k, [])
    bySession.get(k)!.push(t)
  }
  for (const [sid, rows] of bySession) {
    const s: any = await POSSession.findOne({ _id: sid, orgId }).lean().exec()
    if (!s) continue
    const total = await POSTransaction.countDocuments({ orgId, sessionId: s._id }).exec()
    const deleted = total === rows.length
    const row: SessionRow = {
      id: sid, number: s.sessionNumber, status: s.status, rows: total, removed: rows.length, deleted,
      ...(s.batchMovementId ? { batchMovementId: String(s.batchMovementId) } : {}),
    }
    sessions.push(row)
    if (deleted && s.batchMovementId) {
      const b: any = await StockMovement.findOne({ _id: s.batchMovementId, orgId }).lean().exec()
      if (b) movements.push(movementRow(b, 'pos-out'))
    }
  }

  // Journal entries on anything that goes. No prod org keeps journals, so any one stops the run.
  const sourceIds = [
    ...sessions.filter(s => s.deleted).map(s => s.id),
    ...movements.map(m => m.id),
  ].map(id => new (POSSession.base.Types.ObjectId)(id))
  const sessionJeIds = (await POSSession.find({ _id: { $in: sessions.filter(s => s.deleted).map(s => s.id) }, journalEntryId: { $exists: true } }, { journalEntryId: 1 }).lean().exec())
    .map((s: any) => s.journalEntryId)
  const jes: any[] = await JournalEntry.find({ orgId, $or: [{ sourceId: { $in: sourceIds } }, { _id: { $in: sessionJeIds } }] }, { entryNumber: 1, status: 1, sourceModule: 1, sourceId: 1 }).lean().exec()

  const sales = (inWindow as any[]).map(saleRow)
  const blockers: string[] = []
  if (outside.length) blockers.push(`${outside.length} POS row(s) of ${o.orgSlug} lie outside ${o.from} … ${o.to}; widen the window only if they are test sales too`)
  const notSales = sales.filter(s => !SALE_TYPES.includes(s.type))
  if (notSales.length) blockers.push(`${notSales.length} storno/return/exchange row(s) in the window: reversing a reversal is not supported here`)
  const kept = sessions.filter(s => !s.deleted)
  if (kept.length) blockers.push(`${kept.length} session(s) would keep rows outside this removal (${kept.map(s => s.number).join(', ')})`)
  if (jes.length) blockers.push(`${jes.length} journal entr(y/ies) rest on a session or movement that would go: void them first`)

  return {
    org: { id: String(orgId), slug: org.slug, ...(org.ownerId ? { ownerId: String(org.ownerId) } : {}) },
    timeZone,
    window: { from, to },
    sales,
    outside: (outside as any[]).map(saleRow),
    movements,
    sessions,
    journalEntries: jes.map(j => ({ id: String(j._id), number: j.entryNumber, status: j.status, sourceModule: j.sourceModule, sourceId: j.sourceId ? String(j.sourceId) : undefined })),
    stock: [...stockMap.values()],
    blockers,
  }
}

export interface CleanupResult {
  removed: { sales: number; movements: number; sessions: number; audits: number }
  verify: {
    rowsLeftInWindow: number
    stock: Array<StockRestore & { before: number; after: number; ok: boolean }>
    ok: boolean
  }
}

/**
 * Remove what `plan` lists. The plan is rebuilt by the caller right before, and `expectSales` is
 * the dry run's count: any difference refuses before anything is written.
 */
export async function executeTestSaleCleanup(
  plan: CleanupPlan,
  o: { expectSales: number; backupPath: string; userId?: string; at?: Date },
): Promise<CleanupResult> {
  if (plan.blockers.length) throw new CleanupRefused(`Refused: ${plan.blockers.join('; ')}.`)
  if (!Number.isInteger(o.expectSales) || o.expectSales !== plan.sales.length) {
    throw new CleanupRefused(`Refused: the dry run's count (--expect ${o.expectSales}) is not what the window holds now (${plan.sales.length}).`)
  }
  const userId = o.userId || plan.org.ownerId
  if (!userId) throw new CleanupRefused('Refused: no user to record the cleanup under (--as <userId>, or an org owner).')
  const at = o.at || new Date()
  const orgId = new (POSSession.base.Types.ObjectId)(plan.org.id)

  // 1. The backup, before anything changes: every document the run touches, one per line.
  const stockBefore = new Map<string, number>()
  writeFileSync(o.backupPath, `${JSON.stringify({ kind: 'header', fr: 'FR-21.14', org: plan.org, window: plan.window, at })}\n`)
  const backup = (collection: string, doc: any) => appendFileSync(o.backupPath, `${JSON.stringify({ collection, doc })}\n`)
  for (const s of plan.sales) backup('postransactions', await POSTransaction.findById(s.id).lean().exec())
  for (const m of plan.movements) backup('stockmovements', await StockMovement.findById(m.id).lean().exec())
  for (const s of plan.sessions) backup('possessions', await POSSession.findById(s.id).lean().exec())
  for (const r of plan.stock) {
    const level: any = await StockLevel.findOne({ orgId, productId: r.productId, warehouseId: r.warehouseId }).lean().exec()
    backup('stocklevels', level)
    stockBefore.set(`${r.productId}:${r.warehouseId}`, Number(level?.quantity) || 0)
  }
  const layerIds = plan.movements.flatMap(m => m.lines.flatMap(l => l.costAllocations.map(a => a.costLayerId)))
  for (const id of [...new Set(layerIds)]) backup('costlayers', await CostLayer.findById(id).lean().exec())

  const audit = (entityType: string, entityId: string, entityName: string, note: string) =>
    AuditLog.create({
      orgId, userId, action: 'cleanup', module: 'trade', entityType, entityId, entityName,
      changes: [{ field: 'removed', oldValue: entityName, newValue: `FR-21.14 (D-12): ${note}` }], timestamp: at,
    })
  let audits = 0
  let removedMovements = 0
  let removedSessions = 0

  // 2–3. Newest sale first: its dispatch reversed exactly, then the row gone.
  const movementBySale = new Map(plan.movements.filter(m => m.source === 'sale').map(m => [m.id, m]))
  for (const sale of plan.sales) {
    const m = sale.movementId ? movementBySale.get(sale.movementId) : undefined
    if (m) {
      if (m.status === 'completed' && m.type === 'dispatch' && m.warehouseId) {
        for (const l of m.lines) {
          await StockLevel.updateOne(
            { orgId, productId: l.productId, warehouseId: m.warehouseId },
            { $inc: { quantity: l.quantity, availableQuantity: l.quantity } },
          ).exec()
          for (const a of l.costAllocations) {
            await CostLayer.updateOne({ _id: a.costLayerId, orgId }, { $inc: { remainingQuantity: a.quantity }, $set: { isExhausted: false } }).exec()
          }
        }
      }
      await StockMovement.deleteOne({ _id: m.id, orgId }).exec()
      removedMovements++
      await audit('stock_movement', m.id, m.number, `the dispatch of test sale ${sale.number}, reversed and removed`)
      audits++
    }
    // FR-21.26: the model is frozen. The org's home was asserted before any write (assertScriptHome).
    await POSTransaction.collection.deleteOne({ _id: new mongoose.Types.ObjectId(String(sale.id)), orgId: new mongoose.Types.ObjectId(String(orgId)) })
    await audit('pos_transaction', sale.id, sale.number, `test sale of ${new Date(sale.createdAt).toISOString()} removed`)
    audits++
  }

  // 4. The sessions, left without rows, with their record-only POS-OUT batch.
  for (const s of plan.sessions) {
    if (s.batchMovementId) {
      const b = plan.movements.find(m => m.id === s.batchMovementId)
      await StockMovement.deleteOne({ _id: s.batchMovementId, orgId }).exec()
      removedMovements++
      await audit('stock_movement', s.batchMovementId, b?.number || s.batchMovementId, `the record-only POS-OUT batch of test session ${s.number} removed`)
      audits++
    }
    await POSSession.deleteOne({ _id: s.id, orgId }).exec()
    removedSessions++
    await audit('pos_session', s.id, s.number, 'a test session left without rows, removed')
    audits++
  }

  // Verify: nothing left in the window, and every restored level = before + what came back.
  const rowsLeftInWindow = await POSTransaction.countDocuments({ orgId, createdAt: { $gte: plan.window.from, $lte: plan.window.to } }).exec()
  const stock = []
  for (const r of plan.stock) {
    const level: any = await StockLevel.findOne({ orgId, productId: r.productId, warehouseId: r.warehouseId }).lean().exec()
    const before = stockBefore.get(`${r.productId}:${r.warehouseId}`) || 0
    const after = Number(level?.quantity) || 0
    stock.push({ ...r, before, after, ok: round2(after) === round2(before + r.add) })
  }
  return {
    removed: { sales: plan.sales.length, movements: removedMovements, sessions: removedSessions, audits },
    verify: { rowsLeftInWindow, stock, ok: rowsLeftInWindow === 0 && stock.every(s => s.ok) },
  }
}

/** The dry run, as a person reads it. */
export function formatPlan(p: CleanupPlan): string {
  const d = (x: Date) => new Date(x).toISOString().replace('T', ' ').slice(0, 16)
  const out: string[] = []
  out.push(`FR-21.14 test-sale cleanup — ${p.org.slug} (${p.org.id}), ${d(p.window.from)} … ${d(p.window.to)} UTC (${p.timeZone})`)
  const fiscal = p.sales.filter(s => s.isFiscal).length
  out.push(`Sales in the window: ${p.sales.length} (fiscal ${fiscal}, non-fiscal ${p.sales.length - fiscal}), total ${round2(p.sales.reduce((s, x) => s + x.total, 0))}`)
  for (const s of p.sales) {
    out.push(`  ${s.number}  ${d(s.createdAt)}  ${s.type}/${s.status}  ${s.total}  ${s.isFiscal ? `fiscal ${s.device || '?'}` : `non-fiscal${s.device ? ` (${s.device})` : ''}`}  ${s.unp || ''}  ${s.movementId ? 'movement' : 'no movement'}`)
  }
  out.push(`Movements to reverse and remove: ${p.movements.filter(m => m.source === 'sale').length} dispatch(es), ${p.movements.filter(m => m.source === 'pos-out').length} POS-OUT batch(es)`)
  for (const m of p.movements) out.push(`  ${m.number}  ${m.type}/${m.status}  ${m.source}  ${m.lines.length} line(s)`)
  out.push(`Stock coming back: ${p.stock.length} product/warehouse pair(s), ${round2(p.stock.reduce((s, x) => s + x.add, 0))} unit(s)`)
  out.push(`Sessions to remove: ${p.sessions.length}`)
  for (const s of p.sessions) {
    out.push(`  ${s.number}  ${s.status}  ${s.removed}/${s.rows} row(s)${s.batchMovementId ? '  + its POS-OUT batch' : ''}${s.deleted ? '' : '  ⚠ would keep rows'}`)
  }
  out.push(`Journal entries resting on them: ${p.journalEntries.length}`)
  if (p.outside.length) {
    out.push(`POS rows OUTSIDE the window: ${p.outside.length}`)
    for (const s of p.outside) out.push(`  ${s.number}  ${d(s.createdAt)}  ${s.type}/${s.status}  ${s.total}  ${s.isFiscal ? `fiscal ${s.device || '?'}` : 'non-fiscal'}`)
  }
  out.push(p.blockers.length ? `BLOCKED: ${p.blockers.join('; ')}` : `Ready: --execute --expect ${p.sales.length}`)
  return out.join('\n')
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  const arg = (name: string) => {
    const i = args.indexOf(name)
    return i >= 0 ? args[i + 1] : undefined
  }
  const orgSlug = arg('--org') || ''
  const from = arg('--from') || ''
  const to = arg('--to') || ''
  const execute = args.includes('--execute')
  try {
    // Neither run builds an index or creates a collection: it writes only into collections the
    // deployed app already has, and a dry run from a branch must leave prod's schema alone.
    await mongoose.connect(config.mongodb.uri, { autoIndex: false, autoCreate: false })
    const org: any = await Org.findOne({ slug: orgSlug }, { _id: 1 }).lean().exec()
    if (org) await assertScriptHome(org._id, orgSlug)
    const plan = await planTestSaleCleanup({ orgSlug, from, to })
    console.log(formatPlan(plan))
    if (!execute) {
      console.log('\nDRY RUN — nothing changed.')
    } else {
      const expect = Number(arg('--expect'))
      const backupPath = arg('--backup') || `${process.env.HOME || '.'}/fr21-test-sales-${orgSlug}-${new Date().toISOString().replace(/[:.]/g, '-')}.ndjson`
      const result = await executeTestSaleCleanup(plan, { expectSales: expect, backupPath, userId: arg('--as') })
      console.log(`\nBackup: ${backupPath}`)
      console.log(JSON.stringify(result, null, 1))
      if (!result.verify.ok) process.exitCode = 3
    }
  } catch (e: any) {
    console.error(e instanceof CleanupRefused ? e.message : e)
    process.exitCode = e instanceof CleanupRefused ? 2 : 1
  } finally {
    await mongoose.disconnect()
  }
}
