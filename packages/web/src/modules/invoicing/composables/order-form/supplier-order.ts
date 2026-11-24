/**
 * The supplier order (ORDO) as its form holds it, and as its PUT/POST carries it and its GET returns it: plain
 * functions, moved out of `OrderFormView` (FR-32.23).
 */

/** `_key` names an allocation before it is saved, so a reservation staged on it can point at it. */
export interface AllocRow { _id?: string; _key?: string; warehouseId: string; quantity: number; receivedQuantity?: number }
export interface LineRow {
  _id?: string
  /** A line not saved yet has only this: the tree tells it from the next one, and keeps what is open on it. */
  _key?: string
  productId?: string
  description: string
  sku?: string
  quantity: number
  unit: string
  expectedUnitPrice?: number
  taxRate?: number
  receivedQuantity?: number
  allocations: AllocRow[]
}
export interface GroupRow { _id?: string; supplierId: string; reference?: string; notes?: string; lines: LineRow[] }

export interface SupplierOrderForm {
  issueDate: string
  expectedDate: string
  currency: string
  exchangeRate: number
  notes: string
  terms: string
  tags: string[]
  supplierGroups: GroupRow[]
}

/** The reservation changes staged on the form, as the order's PUT/POST carries them (`reservationChanges`). */
export interface ReservationChangesBody {
  create: Array<{ allocationId?: string; allocationKey?: string; contactId: string; quantity: number; repeatOf?: string }>
  update: Array<{ id: string; quantity?: number; contactId?: string }>
  cancel: Array<{ id: string }>
}

export function newKey(): string {
  return globalThis.crypto?.randomUUID?.() || `k${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`
}
export function emptyLine(): LineRow { return { _key: newKey(), description: '', quantity: 0, unit: 'pcs', allocations: [] } }
export function emptyGroup(): GroupRow { return { supplierId: '', reference: '', lines: [emptyLine()] } }

/** The order's body: a supplier with no one chosen and a line with neither article nor text are left out. */
export function supplierOrderBody(form: SupplierOrderForm, reservationChanges: ReservationChangesBody | undefined) {
  return {
    issueDate: form.issueDate,
    expectedDate: form.expectedDate || undefined,
    currency: form.currency,
    exchangeRate: form.exchangeRate || 1,
    notes: form.notes || undefined,
    terms: form.terms || undefined,
    tags: form.tags,
    supplierGroups: form.supplierGroups
      .filter((g) => g.supplierId)
      .map((g) => ({
        ...(g._id ? { _id: g._id } : {}),
        supplierId: g.supplierId,
        reference: g.reference || undefined,
        notes: g.notes || undefined,
        lines: g.lines
          .filter((l) => l.productId || (l.description || '').trim())
          .map((l) => ({
            ...(l._id ? { _id: l._id } : {}),
            productId: l.productId || undefined,
            description: l.description,
            sku: l.sku || undefined,
            quantity: Number(l.quantity) || 0,
            unit: l.unit || 'pcs',
            expectedUnitPrice: l.expectedUnitPrice !== undefined && l.expectedUnitPrice !== null ? Number(l.expectedUnitPrice) : undefined,
            taxRate: l.taxRate,
            allocations: l.allocations
              .filter((a) => a.warehouseId)
              .map((a) => ({
                ...(a._id ? { _id: a._id } : { clientKey: a._key }),
                warehouseId: a.warehouseId,
                quantity: Number(a.quantity) || 0,
              })),
          })),
      })),
    reservationChanges,
  }
}

/** The supplier groups as the order's GET returns them, as the form holds them. */
export function supplierGroupsFrom(groups: any[] | undefined): GroupRow[] {
  return (groups || []).map((g: any) => ({
    _id: g._id,
    supplierId: g.supplierId,
    reference: g.reference || '',
    notes: g.notes || '',
    lines: (g.lines || []).map((l: any) => ({
      _id: l._id,
      productId: l.productId || undefined,
      description: l.description || '',
      sku: l.sku,
      quantity: l.quantity || 0,
      unit: l.unit || 'pcs',
      expectedUnitPrice: l.expectedUnitPrice,
      taxRate: l.taxRate,
      receivedQuantity: l.receivedQuantity || 0,
      allocations: (l.allocations || []).map((a: any) => ({
        _id: a._id,
        warehouseId: a.warehouseId,
        quantity: a.quantity || 0,
        receivedQuantity: a.receivedQuantity || 0,
      })),
    })),
  }))
}
