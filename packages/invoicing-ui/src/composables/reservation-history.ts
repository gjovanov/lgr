/**
 * A reservation's history, as its page tells it (FR-22.37): created, changed, released in part,
 * cancelled and why, fulfilled, made again.
 *
 * The API keeps `statusHistory` with an English `reason` written by the code that changed the
 * reservation (`reservation-ops.service`, `order-reservations.service`, `reservation.service`,
 * the migration). Each known reason becomes an i18n key and its figures; one this module does not
 * know is shown as written rather than dropped. Pure, so `unit/reservation-history.test.ts` pins
 * every reason the server writes.
 */

export interface StatusHistoryEntry {
  status: string
  fromStatus?: string
  changedAt: string | Date
  changedBy?: unknown
  reason?: string
}

export type HistoryTone = 'created' | 'changed' | 'released' | 'cancelled' | 'fulfilled' | 'other'

export interface HistoryEntry {
  at: string | Date
  /** The user id that made the change, when the server recorded one. */
  by: string | null
  /** An i18n key under `invoicing.reservations.history.`, or `other` with the raw `text`. */
  key: string
  params: Record<string, string | number>
  tone: HistoryTone
}

export const CANCEL_REASONS = ['manual', 'released', 'preempted', 'internal_order_cancelled', 'external_order_cancelled'] as const

const KEY = 'invoicing.reservations.history'

function creation(reason: string, repeatOfNumber?: string | null): Pick<HistoryEntry, 'key' | 'params'> {
  if (reason === 'created with the order') return { key: `${KEY}.createdWithOrder`, params: {} }
  if (reason === 'reserved again with the order') return { key: `${KEY}.repeatOf`, params: { number: repeatOfNumber || '…' } }
  if (reason === 'migrated from embedded order reservation') return { key: `${KEY}.migrated`, params: {} }
  const preempted = /^preempted from (\S+)/.exec(reason)
  if (preempted) return { key: `${KEY}.preemptedFrom`, params: { number: preempted[1] } }
  const generated = /^generated for (\S+)/.exec(reason)
  if (generated) return { key: `${KEY}.generatedFor`, params: { number: generated[1] } }
  if (repeatOfNumber) return { key: `${KEY}.repeatOf`, params: { number: repeatOfNumber } }
  if (!reason || reason === 'created') return { key: `${KEY}.created`, params: {} }
  return { key: `${KEY}.other`, params: { text: reason } }
}

const cancelKey = (...candidates: Array<string | null | undefined>) =>
  `${KEY}.cancelled.${candidates.find((c) => (CANCEL_REASONS as readonly string[]).includes(String(c))) || 'manual'}`

/** One change after the first entry. */
function change(h: StatusHistoryEntry, reason: string, cancelReason?: string | null): Pick<HistoryEntry, 'key' | 'params' | 'tone'>[] {
  if (h.status === 'cancelled' && h.fromStatus !== 'cancelled') {
    return [{ key: cancelKey(reason, cancelReason), params: {}, tone: 'cancelled' }]
  }
  // „manual (-2)": part of it released; „preempted (-3)": part of it given to a more urgent order.
  const part = /^([a-z_]+) \(-([\d.]+)\)$/.exec(reason)
  if (part) {
    return [{ key: part[1] === 'preempted' ? `${KEY}.preempted` : `${KEY}.released`, params: { quantity: Number(part[2]) }, tone: 'released' }]
  }
  const updated = /^updated(?: with the order)?: (.*)$/.exec(reason)
  if (updated) {
    const out: Pick<HistoryEntry, 'key' | 'params' | 'tone'>[] = []
    for (const piece of updated[1].split(',').map((s) => s.trim()).filter(Boolean)) {
      const q = /^quantity (\S+) → (\S+)$/.exec(piece)
      if (q) out.push({ key: `${KEY}.quantity`, params: { from: Number(q[1]), to: Number(q[2]) }, tone: 'changed' })
      else if (piece === 'client') out.push({ key: `${KEY}.client`, params: {}, tone: 'changed' })
      else out.push({ key: `${KEY}.other`, params: { text: piece }, tone: 'changed' })
    }
    return out.length ? out : [{ key: `${KEY}.other`, params: { text: reason }, tone: 'changed' }]
  }
  if (h.status === 'fulfilled' && h.fromStatus === 'active') return [{ key: `${KEY}.fulfilled`, params: {}, tone: 'fulfilled' }]
  if (h.status === 'active' && h.fromStatus === 'fulfilled') return [{ key: `${KEY}.reopened`, params: {}, tone: 'changed' }]
  return [{ key: `${KEY}.other`, params: { text: reason || h.status }, tone: 'other' }]
}

/**
 * The entries, oldest first. `repeatOfNumber` names the reservation this one repeats: its
 * creation reads „Резервирана отново от …" rather than a plain „Създадена". `cancelReason` is the
 * reservation's own, for an entry that does not say why (a migrated reservation was born
 * cancelled, its reason on the document only).
 */
export function reservationHistory(
  history: StatusHistoryEntry[] | null | undefined,
  opts: { repeatOfNumber?: string | null; cancelReason?: string | null } = {},
): HistoryEntry[] {
  const sorted = [...(history || [])].sort((a, b) => new Date(a.changedAt).getTime() - new Date(b.changedAt).getTime())
  const out: HistoryEntry[] = []
  sorted.forEach((h, i) => {
    const reason = String(h.reason || '').trim()
    const base = { at: h.changedAt, by: h.changedBy ? String(h.changedBy) : null }
    if (i === 0) {
      out.push({ ...base, ...creation(reason, opts.repeatOfNumber), tone: 'created' })
      if (h.status === 'cancelled') out.push({ ...base, key: cancelKey(opts.cancelReason), params: {}, tone: 'cancelled' })
      if (h.status === 'fulfilled') out.push({ ...base, key: `${KEY}.fulfilled`, params: {}, tone: 'fulfilled' })
      return
    }
    for (const c of change(h, reason, opts.cancelReason)) out.push({ ...base, ...c })
  })
  return out
}
