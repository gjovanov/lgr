import { test, expect } from '@playwright/test'
import { startWalk, uxApi } from '../helpers/ux-budget'

/**
 * P7-tree — Reserve 4 units for a client on a NEW warehouse row of a supplier order's line.
 *
 * "The supplier order is out to the supplier for 20 units, 12 of them going to the main warehouse.
 * A client wants 4, and the other 8 are to arrive at the retail store: add that warehouse to the
 * line and reserve the client's 4 there." (FR-28.49)
 *
 * The first version of this walk (FR-28 slice 5, before the tree) is the cost of the path TODAY, on
 * the form that has an allocation editor and a client-reservations grid under each line: the
 * allocation editor, a warehouse row, the reservations grid, a dialog for the client, and Save,
 * because a reservation made on this form is staged and saved with the order.
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

  const lineRow = page.locator('tbody tr').filter({ has: page.locator('.v-chip').filter({ hasText: product.name }) }).first()

  // ── 1. The allocation editor, and a row for the new warehouse ──
  await walk.click(lineRow.getByRole('button', { name: 'Складови разпределения' }), 'open the line\'s warehouse allocations')
  await walk.click(page.getByRole('button', { name: 'Добави склад' }), 'add a warehouse')
  const editor = page.locator('.v-sheet').filter({ has: page.getByRole('button', { name: 'Добави склад' }) }).last()
  const newRow = editor.locator('div.mb-2').last()
  await walk.choose(newRow, /^Склад$/, NEW_WAREHOUSE, `choose „${NEW_WAREHOUSE}"`)
  await walk.fill(newRow.locator('input[type="number"]'), String(RESERVED), 'type the quantity the warehouse takes')
  await walk.shot('warehouse-row')

  // ── 2. The line's client reservations, and the dialog that reserves ──
  await walk.click(lineRow.getByRole('button', { name: 'Клиентски резервации' }), 'open the line\'s client reservations')
  const reserveButtons = page.getByRole('button', { name: 'Резервирай за клиент' })
  await expect(reserveButtons).toHaveCount(2)
  await walk.click(reserveButtons.last(), 'reserve for a client, on the new warehouse')
  walk.dialog('the reserve-for-client dialog')
  const dialog = page.locator('.v-overlay--active .v-card').filter({ hasText: 'Записва се заедно с поръчката' })
  await expect(dialog).toBeVisible()
  await walk.choose(dialog, /^Клиент$/, CLIENT, `choose „${CLIENT}"`)
  // The quantity starts at what the warehouse has free: 4.
  await expect(dialog.locator('input[type="number"]')).toHaveValue(String(RESERVED))
  await walk.shot('reserve-dialog')
  await walk.click(dialog.getByRole('button', { name: 'Резервирай', exact: true }), 'reserve')
  await expect(dialog).toBeHidden()

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
  // Today's cost, recorded before the tree (FR-28.49). The tree's target is in the later version of this walk.
  console.log(`P7-tree baseline: ${result.clicks} clicks, ${result.typed} typed, ${result.keys} keys, ${result.dialogs} dialog(s)`)
})
