import { redactResolution, seesEveryPrice, type Grant } from 'config/access'

/**
 * FR-27.11.C.6 (#529) — a document's stored price trail (`priceExplanation`, on an invoice's lines and a till
 * transaction's) as this role may read it: no level it does not see is named; a hidden winning level reads "Customer
 * price". The line's price is the document's, whoever looks.
 *
 * For a controller's `onAfterHandle`: every answer of the controller at once, so no route can forget it. The answer
 * whatever its shape, for a role that does not see every level and only when it carries a trail; else undefined,
 * and the answer goes out as it is (every legacy session sees every level: nothing is walked).
 */
export function withVisibleTrails(grant: Grant | null | undefined, response: unknown): unknown {
  if (!response || typeof response !== 'object' || seesEveryPrice(grant)) return undefined
  const proto = Object.getPrototypeOf(response)
  if (!Array.isArray(response) && proto !== Object.prototype && proto !== null) return undefined // a Response, a status
  let text: string
  try { text = JSON.stringify(response) } catch { return undefined }
  if (!text || !text.includes('"priceExplanation"')) return undefined
  const walk = (v: any): any => {
    if (Array.isArray(v)) return v.map(walk)
    if (!v || typeof v !== 'object') return v
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [
      k,
      k === 'priceExplanation' && Array.isArray(x) ? redactResolution(grant, { steps: x }).steps : walk(x),
    ]))
  }
  return walk(JSON.parse(text))
}

const sameSteps = (a: unknown, b: unknown) =>
  JSON.stringify((Array.isArray(a) ? a : []).map((s: any) => [s?.type, s?.label, Number(s?.price)])) ===
  JSON.stringify((Array.isArray(b) ? b : []).map((s: any) => [s?.type, s?.label, Number(s?.price)]))

/**
 * FR-27.11.C.4 on the trail: a form that was shown less is not trusted. A save by a role that does not see every
 * level sends back the trail it read, redacted; on a line it did not reprice (same `_id`, same `unitPrice`) that
 * trail, or none, or one carrying a "Customer price" step, keeps the stored one. A line it repriced keeps its new
 * trail.
 */
export function keepStoredTrails<L extends Record<string, any>>(grant: Grant | null | undefined, lines: readonly L[] | undefined, stored: readonly any[] | undefined): L[] | undefined {
  if (!Array.isArray(lines) || seesEveryPrice(grant)) return lines as L[] | undefined
  const before = (Array.isArray(stored) ? stored : []).map((l: any) => (l?.toObject ? l.toObject() : l))
  const byId = new Map(before.map((l: any) => [String(l?._id ?? l?.id ?? ''), l]))
  return lines.map((l, i) => {
    // By `_id` where the body carries it; else (the PUT schema does not name it) the line at the same place, of the
    // same article.
    const atPlace = before[i] && String(before[i]?.productId ?? '') === String(l?.productId ?? '') ? before[i] : undefined
    const was = l?._id ? byId.get(String(l._id)) : atPlace
    if (!was || !Array.isArray(was.priceExplanation) || Number(l.unitPrice) !== Number(was.unitPrice)) return l
    const sent = l.priceExplanation
    const asRead = redactResolution(grant, { steps: was.priceExplanation }).steps
    const shownLess = sent === undefined || (Array.isArray(sent) && sent.some((s: any) => s?.type === 'customer')) || sameSteps(sent, asRead)
    return shownLess ? { ...l, priceExplanation: was.priceExplanation } : l
  })
}
