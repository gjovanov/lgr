/**
 * Where „Създай изходяща поръчка" puts a client order's short lines (FR-22.42): a new supplier
 * order, or a draft one the same supplier already has — so two client orders short on the same
 * supplier's articles need not become two supplier orders. Pure, unit-tested.
 *
 * `generateExternalOrder` appends to a draft by `orderId`, grouping the new lines under their
 * supplier (a supplier the draft does not carry yet gets its own group); it refuses an order that
 * is no longer a draft (`order_not_draft`).
 */

export interface DraftOrder {
  _id: string
  orderNumber: string
  supplierIds: string[]
  supplierNames: string[]
  lineCount: number
  createdAt: string
}

/** A row of `GET /invoicing/orders?status=draft`, as the dialog lists it. */
export function asDraftOrder(o: any): DraftOrder {
  const groups: any[] = o?.supplierGroups || []
  return {
    _id: String(o?._id ?? ''),
    orderNumber: o?.orderNumber || o?.number || '',
    supplierIds: groups.map((g) => String(g.supplierId || '')).filter(Boolean),
    supplierNames: o?.supplierNames || [],
    lineCount: groups.reduce((s, g) => s + (g.lines || []).length, 0),
    createdAt: String(o?.createdAt || ''),
  }
}

const wantedOf = (supplierIds: Array<string | null | undefined>) => [...new Set(supplierIds.filter(Boolean).map(String))]

/** The drafts that carry at least one of these suppliers, newest first. */
export function pickDraftsFor(drafts: DraftOrder[], supplierIds: Array<string | null | undefined>): DraftOrder[] {
  const wanted = new Set(wantedOf(supplierIds))
  if (!wanted.size) return []
  return drafts
    .filter((d) => d.supplierIds.some((s) => wanted.has(s)))
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))
}

/**
 * Where the lines go unless the user picks: the newest draft that carries every supplier the rows
 * name, else a new order (null). A draft of only some of them is offered, never chosen for the user.
 */
export function defaultDraftFor(drafts: DraftOrder[], supplierIds: Array<string | null | undefined>): DraftOrder | null {
  const wanted = wantedOf(supplierIds)
  if (!wanted.length) return null
  return pickDraftsFor(drafts, wanted).find((d) => wanted.every((s) => d.supplierIds.includes(s))) || null
}
