import { test, expect } from '@playwright/test'
import { loginForApp } from './helpers/login'
import { apiDelete, apiGet, apiLogin, apiPost } from './helpers/api'
import { okJson } from './helpers/bills'
import { headerTitles } from './helpers/table'

/**
 * FR-28 slice 2 — which suppliers an article was bought from, on the Products list.
 *
 * Three articles of this spec's own (`E2E-PS-<stamp>-a|b|c`), found by that prefix:
 *   a  minimum 50, bought on three received bills (supplier A three days ago, B two, C yesterday): 36 on hand
 *   b  minimum 10, never bought, no stock
 *   c  no minimum, never bought, no stock
 *
 * What it pins, as the person at the list sees it: the Suppliers column (the two most recent names, "+1", every
 * one in a tooltip, a dash for nobody), the four columns the cog offers (off by default), the filters (supplier,
 * no supplier, below minimum, out of stock, the range, in the URL), the article's Suppliers tab, and a Seller —
 * who may not read bills — seeing none of it. What the server decides is `integration/product-suppliers.flow` and
 * `products-list-filters.flow`.
 *
 * Serial: the cases share the articles, the bills and the Seller, whose creation is the expensive part.
 */
test.describe.configure({ mode: 'serial' })
test.use({ viewport: { width: 1920, height: 900 } })

// Digits only. The Supplier filter finds a name by its words, and a stamp in base 36 can hold a "b": then
// "E2E Supplier B <stamp>" finds A and C as well, for as long as that letter stays in the stamp.
const stamp = String(Date.now())
const prefix = `E2E-PS-${stamp}`
const PASSWORD = 'e2e-test-pw-12345'
const sellerName = `seller-ps-${stamp}`
const day = (ago: number) => new Date(Date.now() - ago * 86_400_000).toISOString().slice(0, 10)

let admin: Awaited<ReturnType<typeof apiLogin>>
const ids: { suppliers: Record<string, string>; products: Record<string, string>; bills: Record<string, { id: string; number: string }>; seller?: string } = {
  suppliers: {}, products: {}, bills: {},
}

test.beforeAll(async () => {
  admin = await apiLogin()
  const warehouses = (await apiGet(admin, '/warehouse/warehouse?size=100')).warehouses || []
  const warehouse = warehouses.find((w: any) => w.isDefault) || warehouses[0]
  expect(warehouse, 'the seed has a warehouse').toBeTruthy()

  for (const key of ['A', 'B', 'C']) {
    const { contact } = await okJson(await apiPost(admin, '/invoicing/contact', { type: 'supplier', companyName: `E2E Supplier ${key} ${stamp}` }))
    ids.suppliers[key] = contact._id || contact.id
  }
  const product = (suffix: string, extra: Record<string, unknown>) =>
    apiPost(admin, '/warehouse/product', {
      sku: `${prefix}-${suffix}`, name: `E2E suppliers ${suffix} ${stamp}`, category: 'General', type: 'goods', unit: 'pcs',
      purchasePrice: 2.5, sellingPrice: 4, taxRate: 20, ...extra,
    }).then(okJson)
  for (const [suffix, extra] of [['a', { minStockLevel: 50 }], ['b', { minStockLevel: 10 }], ['c', {}]] as const) {
    const { product: p } = await product(suffix, extra)
    ids.products[suffix] = p._id || p.id
  }

  // Three received bills for article a, oldest first: the newest is the last purchase.
  for (const [key, ago, price] of [['A', 3, 2.5], ['B', 2, 2.75], ['C', 1, 2.9]] as const) {
    const { invoice } = await okJson(await apiPost(admin, '/invoices', {
      type: 'invoice', direction: 'incoming', contactId: ids.suppliers[key], issueDate: day(ago), currency: 'EUR',
      lines: [{ productId: ids.products.a, warehouseId: warehouse._id, description: `E2E suppliers a ${stamp}`, quantity: 12, unit: 'pcs', unitPrice: price, taxRate: 20 }],
      subtotal: 12 * price, total: 12 * price * 1.2,
    }))
    const id = invoice.id || invoice._id
    const received = await okJson(await apiPost(admin, `/invoices/${id}/receive`, {}))
    ids.bills[key] = { id, number: received.invoice.invoiceNumber }
  }

  // A Seller: holds Inventory and Invoicing, but its areas lack the purchases, so it may not read a bill.
  const { user } = await okJson(await apiPost(admin, '/user', {
    email: `${sellerName}@acme.com`, username: sellerName, password: PASSWORD, firstName: 'Counter', lastName: 'Seller', role: 'seller',
  }))
  ids.seller = user?._id || user?.id
})

// Everything this spec made, undone (products and contacts deactivate; a received bill is voided).
test.afterAll(async () => {
  for (const { id } of Object.values(ids.bills)) await apiPost(admin, `/invoices/${id}/void`, {}).catch(() => null)
  for (const id of Object.values(ids.products)) await apiDelete(admin, `/warehouse/product/${id}`).catch(() => null)
  for (const id of Object.values(ids.suppliers)) await apiDelete(admin, `/invoicing/contact/${id}`).catch(() => null)
  if (ids.seller) await apiDelete(admin, `/user/${ids.seller}`).catch(() => null)
})

async function openList(page: any, query = '') {
  await page.goto(`/inventory/products?q=${prefix}${query}`)
  const table = page.locator('.v-data-table').first()
  await expect(table.locator('tbody tr').first()).toBeVisible({ timeout: 15000 })
  return table
}
const rowOf = (table: any, suffix: string) => table.locator('tbody tr').filter({ hasText: `${prefix}-${suffix}` })

test('the Suppliers column names the two most recent suppliers, "+1" for the rest, a dash for nobody', async ({ page }) => {
  await loginForApp(page)
  const table = await openList(page)
  await expect(table.locator('tbody tr')).toHaveCount(3)

  const titles = await headerTitles(table)
  expect(titles).toContain('Suppliers')
  // After On order (where "what do we do about it" is asked), before the unit.
  expect(titles.indexOf('Suppliers')).toBe(titles.indexOf('On order') + 1)

  const a = rowOf(table, 'a').getByTestId('product-suppliers')
  await expect(a).toContainText(`E2E Supplier C ${stamp}`)
  await expect(a).toContainText(`E2E Supplier B ${stamp}`)
  await expect(a).toContainText('+1')
  await expect(a).not.toContainText(`E2E Supplier A ${stamp}`)
  // Each supplier is a badge, as each warehouse is in the Stock column: the most recent first, then "+1".
  const badges = a.locator('.v-chip')
  await expect(badges).toHaveText([`E2E Supplier C ${stamp}`, `E2E Supplier B ${stamp}`, '+1'])
  // A badge carries its whole name for the pointer: a long one is cut inside the badge, never across the cell.
  await expect(badges.nth(0)).toHaveAttribute('title', `E2E Supplier C ${stamp}`)
  expect(await badges.evaluateAll((chips, box) => chips.every((c) => c.getBoundingClientRect().right <= box.getBoundingClientRect().right + 1), await a.elementHandle()), 'no badge is wider than its cell').toBe(true)
  await expect(rowOf(table, 'b').getByTestId('product-suppliers')).toHaveText('—')
  await expect(rowOf(table, 'c').getByTestId('product-suppliers')).toHaveText('—')
  await expect(rowOf(table, 'b').getByTestId('product-suppliers').locator('.v-chip')).toHaveCount(0)

  // The tooltip names every supplier with its last purchase, the third included.
  await a.hover()
  await expect(page.getByRole('tooltip')).toContainText(`E2E Supplier A ${stamp}`)
})

/**
 * The Supplier filter asks the server for what is typed and lists THAT. It used to add every answer to the choices
 * it already had, in a field that filters nothing itself, so typing changed nothing on screen (owner, 2026-11-11).
 */
test('typing in the Supplier filter lists only what the typing matches, and a chosen supplier is not offered again', async ({ page }) => {
  await loginForApp(page)
  const table = await openList(page)
  await expect(table.locator('tbody tr')).toHaveCount(3)
  const field = page.getByTestId('filter-supplier')
  const options = page.getByRole('option')

  // Opened, it offers the first suppliers by name: this spec's three among the seed's.
  await field.locator('.v-field__input').click()
  await expect(options.first()).toBeVisible({ timeout: 15000 })
  expect(await options.count(), 'the first choices are more than one supplier').toBeGreaterThan(3)

  // A name: the one supplier that has it, and nothing else.
  await field.locator('input').fill(`E2E Supplier B ${stamp}`)
  await expect(options).toHaveText([`E2E Supplier B ${stamp}`])
  await options.first().click()
  await expect(page).toHaveURL(new RegExp(`supplier=${ids.suppliers.B}`))
  await expect(table.locator('tbody tr')).toHaveCount(1)
  await expect(rowOf(table, 'a')).toHaveCount(1)
  // Chosen, it is a chip in the field.
  await expect(field.locator('.v-chip')).toHaveText([`E2E Supplier B ${stamp}`])

  // Part of a name that the three share: the two not chosen yet. B is a chip, and is not listed again.
  await field.locator('input').fill(stamp)
  await expect(options).toHaveText([`E2E Supplier A ${stamp}`, `E2E Supplier C ${stamp}`])
  await options.filter({ hasText: `E2E Supplier C ${stamp}` }).click()
  await expect(page).toHaveURL(new RegExp(`supplier=${ids.suppliers.B}(,|%2C)${ids.suppliers.C}`))
  await expect(field.locator('.v-chip')).toHaveText([`E2E Supplier B ${stamp}`, `E2E Supplier C ${stamp}`])

  // Text that is nobody's name lists no supplier (the list then says it has nothing).
  await field.locator('input').fill(`no such supplier ${stamp}`)
  await expect(options.filter({ hasText: 'E2E Supplier' })).toHaveCount(0)
  await expect(options.filter({ hasText: stamp })).toHaveCount(0)
})

test('the cog offers Last purchase, Last cost, Minimum and To order, off until chosen', async ({ page }) => {
  await loginForApp(page)
  const table = await openList(page)
  const OPTIONAL = ['Last purchase', 'Last cost', 'Minimum', 'To order']
  const before = await headerTitles(table)
  for (const t of OPTIONAL) expect(before, t).not.toContain(t)

  await page.getByRole('button', { name: 'Columns' }).click()
  const dialog = page.getByRole('dialog')
  for (const t of OPTIONAL) {
    const item = dialog.locator('.v-list-item').filter({ has: page.locator('.v-list-item-title', { hasText: new RegExp(`^${t}$`) }) })
    await expect(item).toHaveCount(1)
    await item.getByRole('checkbox').click()
  }
  await dialog.getByRole('button', { name: 'Close' }).click()
  await expect.poll(async () => headerTitles(table)).toEqual(expect.arrayContaining(OPTIONAL))

  const cell = async (suffix: string, title: string) => {
    const index = (await headerTitles(table)).indexOf(title)
    return (await rowOf(table, suffix).locator(`td:nth-child(${index + 1})`).innerText()).trim()
  }
  // a: the last purchase is supplier C's bill, at its unit price; minimum 50, 36 on hand → 14 to order.
  expect(await cell('a', 'Last cost')).toContain('2.9')
  expect(await cell('a', 'Last purchase')).not.toBe('—')
  expect(await cell('a', 'Minimum')).toBe('50')
  expect(await cell('a', 'To order')).toBe('14')
  // b: nothing on hand, minimum 10 → 10; nobody sold it to us.
  expect(await cell('b', 'Minimum')).toBe('10')
  expect(await cell('b', 'To order')).toBe('10')
  expect(await cell('b', 'Last purchase')).toBe('—')
  // c: no minimum, nothing to order.
  expect(await cell('c', 'Minimum')).toBe('—')
  expect(await cell('c', 'To order')).toBe('—')

  // The choice is the user's, and it stays; the supplier names were never theirs to lose.
  await page.reload()
  await expect(table.locator('tbody tr').first()).toBeVisible({ timeout: 15000 })
  expect(await headerTitles(table)).toEqual(expect.arrayContaining(['Suppliers', ...OPTIONAL]))

  // Put the column choice back: it is stored in this browser's profile, not in the database.
  await page.getByRole('button', { name: 'Columns' }).click()
  await page.getByRole('dialog').getByRole('button', { name: /reset/i }).click()
})

test('the filters: below minimum, out of stock, the range, a supplier and no supplier, all in the URL', async ({ page }) => {
  await loginForApp(page)
  const table = await openList(page)
  const skuCount = (n: number) => expect(table.locator('tbody tr')).toHaveCount(n, { timeout: 15000 })
  await skuCount(3)

  // Below minimum: a (36 of 50) and b (0 of 10). c has no minimum, so it is never short.
  await page.getByTestId('filter-below-min').click()
  await expect(page).toHaveURL(/belowMin=true/)
  await skuCount(2)
  await expect(rowOf(table, 'c')).toHaveCount(0)

  // …and nobody sold it to us: b alone.
  await page.getByTestId('filter-no-supplier').locator('label').click()
  await expect(page).toHaveURL(/noSupplier=true/)
  await skuCount(1)
  await expect(rowOf(table, 'b')).toHaveCount(1)

  // Out of stock is the range at 0: b and c have nothing, a has 36.
  await page.goto(`/inventory/products?q=${prefix}`)
  await skuCount(3)
  await page.getByTestId('filter-out-of-stock').click()
  await expect(page).toHaveURL(/stockMax=0/)
  await skuCount(2)
  await expect(rowOf(table, 'a')).toHaveCount(0)

  // The range on the Stock column's own figure: 30 or more is a.
  await page.goto(`/inventory/products?q=${prefix}`)
  await skuCount(3)
  await page.getByTestId('filter-stock-min').locator('input').fill('30')
  await expect(page).toHaveURL(/stockMin=30/)
  await skuCount(1)
  await expect(rowOf(table, 'a')).toHaveCount(1)

  // A supplier carried by a link: only what that supplier sold us. The URL is the state.
  await page.goto(`/inventory/products?q=${prefix}&supplier=${ids.suppliers.B}`)
  await skuCount(1)
  await expect(rowOf(table, 'a')).toHaveCount(1)
  // The chosen supplier is named in the field, not shown as an id.
  await expect(page.getByTestId('filter-supplier')).toContainText(`E2E Supplier B ${stamp}`)
  await page.goto(`/inventory/products?q=${prefix}&supplier=${ids.suppliers.B},${ids.suppliers.C}&belowMin=true`)
  await skuCount(1)
})

test("the article's Suppliers tab: one row per supplier, the last documents behind them, each a link", async ({ page }) => {
  await loginForApp(page)
  await page.goto(`/inventory/products/${ids.products.a}/suppliers`)
  const tab = page.getByTestId('product-suppliers-tab')
  await expect(tab.getByTestId('product-supplier-row')).toHaveCount(3)
  // The most recent supplier first.
  await expect(tab.getByTestId('product-supplier-row').first()).toContainText(`E2E Supplier C ${stamp}`)
  await expect(tab.getByTestId('product-supplier-row').last()).toContainText(`E2E Supplier A ${stamp}`)
  await expect(tab.getByTestId('product-supplier-document')).toHaveCount(3)
  // A bill opens in the invoicing app.
  const link = tab.getByTestId('product-supplier-document').first().getByRole('link', { name: ids.bills.C.number })
  await expect(link).toHaveAttribute('href', new RegExp(`/invoicing/bills/${ids.bills.C.id}/edit`))
  // The tab is in the tab bar, and is the one selected.
  await expect(page.getByRole('tab', { name: 'Suppliers' })).toHaveAttribute('aria-selected', 'true')

  // An article nobody sold us says so.
  await page.goto(`/inventory/products/${ids.products.c}/suppliers`)
  await expect(page.getByTestId('product-suppliers-tab-empty')).toBeVisible()

  // A new article has no suppliers to show yet: the tab waits for the first save, like the stock tabs.
  await page.goto('/inventory/products/new/edit')
  await expect(page.getByRole('tab', { name: 'Suppliers' })).toBeDisabled()
})

test('a Seller, who may not read bills, is offered no supplier column, filter or tab, and the server refuses them', async ({ page }) => {
  await loginForApp(page, 'acme-corp', sellerName, PASSWORD)
  const table = await openList(page)
  await expect(table.locator('tbody tr')).toHaveCount(3)
  expect(await headerTitles(table)).not.toContain('Suppliers')
  await expect(page.getByTestId('filter-supplier')).toHaveCount(0)
  await expect(page.getByTestId('filter-no-supplier')).toHaveCount(0)
  // What is not about suppliers is still theirs: the quantity filters.
  await expect(page.getByTestId('filter-below-min')).toBeVisible()
  await page.getByTestId('filter-below-min').click()
  await expect(table.locator('tbody tr')).toHaveCount(2, { timeout: 15000 })

  // A link that carries a supplier filter does not break their list: it is ignored.
  await page.goto(`/inventory/products?q=${prefix}&supplier=${ids.suppliers.B}`)
  await expect(table.locator('tbody tr')).toHaveCount(3, { timeout: 15000 })

  // The article's page has no Suppliers tab.
  await page.goto(`/inventory/products/${ids.products.a}/stock`)
  await expect(page.getByRole('tab', { name: 'Stock' })).toBeVisible()
  await expect(page.getByRole('tab', { name: 'Suppliers' })).toHaveCount(0)

  // And the server holds it too: no `suppliers` key at all, and 403 on the filters and the tab.
  const seller = await apiLogin('acme-corp', sellerName, PASSWORD)
  const byProducts = await apiGet(seller, `/warehouse/product-supplier/by-products?productIds=${ids.products.a}`)
  expect(byProducts).toEqual({})
  const refused = [
    `/warehouse/product?supplierId=${ids.suppliers.B}`,
    '/warehouse/product?noSupplier=true',
    `/warehouse/product-supplier/${ids.products.a}`,
  ]
  for (const path of refused) {
    const res = await fetch(`${process.env.BASE_URL || 'http://localhost:4001'}/api/org/${seller.orgId}${path}`, { headers: { Authorization: `Bearer ${seller.token}` } })
    expect({ path, status: res.status }).toEqual({ path, status: 403 })
    expect(await res.text()).not.toContain(`E2E Supplier`)
  }
})
