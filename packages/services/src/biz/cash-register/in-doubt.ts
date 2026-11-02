import { LEASE_MS } from '../hot-path-key.js'

/**
 * FR-23: a till sale whose fiscal receipt nothing can prove. Its money stands (D-4), so unlike a receipt
 * or a storno it holds nothing back, but a storno of it cannot say what it reverses: read as not
 * printed, the refund leaves with no storno on the device (#281), which is why the door refuses it
 * (`stornoRefusal`) until a person has looked at the device (`settleInDoubt`). A text sale prints nothing
 * to reverse, and is not one of these.
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

/** The same, as a filter on a sale: what the settle door claims. */
export function saleInDoubtFilter(now = new Date()): Record<string, unknown> {
  return {
    type: 'cash_sale',
    'register.isFiscal': true,
    $or: [
      { 'register.fiscal.state': 'unknown' },
      { 'register.fiscal.state': 'pending', leaseUntil: { $lt: now } },
      { 'register.fiscal.state': 'pending', leaseUntil: null, createdAt: { $lt: new Date(now.getTime() - LEASE_MS) } },
    ],
  }
}
