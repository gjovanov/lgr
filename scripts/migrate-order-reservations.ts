/**
 * Migration: promote embedded order reservations to first-class Reservation (RES-) docs.
 *
 * Every `supplierGroups[].lines[].allocations[].reservations[]` subdocument becomes a
 * Reservation document PRESERVING the subdocument `_id` — historic invoices'
 * `lines[].orderRef.reservationId` keep resolving. The create phase is an UPSERT:
 * re-running refreshes counters/quantity/status of already-migrated docs (safe to run
 * repeatedly while the old code is still live and mutating embedded state).
 *
 * Status derivation:
 *   - subdoc quantity ≤ 0 (legacy /release leftovers) → cancelled('released')
 *   - order draft/sent/partially_received/received     → active (fulfilled when dispatched ≥ qty)
 *   - order completed → quantity := max(invoiced, dispatched); 0 → cancelled('released'),
 *     else fulfilled/active   (mirrors the old complete/release hold-drop)
 *   - order cancelled → same shrink, reason 'external_order_cancelled'
 *
 * Also copies legacy display-prefix sentinels stored under the TYPE prefix
 * ('ORD'/'DRF-ORD', year=0) onto the counter keys ('ORDER'/'DRAFT_ORD') so the
 * ORD→ORDO rename cannot orphan an org's override.
 *
 * Deploy sequence (zero hold-loss):
 *   ① bun run scripts/migrate-order-reservations.ts --execute      (old code still live)
 *   ② deploy the new image
 *   ③ bun run scripts/migrate-order-reservations.ts --strip        (re-upserts, verifies
 *      hold parity, empties the embedded arrays, re-materialises StockLevels)
 *
 * Usage:
 *   bun run scripts/migrate-order-reservations.ts                  # dry-run
 *   bun run scripts/migrate-order-reservations.ts --execute        # create/refresh RES docs
 *   bun run scripts/migrate-order-reservations.ts --strip          # (post-deploy) strip embedded
 *   bun run scripts/migrate-order-reservations.ts --org regal-pz   # single org
 */
import { connectDB, disconnectDB } from '../packages/db/src/connection.js'
import { keepHomeOrgs } from './lib/home-guard.js'
import { Org, Order, Reservation, Sequence } from '../packages/db/src/models/index.js'
import { getNextNumber } from '../packages/services/src/biz/sequence.service.js'
import {
  syncReservedQuantities,
  activeReservedForAllocation,
  ORDER_HOLDING_STATUSES,
} from '../packages/services/src/biz/reservation.service.js'

type HoldTotals = Map<string, number>

const num = (v: any) => Number(v) || 0

/** Fail loudly if any embedded reservation _id appears twice (cross-order payload cloning). */
export async function preflightReservationIdUniqueness(orgId: string): Promise<void> {
  const orders = await Order.find({ orgId } as any, { orderNumber: 1, supplierGroups: 1 }).lean().exec()
  const seen = new Map<string, string>()
  for (const o of orders as any[]) {
    for (const g of o.supplierGroups || [])
      for (const l of g.lines || [])
        for (const a of l.allocations || [])
          for (const r of a.reservations || []) {
            const k = String(r._id)
            const prev = seen.get(k)
            if (prev && prev !== o.orderNumber) {
              throw new Error(
                `Duplicate embedded reservation _id ${k} in ${prev} and ${o.orderNumber} — resolve manually before migrating`,
              )
            }
            seen.set(k, o.orderNumber)
          }
  }
}

/** Copy a legacy year=0 display override from the type prefix onto the counter key. */
export async function copyLegacyDisplayOverrides(orgId: string, execute: boolean): Promise<string[]> {
  const copied: string[] = []
  const pairs: Array<[string, string]> = [['ORD', 'ORDER'], ['DRF-ORD', 'DRAFT_ORD']]
  for (const [typePrefix, counterKey] of pairs) {
    const legacy: any = await Sequence.findOne({ orgId, prefix: typePrefix, year: 0 } as any).lean().exec()
    if (!legacy?.displayPrefix) continue
    const target: any = await Sequence.findOne({ orgId, prefix: counterKey, year: 0 } as any).lean().exec()
    if (target?.displayPrefix) continue
    copied.push(`${typePrefix} → ${counterKey}: "${legacy.displayPrefix}"`)
    if (execute) {
      await Sequence.updateOne(
        { orgId, prefix: counterKey, year: 0 } as any,
        { $set: { displayPrefix: legacy.displayPrefix, lastNumber: target?.lastNumber ?? 0 } },
        { upsert: true },
      ).exec()
    }
  }
  return copied
}

/** Derive the RES-doc fields for one embedded reservation subdocument. */
export function deriveMigratedReservation(order: any, group: any, line: any, alloc: any, res: any): {
  quantity: number
  status: 'active' | 'fulfilled' | 'cancelled'
  cancelReason?: string
} {
  const qty = num(res.quantity)
  const inv = num(res.invoicedQuantity)
  const disp = num(res.dispatchedQuantity)
  if (qty <= 0) return { quantity: qty, status: 'cancelled', cancelReason: 'released' }
  if (order.status === 'draft' || ORDER_HOLDING_STATUSES.includes(order.status)) {
    return { quantity: qty, status: disp >= qty ? 'fulfilled' : 'active' }
  }
  // Order closed (completed/cancelled) — the open remainder was released back then.
  const kept = Math.max(inv, disp)
  const reason = order.status === 'cancelled' ? 'external_order_cancelled' : 'released'
  if (kept <= 0) return { quantity: qty, status: 'cancelled', cancelReason: reason }
  return { quantity: kept, status: disp >= kept ? 'fulfilled' : 'active' }
}

export interface MigrateStats {
  orders: number
  created: number
  refreshed: number
}

/** Create-or-refresh RES docs from every embedded reservation of the org's orders. */
export async function migrateOrgReservations(orgId: string, execute: boolean): Promise<MigrateStats> {
  const orders = await Order.find({ orgId } as any).lean().exec()
  const stats: MigrateStats = { orders: orders.length, created: 0, refreshed: 0 }
  for (const order of orders as any[]) {
    for (const g of order.supplierGroups || []) {
      for (const line of g.lines || []) {
        for (const alloc of line.allocations || []) {
          for (const res of alloc.reservations || []) {
            const derived = deriveMigratedReservation(order, g, line, alloc, res)
            const fields = {
              contactId: res.contactId,
              source: 'order' as const,
              warehouseId: alloc.warehouseId,
              orderId: order._id,
              groupId: g._id,
              lineId: line._id,
              allocationId: alloc._id,
              expectedDate: order.expectedDate,
              productId: line.productId || undefined,
              quantity: derived.quantity,
              invoicedQuantity: num(res.invoicedQuantity),
              dispatchedQuantity: num(res.dispatchedQuantity),
              invoiceIds: res.invoiceIds || [],
              status: derived.status,
              ...(derived.cancelReason ? { cancelReason: derived.cancelReason } : {}),
            }
            const existing: any = await Reservation.findOne({ _id: res._id, orgId } as any, { _id: 1 }).lean().exec()
            if (existing) {
              stats.refreshed++
              if (execute) {
                await Reservation.updateOne({ _id: res._id, orgId } as any, { $set: fields }).exec()
              }
            } else {
              stats.created++
              if (execute) {
                const year = new Date(order.createdAt || Date.now()).getFullYear()
                const reservationNumber = await getNextNumber(orgId, 'RESERVATION', 5, year)
                await Reservation.create({
                  _id: res._id,
                  orgId,
                  reservationNumber: `RES-${year}-${reservationNumber.split('-').pop()}`,
                  ...fields,
                  statusHistory: [
                    { status: derived.status, changedAt: new Date(), reason: 'migrated from embedded order reservation' },
                  ],
                  createdBy: order.createdBy,
                  createdAt: order.createdAt,
                } as any)
              }
            }
          }
        }
      }
    }
  }
  return stats
}

/** Hold totals per product|warehouse from the EMBEDDED reservations (legacy formula). */
export async function computeEmbeddedHoldTotals(orgId: string): Promise<HoldTotals> {
  const totals: HoldTotals = new Map()
  const orders = await Order.find({ orgId, status: { $in: ORDER_HOLDING_STATUSES } } as any, { supplierGroups: 1 }).lean().exec()
  for (const order of orders as any[]) {
    for (const g of order.supplierGroups || []) {
      for (const line of g.lines || []) {
        if (!line.productId) continue
        for (const alloc of line.allocations || []) {
          const openHold = (alloc.reservations || []).reduce(
            (s: number, r: any) => s + Math.max(0, num(r.quantity) - num(r.dispatchedQuantity)), 0)
          const dispatched = (alloc.reservations || []).reduce((s: number, r: any) => s + num(r.dispatchedQuantity), 0)
          const hold = Math.min(openHold, Math.max(0, num(alloc.receivedQuantity) - dispatched))
          if (hold <= 0) continue
          const k = `${line.productId}|${alloc.warehouseId}`
          totals.set(k, (totals.get(k) || 0) + hold)
        }
      }
    }
  }
  return totals
}

/** Hold totals per product|warehouse from the RES documents (new formula). */
export async function computeReservationHoldTotals(orgId: string): Promise<HoldTotals> {
  const totals: HoldTotals = new Map()
  const stockRes = await Reservation.find({ orgId, source: 'stock', status: { $ne: 'cancelled' } } as any).lean().exec()
  for (const r of stockRes as any[]) {
    if (!r.productId || !r.warehouseId) continue
    const hold = Math.max(0, num(r.quantity) - num(r.dispatchedQuantity))
    if (hold <= 0) continue
    const k = `${r.productId}|${r.warehouseId}`
    totals.set(k, (totals.get(k) || 0) + hold)
  }
  const orders = await Order.find({ orgId, status: { $in: ORDER_HOLDING_STATUSES } } as any, { supplierGroups: 1 }).lean().exec()
  const orderIds = (orders as any[]).map((o) => o._id)
  const orderRes = orderIds.length
    ? await Reservation.find({ orgId, source: 'order', orderId: { $in: orderIds } } as any).lean().exec()
    : []
  const byAlloc = new Map<string, any[]>()
  for (const r of orderRes as any[]) {
    const k = String(r.allocationId || '')
    if (!k) continue
    if (!byAlloc.has(k)) byAlloc.set(k, [])
    byAlloc.get(k)!.push(r)
  }
  for (const order of orders as any[]) {
    for (const g of order.supplierGroups || []) {
      for (const line of g.lines || []) {
        if (!line.productId) continue
        for (const alloc of line.allocations || []) {
          const hold = activeReservedForAllocation(alloc, byAlloc.get(String(alloc._id)) || [])
          if (hold <= 0) continue
          const k = `${line.productId}|${alloc.warehouseId}`
          totals.set(k, (totals.get(k) || 0) + hold)
        }
      }
    }
  }
  return totals
}

export function diffHoldTotals(a: HoldTotals, b: HoldTotals): Array<{ key: string; embedded: number; migrated: number }> {
  const keys = new Set([...a.keys(), ...b.keys()])
  const diffs: Array<{ key: string; embedded: number; migrated: number }> = []
  for (const k of keys) {
    const av = a.get(k) || 0
    const bv = b.get(k) || 0
    if (Math.abs(av - bv) > 1e-9) diffs.push({ key: k, embedded: av, migrated: bv })
  }
  return diffs
}

/** Empty every embedded reservations array (only after the new code is live). */
export async function stripOrgEmbeddedReservations(orgId: string, execute: boolean): Promise<number> {
  const affected = await Order.countDocuments({ orgId, 'supplierGroups.lines.allocations.reservations.0': { $exists: true } } as any).exec()
  if (execute && affected > 0) {
    await Order.updateMany(
      { orgId } as any,
      { $set: { 'supplierGroups.$[].lines.$[].allocations.$[].reservations': [] } },
    ).exec()
  }
  return affected
}

async function main() {
  const args = process.argv.slice(2)
  const strip = args.includes('--strip')
  const execute = args.includes('--execute') || strip
  const orgSlug = args.includes('--org') ? args[args.indexOf('--org') + 1] : null

  await connectDB()
  console.log(`Mode: ${strip ? 'STRIP (upsert + verify + strip)' : execute ? 'EXECUTE (upsert)' : 'DRY-RUN'}`)
  console.log(`Org filter: ${orgSlug || '(all)'}`)

  const orgs = await keepHomeOrgs(await Org.find(orgSlug ? { slug: orgSlug } : {}).lean() as any[], { named: !!orgSlug })
  for (const org of orgs as any[]) {
    const orgId = String(org._id)
    console.log(`\n── ${org.slug} ──`)

    await preflightReservationIdUniqueness(orgId)
    const copied = await copyLegacyDisplayOverrides(orgId, execute)
    for (const c of copied) console.log(`  sentinel copied: ${c}`)

    const stats = await migrateOrgReservations(orgId, execute)
    console.log(`  orders=${stats.orders} created=${stats.created} refreshed=${stats.refreshed}`)

    const embedded = await computeEmbeddedHoldTotals(orgId)
    const migrated = execute ? await computeReservationHoldTotals(orgId) : embedded
    const diffs = diffHoldTotals(embedded, migrated)
    if (diffs.length) {
      console.error(`  ✗ HOLD MISMATCH (${diffs.length} pairs):`)
      for (const d of diffs.slice(0, 20)) console.error(`    ${d.key}: embedded=${d.embedded} migrated=${d.migrated}`)
      if (strip) {
        console.error('  Refusing to strip — resolve the mismatch first.')
        continue
      }
    } else {
      console.log(`  ✓ hold totals identical (${embedded.size} product×warehouse pairs)`)
    }

    if (strip) {
      const affected = await stripOrgEmbeddedReservations(orgId, true)
      console.log(`  stripped embedded reservations from ${affected} orders`)
      await syncReservedQuantities(orgId)
      console.log('  StockLevel holds re-materialised from RES docs')
    }
  }

  if (!execute) console.log('\nDRY-RUN — no writes performed. Re-run with --execute to apply.')
  await disconnectDB()
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
