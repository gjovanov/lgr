import { DocFile, StockMovement, StockLevel, Product, Warehouse } from 'db/models'
import { createAuditEntry } from '../audit-log.service.js'
import { analyzeDocFile, targetForDocType } from './doc-pipeline.service.js'
import { reconcileNote } from 'config/movement-notes'
import { confirmMovement } from '../warehouse.service.js'
import { stockMovementDao } from '../../dao/warehouse/stock-movement.dao.js'

/**
 * Files app — idempotent create/update/DELETE reconciliation for MOVEMENT documents. When a doc
 * that was already committed is re-uploaded with changed content, diff the NEW intended net-per-
 * product against what is currently BOOKED (found by the doc's marker), and book a single
 * compensating movement for the delta — receipt for +, adjustment for −. A removed line reverses
 * its booked quantity (delete). This is the manual 12676 fix, generalized.
 *
 * DRY-RUN by default (returns the delta preview, books nothing). Only `execute:true` writes, and
 * every product is verified to land on `booked_before + delta` before the call returns.
 */

const round2 = (v: number) => +v.toFixed(2)

/** Net signed quantity per product across movements — sign from which warehouse field is set
 *  (toWarehouseId → +, fromWarehouseId → −), identical to the stock engine. Works for the NEW
 *  mapped movements and the BOOKED movements alike. */
function netFromMovements(movs: any[]): Map<string, number> {
  const net = new Map<string, number>()
  for (const m of movs || []) {
    const sign = m.toWarehouseId ? 1 : m.fromWarehouseId ? -1 : 0
    if (!sign) continue
    for (const l of m.lines || []) {
      const pid = String(l.productId?._id || l.productId || '')
      if (!pid || pid === 'undefined') continue
      net.set(pid, (net.get(pid) || 0) + sign * Number(l.quantity))
    }
  }
  return net
}

async function stockQty(orgId: string, productId: string, warehouseId: any): Promise<{ qty: number; avgCost: number }> {
  const sl: any = await StockLevel.findOne({ orgId, productId, warehouseId }).lean()
  return { qty: Number(sl?.quantity) || 0, avgCost: Number(sl?.avgCost) || 0 }
}

export interface ReconcileDelta { productId: string; sku?: string; name?: string; bookedNet: number; newNet: number; delta: number; change: 'create' | 'update' | 'delete' }
export interface ReconcileResult {
  docNumber: string; version: number; bookedMovements: string[]
  deltas: ReconcileDelta[]; creates: number; updates: number; deletes: number
  executed: boolean; bookedNow?: string[]; verified?: boolean; warnings?: string[]
  /** Lines the analysis could not match. While this is > 0 the delta set is incomplete by definition. */
  unmatchedLines?: number
  /** Execution refused because the read was incomplete — see blockedReason. */
  blocked?: boolean; blockedReason?: string
}

export async function reconcileDocFile(orgId: string, userId: string, docFileId: string, opts: { execute?: boolean; force?: boolean } = {}): Promise<ReconcileResult> {
  const execute = !!opts.execute
  const doc = await DocFile.findOne({ orgId, _id: docFileId })
  if (!doc) throw new Error('DocFile not found')
  if (targetForDocType(doc.docType) !== 'movement') throw new Error('Reconcile supports movement documents (receipt / correction / transfer / write-off) only')

  // 1) new intended net — re-analyze the current version
  const { analyzed } = await analyzeDocFile(orgId, userId, docFileId)
  const newMovs = [analyzed.mapped, ...((analyzed as any).extraMovements || [])].filter(Boolean)
  const newNet = netFromMovements(newMovs)

  // A line that could not be matched to a product contributes NOTHING to newNet — which is
  // indistinguishable from "the document no longer has this line". The delta for those products
  // therefore comes out as a full reversal of whatever they had booked, and executing it unbooks
  // live stock. For an unread line newNet is not 0, it is UNKNOWN.
  //
  // This is not hypothetical: correction 3000016342 is a wide-layout export the deterministic parser
  // refuses, so re-reading fell to the model, which truncated the names („СИЛИКОН - CERESIT - CS24 -
  // УНИВ.") and reported seven products already in the catalog as missing. The reconcile proposed
  // reversing all seven — and the availability snapshot showed those deltas moving AWAY from it.
  const unmatchedLines = ((analyzed as any).diagnostics?.perLine || []).filter((l: any) => !l.matched).length

  // 2) booked net — the CURRENT net this document has already booked: its original commit movement(s)
  //    PLUS every prior reconcile of THIS doc (else re-running would re-apply the same delta and
  //    double-book). Movements are found by this document's idempotency marker — stable per document
  //    and identifying exactly its movements; a docNumber substring is not (storeOperations markers
  //    are date-based). Stored markers ∪ freshly-analyzed markers ∪ this doc's own reconcile marker.
  //    All ASCII, so the regex is safe from the Cyrillic→\uXXXX transpile trap.
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const markers = Array.from(new Set([...(doc.markers || []), ...newMovs.map((m: any) => m?.marker)].filter(Boolean))) as string[]
  const patterns = markers.map(esc)
  if (doc.docNumber) patterns.push(`reconcile:${esc(doc.docNumber)}-`) // this doc's prior reconciles only
  const bookedReal = patterns.length
    ? await StockMovement.find({ orgId, status: { $ne: 'cancelled' }, notes: { $regex: patterns.join('|') } }).lean()
    : []
  const bookedNet = netFromMovements(bookedReal)

  // 3) delta per product
  const pids = new Set<string>([...newNet.keys(), ...bookedNet.keys()])
  const deltas: ReconcileDelta[] = []
  for (const pid of pids) {
    const nv = newNet.get(pid) || 0, bv = bookedNet.get(pid) || 0, d = round2(nv - bv)
    if (Math.abs(d) < 0.001) continue
    const p: any = await Product.findOne({ orgId, _id: pid }).select('name sku').lean()
    deltas.push({ productId: pid, sku: p?.sku, name: p?.name?.trim(), bookedNet: bv, newNet: nv, delta: d, change: bv === 0 ? 'create' : nv === 0 ? 'delete' : 'update' })
  }

  const preview: ReconcileResult = {
    docNumber: doc.docNumber, version: doc.version, bookedMovements: bookedReal.map((m: any) => m.movementNumber),
    deltas, creates: deltas.filter(d => d.change === 'create').length, updates: deltas.filter(d => d.change === 'update').length, deletes: deltas.filter(d => d.change === 'delete').length,
    executed: false, unmatchedLines,
  }
  if (!execute) return preview

  // Refuse rather than guess. `force` exists for the case where the operator has read the paper
  // document and knows the unmatched lines really are gone — it is never the default.
  if (unmatchedLines > 0 && !opts.force) {
    return {
      ...preview,
      blocked: true,
      blockedReason:
        `${unmatchedLines} line(s) in this document did not match a product, so what those products `
        + `should now hold is unknown, not zero. Applying these deltas could reverse a booking that is `
        + `still correct. Fix the mapping (or the read) and run it again; pass force to override.`,
    }
  }
  // Nothing to book — but an EXECUTED reconcile that finds no difference has just proved the booking
  // matches these bytes, which is precisely what clears the "needs reconcile" flag. Without this a
  // document re-uploaded for a reason that never touched its lines (a re-export, a corrected filing
  // date) would ask to be reconciled for ever, and the flag would stop meaning anything.
  if (!deltas.length) {
    doc.committedChecksum = doc.currentChecksum
    doc.committedVersion = doc.version
    doc.status = 'committed'
    await doc.save()
    return { ...preview, executed: true, bookedNow: [], verified: true, warnings: [] }
  }

  // 4) book ONE compensating movement per direction (receipt for +Δ, adjustment for −Δ), verify each.
  //    Land it in the SAME warehouse the document's own movements touch (so per-warehouse stock stays
  //    consistent, not just the global total), falling back to the org default.
  const whs: any[] = await Warehouse.find({ orgId }).lean()
  const docWhId = newMovs.map((m: any) => m?.toWarehouseId || m?.fromWarehouseId).find(Boolean)
  const wh = (docWhId && whs.find(w => String(w._id) === String(docWhId))) || whs.find(w => w.isDefault) || whs[0]
  if (!wh) throw new Error('Org has no warehouse')
  const before = new Map<string, number>()
  for (const d of deltas) before.set(d.productId, (await stockQty(orgId, d.productId, wh._id)).qty)

  const marker = `reconcile:${doc.docNumber}-v${doc.version}`
  // The correction belongs to the DOCUMENT's day, not to the day someone noticed it was short.
  // Stamping `new Date()` filed разписка 0000012710's two missing lines under 2026-09-08 while the
  // разписка itself is dated 2026-09-01, so every date-windowed report (FR-07, the daily digest,
  // the snapshot reconciliation) saw stock move on a day nothing was delivered.
  const docDate = doc.docDate ? new Date(`${doc.docDate}T12:00:00Z`) : new Date()
  const bookDate = Number.isFinite(docDate.getTime()) ? docDate : new Date()
  const pos = deltas.filter(d => d.delta > 0), neg = deltas.filter(d => d.delta < 0)
  const bookedNow: string[] = []
  for (const [type, whField, set] of [['receipt', 'toWarehouseId', pos], ['adjustment', 'fromWarehouseId', neg]] as const) {
    if (!set.length) continue
    const lines: any[] = []
    for (const d of set) { const { avgCost } = await stockQty(orgId, d.productId, wh._id); lines.push({ productId: d.productId, quantity: Math.abs(d.delta), unitCost: avgCost, totalCost: round2(Math.abs(d.delta) * avgCost) }) }
    const num = await stockMovementDao.getNextMovementNumber(orgId)
    const mv: any = await StockMovement.create({ orgId, movementNumber: num, type, status: 'draft', date: bookDate, [whField]: wh._id, totalAmount: round2(lines.reduce((s, l) => s + l.totalCost, 0)), notes: reconcileNote(doc.originalName, doc.version, marker), lines, createdBy: userId })
    await confirmMovement(String(mv._id))
    bookedNow.push(mv.movementNumber)
  }

  // verify each product landed on booked_before + delta
  const warnings: string[] = []
  for (const d of deltas) { const after = (await stockQty(orgId, d.productId, wh._id)).qty; const want = round2((before.get(d.productId) || 0) + d.delta); if (Math.abs(after - want) > 0.001) warnings.push(`${d.sku}: got ${after}, want ${want}`) }

  // The doc stays committed (now reconciled to the re-upload); re-store its markers for the next round.
  doc.status = 'committed'
  doc.committedTarget = 'movement'
  // Record WHICH bytes are now booked. Without this a reconciled document keeps reading as stale
  // for ever — `isStaleBooking` falls back to `version > committedVersion` when no checksum was
  // ever stamped, so the "needs reconcile" chip would never clear no matter how often it is run.
  doc.committedChecksum = doc.currentChecksum
  doc.committedVersion = doc.version
  await doc.save()
  createAuditEntry({ orgId, userId, action: 'reconcile', module: 'files', entityType: 'DocFile', entityId: docFileId, entityName: doc.originalName, changes: deltas.map(d => ({ field: `${d.change}:${d.sku}`, oldValue: d.bookedNet, newValue: d.newNet })) })

  return { ...preview, executed: true, bookedNow, verified: warnings.length === 0, warnings }
}
