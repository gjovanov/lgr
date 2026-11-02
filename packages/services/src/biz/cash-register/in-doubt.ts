import { LEASE_MS } from '../hot-path-key.js'

/**
 * FR-23: a till sale whose fiscal receipt nothing can prove. Its money stands (D-4), so unlike a receipt
 * or a storno it holds nothing back, but a storno of it cannot say what it reverses: read as not
 * printed, the refund leaves with no storno on the device (#281), which is why the door refuses it
 * (`stornoRefusal`) until a person has looked at the device (`settleInDoubt`). A text sale prints nothing
 * to reverse, and is not one of these: what stands in its way is `saleProgress`, when it is not finished.
 *
 * `unknown`, or still `pending` with nobody working on it: its request died. One with no key has no
 * lease to lapse, so its age says the same.
 */
export function saleInDoubt(doc: any, now = Date.now()): boolean {
  if (doc?.type !== 'cash_sale' || !doc.register?.isFiscal) return false
  const state = doc.register.fiscal?.state
  if (state === 'unknown') return true
  if (state !== 'pending') return false
  return doc.leaseUntil ? new Date(doc.leaseUntil).getTime() < now : new Date(doc.createdAt ?? now).getTime() < now - LEASE_MS
}

/**
 * How far a sale nobody finished got: `live` while someone is working on it, `dead` once its request died,
 * and null when it is finished or none of this applies. It has to be "no `completedAt`", not "`pending`": a
 * sale can stop after its print and before its session's totals, and the rows count it all the same. The
 * money of one that died stands (D-4), so it is finished, printing nothing, before anything reads the
 * session's figures or reverses it (`finishSale`).
 *
 * A copied POS row carries no `completedAt` of its own, and what it did is long done. ⚠ No lease says nothing
 * on its own: a sale from before `completedAt` existed has neither, and running its steps would dispatch it
 * again. So only a sale of a session is judged by its age. A lapsed lease is a request that died, whatever
 * else the sale is.
 */
export function saleProgress(doc: any, now = Date.now()): 'live' | 'dead' | null {
  if (doc?.type !== 'cash_sale' || doc.completedAt || doc.register?.legacy) return null
  if (doc.leaseUntil) return new Date(doc.leaseUntil).getTime() < now ? 'dead' : 'live'
  if (!doc.register?.sessionId) return null
  return new Date(doc.createdAt ?? 0).getTime() < now - LEASE_MS ? 'dead' : 'live'
}

/**
 * The same, as a filter on a sale: what the settle door claims. ⚠ An `unknown` one only with its lease free: a
 * sale goes `unknown` before its totals and its stock, and a settle landing there ran its steps beside whoever
 * was finishing it, and dispatched it twice. A lease left by a crash lapses, and then this finds it.
 */
export function saleInDoubtFilter(now = new Date()): Record<string, unknown> {
  return {
    type: 'cash_sale',
    'register.isFiscal': true,
    $or: [
      { 'register.fiscal.state': 'unknown', leaseUntil: null },
      { 'register.fiscal.state': 'unknown', leaseUntil: { $lt: now } },
      { 'register.fiscal.state': 'pending', leaseUntil: { $lt: now } },
      { 'register.fiscal.state': 'pending', leaseUntil: null, createdAt: { $lt: new Date(now.getTime() - LEASE_MS) } },
    ],
  }
}
