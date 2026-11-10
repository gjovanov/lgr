import { test, expect } from '@playwright/test'
import { loginForApp } from './helpers/login'
import { apiDelete, apiGet, apiLogin, apiPost } from './helpers/api'
import { okJson } from './helpers/bills'

/**
 * FR-28 slice 4 — orders from the Products list (FR-28.13 to .21).
 *
 * Twelve articles of this spec's own (`E2E-PO-<stamp>-01..12`, minimum 10, found by that prefix): the first four were
 * bought on a received bill from supplier A (so the dialog names A for them, at the bill's price), the other eight
 * were never bought. All twelve are below their minimum, and a page holds ten, so "Select all N that match the
 * filter" has something to select.
 *
 * What it pins, as the person at the list sees it: filter, select all that match (the request carries the FILTER,
 * never the ids), Create supplier order, set the missing suppliers, create, land on the draft; the selection
 * surviving paging and a filter change, and the chip that says how many ticked articles the filter hides; one draft
 * for two quick presses of Create; a customer order from two articles; and a role that may not create an order seeing
 * no bulk buttons. The server's side is `integration/orders-from-products.flow` and `internal-order-from-products.flow`.
 *
 * Slice 5 rewrites the supplier-order form into a tree: the created order is asserted through the API, and the browser
 * only through the URL it landed on.
 *
 * Serial: the cases share the articles, the bill and the member user, whose creation is the expensive part.
 */
test.describe.configure({ mode: 'serial' })
test.use({ viewport: { width: 1600, height: 900 } })

const stamp = Date.now().toString(36)
const prefix = `E2E-PO-${stamp}`
const PASSWORD = 'e2e-test-pw-12345'
const memberName = `member-po-${stamp}`
const N = 12
const pad = (i: number) => String(i).padStart(2, '0')

let admin: Awaited<ReturnType<typeof apiLogin>>
const ids: {
  suppliers: Record<string, string>
  client?: string
  products: string[]
  bill?: string
  member?: string
  orders: string[]
  internalOrders: string[]
} = { suppliers: {}, products: [], orders: [], internalOrders: [] }

test.beforeAll(async () => {
  admin = await apiLogin()
  const warehouses = (await apiGet(admin, '/warehouse/warehouse?size=100')).warehouses || []
  const warehouse = warehouses.find((w: any) => w.isDefault) || warehouses[0]
  expect(warehouse, 'the seed has a warehouse').toBeTruthy()

  for (const key of ['A', 'B']) {
    const { contact } = await okJson(await apiPost(admin, '/invoicing/contact', { type: 'supplier', companyName: `E2E PO Supplier ${key} ${stamp}` }))
    ids.suppliers[key] = contact._id || contact.id
  }
  const { contact: client } = await okJson(await apiPost(admin, '/invoicing/contact', { type: 'customer', companyName: `E2E PO Client ${stamp}` }))
  ids.client = client._id || client.id

  for (let i = 1; i <= N; i++) {
    const { product } = await okJson(await apiPost(admin, '/warehouse/product', {
      sku: `${prefix}-${pad(i)}`, name: `E2E orders ${pad(i)} ${stamp}`, category: 'General', type: 'goods', unit: 'pcs',
      purchasePrice: 2.5, sellingPrice: 4, taxRate: 20, minStockLevel: 10, maxStockLevel: 40,
    }))
    ids.products.push(product._id || product.id)
  }

  // One received bill from supplier A for the first four: 5 on hand each (still below the minimum of 10), and A is their supplier.
  const { invoice } = await okJson(await apiPost(admin, '/invoices', {
    type: 'invoice', direction: 'incoming', contactId: ids.suppliers.A, issueDate: new Date().toISOString().slice(0, 10), currency: 'EUR',
    lines: ids.products.slice(0, 4).map((productId, i) => ({
      productId, warehouseId: warehouse._id, description: `E2E orders ${pad(i + 1)} ${stamp}`, quantity: 5, unit: 'pcs', unitPrice: 3.25, taxRate: 20,
    })),
    subtotal: 4 * 5 * 3.25, total: 4 * 5 * 3.25 * 1.2,
  }))
  ids.bill = invoice.id || invoice._id
  await okJson(await apiPost(admin, `/invoices/${ids.bill}/receive`, {}))

  // A read-only member: it may open the Products list, and may not create an order.
  const { user } = await okJson(await apiPost(admin, '/user', {
    email: `${memberName}@acme.com`, username: memberName, password: PASSWORD, firstName: 'Read', lastName: 'Only', role: 'member',
  }))
  ids.member = user?._id || user?.id
})

// Everything this spec made, undone: drafts are deleted, the received bill is voided, products and contacts deactivate.
test.afterAll(async () => {
  for (const id of ids.orders) await apiDelete(admin, `/invoicing/orders/${id}`).catch(() => null)
  for (const id of ids.internalOrders) await apiDelete(admin, `/invoicing/internal-orders/${id}`).catch(() => null)
  if (ids.bill) await apiPost(admin, `/invoices/${ids.bill}/void`, {}).catch(() => null)
  for (const id of ids.products) await apiDelete(admin, `/warehouse/product/${id}`).catch(() => null)
  for (const id of [...Object.values(ids.suppliers), ids.client]) if (id) await apiDelete(admin, `/invoicing/contact/${id}`).catch(() => null)
  if (ids.member) await apiDelete(admin, `/user/${ids.member}`).catch(() => null)
})

async function openList(page: any, query = '') {
  await page.goto(`/inventory/products?q=${prefix}${query}`)
  const table = page.locator('.v-data-table').first()
  await expect(table.locator('tbody tr').first()).toBeVisible({ timeout: 15000 })
  return table
}
// The list is newest first (its default sort): articles 12 down to 03 are on the first page, 02 and 01 on the second.
const rowOf = (table: any, n: number) => table.locator('tbody tr').filter({ hasText: `${prefix}-${pad(n)}` })
const tickRow = (table: any, n: number) => rowOf(table, n).locator('.v-selection-control').first().click()
const tickPage = (table: any) => table.locator('thead .v-selection-control').first().click()

/** Pick an option of an autocomplete by what it shows. */
async function choose(page: any, field: any, text: string) {
  await field.locator('.v-field').click()
  await page.locator('.v-overlay--active .v-list-item').filter({ hasText: text }).first().click()
}

/** Remember the drafts a response made, so the afterAll can delete them. */
function trackCreated(page: any) {
  page.on('response', async (res: any) => {
    const url = res.url()
    if (res.request().method() !== 'POST' || !res.ok()) return
    try {
      if (/\/invoicing\/orders\/from-products$/.test(url)) ids.orders.push((await res.json()).order._id)
      else if (/\/invoicing\/internal-orders\/from-products$/.test(url)) ids.internalOrders.push((await res.json()).order._id)
    } catch { /* not a body we track */ }
  })
}

test('below minimum, select all that match, create a supplier order, set the suppliers, land on the draft', async ({ page }) => {
  trackCreated(page)
  await loginForApp(page)
  const table = await openList(page)
  await page.getByTestId('filter-below-min').click()
  await expect(page).toHaveURL(/belowMin=true/)
  // Twelve match, ten are on the page.
  await expect(table.locator('tbody tr')).toHaveCount(10, { timeout: 15000 })

  // The header checkbox ticks the page, and the banner offers all that match.
  await expect(page.getByTestId('selection-bar')).toHaveCount(0)
  await tickPage(table)
  await expect(page.getByTestId('select-all-banner')).toContainText('12')
  await expect(page.getByTestId('selection-count')).toContainText('10')
  await page.getByTestId('select-all-matching').click()
  await expect(page.getByTestId('selection-count')).toContainText('12')
  await expect(page.getByTestId('all-matching-banner')).toContainText('12')
  await expect(page.getByTestId('select-all-banner')).toHaveCount(0)
  // Another page shows its rows ticked too: it is the filter that is selected.
  await page.getByRole('button', { name: /next page/i }).click()
  await expect(table.locator('tbody tr')).toHaveCount(2, { timeout: 15000 })
  await expect(table.locator('tbody tr').first().locator('input[type="checkbox"]')).toBeChecked()
  await page.getByRole('button', { name: /previous page/i }).click()
  await expect(table.locator('tbody tr')).toHaveCount(10, { timeout: 15000 })

  // The dialog asks the server for the rows with the FILTER: no list of ids leaves the browser for "all that match".
  const previewRequest = page.waitForRequest((r) => r.method() === 'POST' && /\/orders\/from-products\/preview$/.test(r.url()))
  await page.getByTestId('create-supplier-order').click()
  const dialog = page.getByTestId('order-dialog')
  const rows = dialog.getByTestId('order-row')
  await expect(rows).toHaveCount(N, { timeout: 15000 })
  const sent = (await previewRequest).postDataJSON()
  expect(sent.filter).toMatchObject({ belowMin: 'true' })
  expect(sent.productIds).toBeUndefined()

  // The first four were bought from A (its price is the default); the other eight need a supplier, and Create says so.
  await expect(rows.nth(0).getByTestId('order-supplier')).toContainText(`E2E PO Supplier A ${stamp}`)
  await expect(rows.nth(0).getByTestId('order-price').locator('input')).toHaveValue('3.25')
  // Below the maximum of 40 with 5 on hand: 35; never stocked: 40.
  await expect(rows.nth(0).getByTestId('order-qty').locator('input')).toHaveValue('35')
  await expect(rows.nth(11).getByTestId('order-qty').locator('input')).toHaveValue('40')
  await expect(dialog.getByTestId('order-missing')).toContainText('8')
  await expect(dialog.getByTestId('order-create')).toBeDisabled()

  // One supplier for the rest at once: the four keep... no: "all rows" sets every row. Then put the first back to A.
  await choose(page, dialog.getByTestId('order-supplier-all'), `E2E PO Supplier B ${stamp}`)
  await expect(dialog.getByTestId('order-missing')).toHaveCount(0)
  await choose(page, rows.nth(0).getByTestId('order-supplier'), `E2E PO Supplier A ${stamp}`)
  await expect(dialog.getByTestId('order-create')).toBeEnabled()

  await dialog.getByTestId('order-create').click()
  // It opens the new draft (FR-22.35): the browser lands on its URL.
  await page.waitForURL(/\/invoicing\/orders\/[0-9a-f]{24}\/edit$/, { timeout: 15000 })
  const id = page.url().match(/orders\/([0-9a-f]{24})\/edit/)![1]
  expect(ids.orders).toContain(id)

  // What was made is read through the API: ONE draft, a group per supplier, a line per article, one allocation per line.
  const { order } = await apiGet(admin, `/invoicing/orders/${id}`)
  expect(order.status).toBe('draft')
  expect(order.orderNumber).toMatch(/^DRF-ORDO-\d{4}-\d{5}$/)
  expect(order.supplierGroups).toHaveLength(2)
  const lines = order.supplierGroups.flatMap((g: any) => g.lines)
  expect(lines).toHaveLength(N)
  for (const l of lines) {
    expect(l.allocations).toHaveLength(1)
    expect(l.allocations[0].quantity).toBe(l.quantity)
  }
  const a = order.supplierGroups.find((g: any) => g.supplierId === ids.suppliers.A)
  const b = order.supplierGroups.find((g: any) => g.supplierId === ids.suppliers.B)
  expect(a.lines).toHaveLength(1)
  expect(b.lines).toHaveLength(N - 1)
  expect(a.lines[0]).toMatchObject({ expectedUnitPrice: 3.25, quantity: 35 })
  // Nothing was sent or reserved.
  expect(order.statusHistory.map((s: any) => s.status)).toEqual(['draft'])
  const reservations = (await apiGet(admin, `/invoicing/reservations?orderId=${id}&size=5`)).reservations || []
  expect(reservations).toHaveLength(0)
})

test('the selection is cleared after an order is created, and pressing Create twice quickly makes ONE draft', async ({ page }) => {
  trackCreated(page)
  await loginForApp(page)
  const table = await openList(page, '&belowMin=true')
  await expect(table.locator('tbody tr')).toHaveCount(10, { timeout: 15000 })
  // The first case's order cleared its selection: a fresh list has none.
  await expect(page.getByTestId('selection-bar')).toHaveCount(0)

  const draftsBefore = (await apiGet(admin, '/invoicing/orders?status=draft&size=100')).total
  const posts: string[] = []
  page.on('request', (r) => { if (r.method() === 'POST' && /\/invoicing\/orders\/from-products$/.test(r.url())) posts.push(r.postDataJSON().requestId) })

  await tickRow(table, 5)
  await tickRow(table, 6)
  await expect(page.getByTestId('selection-count')).toContainText('2')
  await page.getByTestId('create-supplier-order').click()
  const dialog = page.getByTestId('order-dialog')
  await expect(dialog.getByTestId('order-row')).toHaveCount(2, { timeout: 15000 })
  await choose(page, dialog.getByTestId('order-supplier-all'), `E2E PO Supplier B ${stamp}`)
  await expect(dialog.getByTestId('order-create')).toBeEnabled()

  // Two presses in the same instant.
  await dialog.getByTestId('order-create').dblclick()
  await page.waitForURL(/\/invoicing\/orders\/[0-9a-f]{24}\/edit$/, { timeout: 15000 })

  // Whatever reached the server carried ONE request id, and made ONE order.
  expect(posts.length).toBeGreaterThanOrEqual(1)
  expect(new Set(posts).size).toBe(1)
  const draftsAfter = (await apiGet(admin, '/invoicing/orders?status=draft&size=100')).total
  expect(draftsAfter).toBe(draftsBefore + 1)
})

test('the selection survives paging and a filter change, and says how many ticked articles the filter hides', async ({ page }) => {
  await loginForApp(page)
  const table = await openList(page)
  await expect(table.locator('tbody tr')).toHaveCount(10, { timeout: 15000 })

  await tickRow(table, 12)
  await expect(page.getByTestId('selection-count')).toContainText('1')
  // Paging keeps it: tick one on the second page.
  await page.getByRole('button', { name: /next page/i }).click()
  await expect(table.locator('tbody tr')).toHaveCount(2, { timeout: 15000 })
  await tickRow(table, 2)
  await expect(page.getByTestId('selection-count')).toContainText('2')
  // Back on the first page the first row is still ticked.
  await page.getByRole('button', { name: /previous page/i }).click()
  await expect(table.locator('tbody tr')).toHaveCount(10, { timeout: 15000 })
  await expect(rowOf(table, 12).locator('input[type="checkbox"]')).toBeChecked()

  // A filter that shows neither of the two: the selection stays, and the chip says they are outside it.
  await page.getByRole('textbox', { name: /search/i }).first().fill(`${prefix}-01`)
  await expect(table.locator('tbody tr')).toHaveCount(1, { timeout: 15000 })
  await expect(page.getByTestId('selection-count')).toContainText('2')
  await expect(page.getByTestId('selection-outside')).toContainText('2', { timeout: 15000 })
  // The one the filter shows is not ticked.
  await expect(table.locator('tbody tr').first().locator('input[type="checkbox"]')).not.toBeChecked()

  // Clear empties it.
  await page.getByTestId('selection-clear').click()
  await expect(page.getByTestId('selection-bar')).toHaveCount(0)
})

test('a customer order from two articles: a client and a date, one draft, opened', async ({ page }) => {
  trackCreated(page)
  await loginForApp(page)
  const table = await openList(page)
  await expect(table.locator('tbody tr')).toHaveCount(10, { timeout: 15000 })
  await tickRow(table, 3)
  await tickRow(table, 4)
  await page.getByTestId('create-customer-order').click()
  const dialog = page.getByTestId('order-dialog')
  await expect(dialog).toHaveAttribute('data-kind', 'customer')
  await expect(dialog.getByTestId('order-row')).toHaveCount(2, { timeout: 15000 })
  // A customer order has no supplier column; every row starts at one.
  await expect(dialog.getByTestId('order-supplier')).toHaveCount(0)
  await expect(dialog.getByTestId('order-qty').first().locator('input')).toHaveValue('1')
  // A client and a date are required.
  await expect(dialog.getByTestId('order-create')).toBeDisabled()
  await choose(page, dialog.getByTestId('order-client'), `E2E PO Client ${stamp}`)
  await dialog.getByTestId('order-delivery').locator('input').fill('2027-01-15')
  await dialog.getByTestId('order-qty').nth(1).locator('input').fill('3')
  await expect(dialog.getByTestId('order-create')).toBeEnabled()
  await dialog.getByTestId('order-create').click()

  await page.waitForURL(/\/invoicing\/internal-orders\/[0-9a-f]{24}\/edit$/, { timeout: 15000 })
  const id = page.url().match(/internal-orders\/([0-9a-f]{24})\/edit/)![1]
  expect(ids.internalOrders).toContain(id)
  const { internalOrder } = await apiGet(admin, `/invoicing/internal-orders/${id}`)
  expect(internalOrder.status).toBe('draft')
  expect(internalOrder.orderNumber).toMatch(/^DRF-ORDI-\d{4}-\d{5}$/)
  expect(internalOrder.contactId).toBe(ids.client)
  expect(internalOrder.requestedDeliveryDate.slice(0, 10)).toBe('2027-01-15')
  expect(internalOrder.lines.map((l: any) => l.quantity)).toEqual([1, 3])
  // The rows are in name order: 03, then 04.
  expect(internalOrder.lines.map((l: any) => l.productId)).toEqual([ids.products[2], ids.products[3]])
  // Confirmed nothing, reserved nothing.
  const reservations = (await apiGet(admin, `/invoicing/reservations?internalOrderId=${id}&size=5`)).reservations || []
  expect(reservations).toHaveLength(0)
})

test('a role that may not create an order ticks articles and sees no order buttons', async ({ page }) => {
  await loginForApp(page, 'acme-corp', memberName, PASSWORD)
  const table = await openList(page)
  await expect(table.locator('tbody tr').first()).toBeVisible({ timeout: 15000 })
  await tickRow(table, 12)
  await expect(page.getByTestId('selection-count')).toContainText('1')
  await expect(page.getByTestId('create-supplier-order')).toHaveCount(0)
  await expect(page.getByTestId('create-customer-order')).toHaveCount(0)
  // The server says the same: a read-only role is refused.
  const login = await fetch(`${process.env.BASE_URL || 'http://localhost:4001'}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ orgSlug: 'acme-corp', username: memberName, password: PASSWORD }),
  })
  const { token } = await login.json()
  const refused = await fetch(`${process.env.BASE_URL || 'http://localhost:4001'}/api/org/${admin.orgId}/invoicing/orders/from-products`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ requestId: `member-${stamp}`, items: [] }),
  })
  expect(refused.status).toBe(403)
})
