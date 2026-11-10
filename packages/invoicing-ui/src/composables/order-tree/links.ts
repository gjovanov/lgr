/**
 * FR-28.46 — a link to a line of an order, and to the warehouse under it.
 *
 * `…/orders/:id/edit?line=<lineId>&allocation=<allocationId>` opens the form with that line (and warehouse)
 * open, scrolled into view and marked for a moment. A reservation knows both ids, so the Reservations list
 * and the reservation page link to exactly the row the reservation is under, not to the top of the document.
 *
 * PURE. An id that is not there gives no query: the link is then the old one, to the document.
 */
export function orderLineQuery(res: { lineId?: unknown; allocationId?: unknown } | null | undefined): Record<string, string> | undefined {
  const line = res?.lineId ? String(res.lineId) : ''
  if (!line) return undefined
  const allocation = res?.allocationId ? String(res.allocationId) : ''
  return allocation ? { line, allocation } : { line }
}
