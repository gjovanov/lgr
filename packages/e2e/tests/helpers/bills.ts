import { expect } from '@playwright/test'
import { apiGet, apiLogin, apiPost } from './api'

/**
 * A supplier bill fixture for the bill-form specs: an article of its own (so no other spec's stock
 * or prices move with it), and a bill for it, received — it booked its goods.
 */

export async function okJson(res: Response) {
  const body = await res.json()
  expect(res.ok, JSON.stringify(body)).toBe(true)
  return body
}

export interface ReceivedBill {
  id: string
  number: string
  refs: { supplier: any; warehouse: any; product: any }
}

/** The article is bought at 2.50 and billed at 2.75 × 12, into the default warehouse. */
export async function receivedBill(): Promise<ReceivedBill> {
  const s = await apiLogin()
  const stamp = Date.now().toString(36)
  const suppliers = (await apiGet(s, '/invoicing/contact?type=supplier&size=5')).contacts || []
  const warehouses = (await apiGet(s, '/warehouse/warehouse?size=100')).warehouses || []
  const supplier = suppliers[0]
  const warehouse = warehouses.find((w: any) => w.isDefault) || warehouses[0]
  expect(supplier && warehouse, 'the seed has a supplier and a warehouse').toBeTruthy()
  const { product } = await okJson(await apiPost(s, '/warehouse/product', {
    sku: `E2E-BILL-${stamp}`, name: `E2E bill article ${stamp}`, category: 'General', type: 'goods', unit: 'pcs',
    purchasePrice: 2.5, sellingPrice: 4, taxRate: 20,
  }))
  const { invoice } = await okJson(await apiPost(s, '/invoices', {
    type: 'invoice', direction: 'incoming', contactId: supplier._id, issueDate: new Date().toISOString().slice(0, 10), currency: 'EUR',
    lines: [{ productId: product._id, warehouseId: warehouse._id, description: product.name, quantity: 12, unit: 'pcs', unitPrice: 2.75, taxRate: 20 }],
    subtotal: 33, total: 39.6,
  }))
  const id = invoice.id || invoice._id
  const received = await okJson(await apiPost(s, `/invoices/${id}/receive`, {}))
  return { id, number: received.invoice.invoiceNumber, refs: { supplier, warehouse, product } }
}
