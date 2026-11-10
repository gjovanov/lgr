import { test, expect } from '@playwright/test'
import { startWalk, uxApi } from '../helpers/ux-budget'

/**
 * P7-tree — Reserve 4 units for a client on a NEW warehouse row of a supplier order's line.
 *
 * "The supplier order is out to the supplier for 20 units, 12 of them going to the main warehouse.
 * A client wants 4, and the other 8 are to arrive at the retail store: add that warehouse to the
 * line and reserve the client's 4 there." (FR-28.49)
 *
 * Before the tree (the first commit of this walk, on the form with an allocation editor and a
 * client-reservations grid under each line): 11 clicks, 1 typed, 0 keys, 1 dialog.
 *
 * On the tree (FR-28.40): + Warehouse opens a row under the line with its list open and the cursor in
 * it, so the warehouse is one click on the list; the cursor then moves to the quantity, which starts at
 * what is left to place, so the 4 is typed over it and Enter adds the row. + Client does the same on the
 * new warehouse; the client's name is typed (the open list shows only the first of a real customer
 * list) and picked, and the quantity is already at what the warehouse has free, so only Enter. Save is
 * still a click: the reservation is staged and saved with the order. The target is at most 7 clicks, 2
 * typed and no dialog.
 *
 * Products used: PRD-0031, this walk's share of the acme-corp seed. Supplier: Quality Materials.
 * Client: Delta Services. Warehouses: the default one, and Retail Store.
 */

type Api = Awaited<ReturnType<typeof uxApi>>

const SUPPLIER = 'Quality Materials'
const CLIENT = 'Delta Services'
const NEW_WAREHOUSE = 'Retail Store'
const SKU = 'PRD-0031'
const ORDERED = 20
const ON_MAIN = 12
const RESERVED = 4

async function productBySku(api: Api, sku: string): Promise<any> {
  const { products } = await api.get(`/warehouse/product?search=${encodeURIComponent(sku)}&size=5`)
  const p = (products || []).find((x: any) => x.sku === sku)
  expect(p, `seed product ${sku}`).toBeTruthy()
  return p
}

async function contactByName(api: Api, name: string): Promise<any> {
  const { contacts } = await api.get(`/invoicing/contact?search=${encodeURIComponent(name)}&size=5`)
  const c = (contacts || []).find((x: any) => x.companyName === name)
  expect(c, name).toBeTruthy()
  return c
}

/**
 * Setup (uncounted): a draft supplier order for the article, 20 ordered and 12 of them allocated to
 * the main warehouse. Earlier runs' orders are cancelled first.
 */
async function draftOrder(api: Api, supplier: any, product: any, main: any): Promise<any> {
  const { orders } = await api.get('/invoicing/orders?size=100&status=draft,sent')
  for (const o of orders || []) {
    const mine = (o.supplierGroups || []).some((g: any) => String(g.supplierId) === String(supplier._id)
      && (g.lines || []).some((l: any) => String(l.productId) === String(product._id)))
    if (mine) await api.post(`/invoicing/orders/${o._id}/cancel`)
  }
  const { order } = await api.post('/invoicing/orders', {
    issueDate: new Date().toISOString().split('T')[0],
    expectedDate: new Date(Date.now() + 10 * 86400000).toISOString().split('T')[0],
    supplierGroups: [{
      supplierId: supplier._id,
      lines: [{
        productId: product._id, description: product.name, sku: product.sku, quantity: ORDERED, unit: product.unit || 'pcs',
        expectedUnitPrice: product.purchasePrice, allocations: [{ warehouseId: main._id, quantity: ON_MAIN }],
      }],
    }],
  })
  expect(order?._id, 'supplier order created').toBeTruthy()
  return order
}

test('P7 tree: reserve 4 units for a client on a new warehouse row of a supplier order line', async ({ page }, testInfo) => {
  const api = await uxApi()
  const supplier = await contactByName(api, SUPPLIER)
  const client = await contactByName(api, CLIENT)
  const product = await productBySku(api, SKU)
  const { warehouses } = await api.get('/warehouse/warehouse?size=100')
  const main = (warehouses || []).find((w: any) => w.isDefault) || warehouses[0]
  const retail = (warehouses || []).find((w: any) => w.name === NEW_WAREHOUSE)
  expect(retail, `seed warehouse ${NEW_WAREHOUSE}`).toBeTruthy()
  const order = await draftOrder(api, supplier, product, main)

  const walk = await startWalk(page, testInfo, {
    id: 'P7-tree',
    title: 'Supplier order — reserve 4 units for a client on a new warehouse row of a line',
    start: `/invoicing/orders/${order._id}/edit`,
  })
  await expect(page.locator('.form-paper-header').getByText(order.orderNumber)).toBeVisible()
  await walk.shot('order-form')

  const lineRow = page.locator('tr[data-kind="line"]').filter({ has: page.locator('.v-chip').filter({ hasText: product.name }) })

  // ── 1. + Warehouse: a row under the line, its list open ──
  await walk.click(lineRow.getByTestId('tree-addWarehouse'), 'add a warehouse to the line (+ Warehouse)')
  const editor = page.locator('[data-tree-editor]')
  await expect(editor).toBeVisible()
  await walk.click(page.getByRole('option', { name: NEW_WAREHOUSE }), `pick „${NEW_WAREHOUSE}" from the open list`)
  // The cursor is in the quantity, which starts at what the line has left to place (8): typed over with 4.
  const quantity = page.locator('[data-tree-editor-qty] input')
  await expect(quantity).toBeFocused()
  await expect(quantity).toHaveValue(String(ORDERED - ON_MAIN))
  await walk.fill(quantity, String(RESERVED), 'type the quantity the warehouse takes', { focused: true })
  await walk.press(page, 'Enter', 'add the warehouse')
  await expect(editor).toHaveCount(0)
  await expect(page.locator('tr[data-kind="allocation"]')).toHaveCount(2)
  await walk.shot('warehouse-added')

  // ── 2. + Client on it: its list open, the quantity already what it has free ──
  const warehouseRow = page.locator('tr[data-kind="allocation"]').last()
  await walk.click(warehouseRow.getByTestId('tree-addClient'), 'reserve for a client on it (+ Client)')
  await expect(editor).toBeVisible()
  // A customer list is long: the open list shows the first of it, so the name is typed to find the client.
  await walk.type(editor.locator('input').first(), CLIENT, `type „${CLIENT}"`, { focused: true })
  await walk.click(page.getByRole('option', { name: CLIENT }), `pick „${CLIENT}" from the list`)
  await expect(quantity).toBeFocused()
  await expect(quantity).toHaveValue(String(RESERVED))
  await walk.press(page, 'Enter', 'add the reservation')
  await expect(editor).toHaveCount(0)
  await expect(page.getByText(CLIENT).first()).toBeVisible()
  await walk.shot('client-added')

  // ── 3. Save: a reservation made on this form is staged and saved with the order ──
  await walk.click(page.getByRole('button', { name: 'Запази', exact: true }).first(), 'save the order')
  await expect(page.locator('.v-snackbar').first()).toBeVisible()
  await walk.shot('saved')

  // What the walk made, read from the API (not counted).
  const { order: saved, reservations } = await walk.offTheClock(() => api.get(`/invoicing/orders/${order._id}`))
  const line = saved.supplierGroups[0].lines[0]
  const newAlloc = line.allocations.find((a: any) => String(a.warehouseId) === String(retail._id))
  expect(newAlloc?.quantity, 'the new warehouse took 4').toBe(RESERVED)
  const held = (reservations || []).filter((r: any) => r.status === 'active' && String(r.allocationId) === String(newAlloc._id))
  expect(held, 'one reservation on the new warehouse row').toHaveLength(1)
  expect(held[0].quantity).toBe(RESERVED)
  expect(String(held[0].contactId)).toBe(String(client._id))

  const result = walk.finish()
  // FR-28.49: at most 7 clicks, 2 typed and no dialog (it was 11, 1 and 1).
  expect(result.clicks).toBeLessThanOrEqual(7)
  expect(result.typed).toBeLessThanOrEqual(2)
  expect(result.dialogs).toBe(0)
})
