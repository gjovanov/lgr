import { Product, StockMovement, Warehouse } from 'db/models'
import { isReceiptLinked } from './receipt-bill.service.js'

/**
 * „Стокова разписка" for a supplier bill: the goods receipts that booked the bill's goods.
 *
 * Both kinds of bill that book goods leave their receipts pointing at the bill (`invoiceId`):
 *   - a bill that receives its own goods (`/receive`, `/send` → `createInvoiceStockMovement`)
 *     makes one completed `receipt` per warehouse, at the bill's unit prices;
 *   - a bill made from receipts (FR-22.31, `receipt-bill.service.ts`) claims them — from the
 *     moment it is made, while it is still a draft.
 * Voiding the first adds a reversing `dispatch`; voiding the second releases its claims. So
 * `{ invoiceId, type: 'receipt', status: 'completed' }` is the set in either case, and a voided
 * bill has nothing of its own to print — its readers refuse it before they look.
 */

/** Bill statuses whose goods are no longer the bill's: a void reversed or released them. */
export const RELEASED_BILL_STATUSES = ['voided', 'cancelled']

/** A supplier bill: the only document a stock receipt is printed from. */
export function isSupplierBill(invoice: any): boolean {
  return invoice?.type === 'invoice' && invoice?.direction === 'incoming'
}

/**
 * The currency a bill's stock receipt prints in. A bill that received its own goods booked them at
 * its own prices. A bill made from receipts prints what those receipts booked, and a receipt books
 * in the org's currency, whatever the bill says.
 */
export function stockReceiptCurrency(bill: any, baseCurrency: string | undefined): string {
  return (isReceiptLinked(bill) && baseCurrency) || bill.currency
}

function idOf(v: any): string {
  return v === undefined || v === null ? '' : String(v._id ?? v)
}

function num(v: unknown): number {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

/**
 * The completed receipts that booked `bill`'s goods, oldest first. A line with no quantity moved
 * nothing (a price-only разписка line), and a receipt of nothing else is no receipt to print.
 */
async function bookedReceipts(orgId: string, bill: any): Promise<any[]> {
  if (!isSupplierBill(bill) || RELEASED_BILL_STATUSES.includes(bill.status)) return []
  const billId = idOf(bill._id ?? bill.id)
  if (!billId) return []
  const rows: any[] = await StockMovement.find(
    { orgId, invoiceId: billId, type: 'receipt', status: 'completed' } as any,
    { movementNumber: 1, date: 1, toWarehouseId: 1, lines: 1 },
  ).sort({ date: 1, movementNumber: 1 }).lean().exec()
  return rows.filter(m => (m.lines || []).some((l: any) => num(l.quantity) !== 0))
}

async function warehouseNames(orgId: string, movements: any[]): Promise<Map<string, string>> {
  const ids = [...new Set(movements.map(m => idOf(m.toWarehouseId)).filter(Boolean))]
  if (!ids.length) return new Map()
  const rows: any[] = await Warehouse.find({ orgId, _id: { $in: ids } } as any, { name: 1 }).lean().exec()
  return new Map(rows.map(w => [idOf(w._id), String(w.name || '')]))
}

export interface BillStockReceipt {
  id: string
  number: string
  date: Date
  warehouseId?: string
  warehouseName: string
}

/**
 * What the bill's form needs to offer the print: its booked receipts, by number, date and
 * warehouse. Empty for anything but a supplier bill that booked goods and still stands.
 */
export async function billStockReceipts(orgId: string, bill: any): Promise<BillStockReceipt[]> {
  const movements = await bookedReceipts(orgId, bill)
  if (!movements.length) return []
  const names = await warehouseNames(orgId, movements)
  return movements.map(m => ({
    id: idOf(m._id),
    number: m.movementNumber,
    date: m.date,
    ...(m.toWarehouseId ? { warehouseId: idOf(m.toWarehouseId) } : {}),
    warehouseName: names.get(idOf(m.toWarehouseId)) || '',
  }))
}

export interface BillStockReceiptSection {
  number: string
  date: Date
  warehouse: string
  lines: Array<{ name: string; unit?: string; quantity: number; unitPrice: number }>
}

/**
 * The receipts, line by line, as the print shows them: each article by its catalog name and unit
 * (the bill line's wording for one the catalog no longer has), the quantity received and the
 * price it was booked at — on a bill that received its own goods, the bill's unit price, in the
 * bill's currency.
 */
export async function billStockReceiptSections(orgId: string, bill: any): Promise<BillStockReceiptSection[]> {
  const movements = await bookedReceipts(orgId, bill)
  if (!movements.length) return []
  const productIds = [...new Set(movements.flatMap(m => (m.lines || []).map((l: any) => idOf(l.productId))).filter(Boolean))]
  const [names, products] = await Promise.all([
    warehouseNames(orgId, movements),
    Product.find({ orgId, _id: { $in: productIds } } as any, { name: 1, unit: 1 }).lean().exec() as Promise<any[]>,
  ])
  const byId = new Map(products.map(p => [idOf(p._id), p]))
  const billLine = new Map<string, any>()
  for (const l of bill.lines || []) {
    const id = idOf(l.productId)
    if (id && !billLine.has(id)) billLine.set(id, l)
  }
  return movements.map(m => ({
    number: m.movementNumber,
    date: m.date,
    warehouse: names.get(idOf(m.toWarehouseId)) || '',
    lines: (m.lines || [])
      .filter((l: any) => num(l.quantity) !== 0)
      .map((l: any) => {
        const id = idOf(l.productId)
        const p = byId.get(id)
        const own = billLine.get(id)
        return {
          name: p?.name || own?.description || id,
          unit: p?.unit || own?.unit || undefined,
          quantity: num(l.quantity),
          unitPrice: num(l.unitCost),
        }
      }),
  }))
}
