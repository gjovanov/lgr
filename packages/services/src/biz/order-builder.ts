/**
 * The one place a supplier order (ORDO) grows a line: find or open the supplier's group, append the line, give it
 * one allocation of its whole quantity to a warehouse.
 *
 * Extracted from `generateExternalOrder` (FR-28.17: "extracted, not copied"), which builds a draft supplier order
 * for a customer order's shortfall, and shared with the order made from the Products list
 * (`orders-from-products.service.ts`). The two cannot differ in what a group, a line and an allocation look like.
 *
 * Mutates `order.supplierGroups` (a Mongoose document array, so each pushed subdocument gets its `_id`), and
 * returns the three subdocuments so a caller can point a reservation at them.
 */
export interface SupplierOrderLineInput {
  supplierId: unknown
  productId?: unknown
  description: string
  sku?: string
  quantity: number
  unit: string
  expectedUnitPrice?: number
  /** The warehouse that receives the whole quantity. */
  warehouseId: unknown
}

export interface AddedOrderLine {
  group: any
  line: any
  allocation: any
}

export function addLineToSupplierGroup(order: any, input: SupplierOrderLineInput): AddedOrderLine {
  let group = (order.supplierGroups as any[]).find((g: any) => String(g.supplierId) === String(input.supplierId))
  if (!group) {
    order.supplierGroups.push({ supplierId: input.supplierId, lines: [] })
    group = order.supplierGroups[order.supplierGroups.length - 1]
  }
  group.lines.push({
    productId: input.productId,
    description: input.description,
    sku: input.sku,
    quantity: input.quantity,
    unit: input.unit,
    expectedUnitPrice: input.expectedUnitPrice,
    allocations: [{ warehouseId: input.warehouseId, quantity: input.quantity }],
  })
  const line = group.lines[group.lines.length - 1]
  return { group, line, allocation: line.allocations[0] }
}
