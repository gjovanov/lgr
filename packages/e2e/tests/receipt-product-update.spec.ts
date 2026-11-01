import { test, expect } from '@playwright/test'
import { loginForApp } from './helpers/login'
import { apiGet, apiLogin, apiPost } from './helpers/api'
import { okJson } from './helpers/bills'

/**
 * The goods receipt's „With product update": a line takes its article's current values when the
 * switch is turned on, and what it sends is only what the user then changed. Turning the switch on
 * for a draft whose cost differs from the catalog's purchase price must stage nothing — the
 * article keeps its price until the cost is actually edited.
 *
 * The article is made by the spec itself, so no other spec's prices move with it.
 */

test('turning „With product update" on for a draft receipt sends no product update until a price is edited', async ({ page }) => {
  const s = await apiLogin()
  const stamp = Date.now().toString(36)
  const supplier = ((await apiGet(s, '/invoicing/contact?type=supplier&size=5')).contacts || [])[0]
  const warehouses = (await apiGet(s, '/warehouse/warehouse?size=100')).warehouses || []
  const warehouse = warehouses.find((w: any) => w.isDefault) || warehouses[0]
  const { product } = await okJson(await apiPost(s, '/warehouse/product', {
    sku: `E2E-GR-${stamp}`, name: `E2E receipt article ${stamp}`, category: 'General', type: 'goods', unit: 'pcs',
    purchasePrice: 2.5, sellingPrice: 4, taxRate: 20,
  }))
  const { stockMovement } = await okJson(await apiPost(s, '/warehouse/movement', {
    type: 'receipt', date: new Date().toISOString().slice(0, 10), toWarehouseId: warehouse._id, contactId: supplier._id,
    lines: [{ productId: product._id, quantity: 3, unitCost: 2.9, totalCost: 8.7 }], totalAmount: 8.7,
  }))
  const movementId = stockMovement._id || stockMovement.id

  await loginForApp(page)
  await page.goto(`/inventory/movements/${movementId}`)
  const chipOff = page.locator('.v-chip').filter({ hasText: 'Without product update' })
  await expect(chipOff).toBeVisible({ timeout: 15000 })
  await chipOff.locator('input[type="checkbox"]').click()

  // Seeded from the catalog: the purchase price, not the receipt's own cost (2.90).
  const table = page.locator('table').filter({ has: page.locator('th', { hasText: 'Unit Cost' }) })
  await expect(table.locator('thead th').filter({ hasText: /^Buying Price$/ })).toHaveCount(1)
  const heads: string[] = await table.locator('thead th').allInnerTexts()
  const buying = heads.findIndex((h) => h.trim() === 'Buying Price')
  const cell = (col: number) => table.locator('tbody tr').first().locator('td').nth(col).locator('input').first()
  await expect(cell(buying)).toHaveValue('2.5')

  const save = () => page.locator('.form-actions-bar').getByRole('button', { name: /^Save$/ })
  const isPut = (r: any) => r.method() === 'PUT' && /\/warehouse\/movement\/[0-9a-f]{24}$/.test(r.url())

  let put = page.waitForRequest(isPut)
  // A save reloads the receipt, and its lines take their article's values again.
  const reloaded = page.waitForResponse((r: any) => r.request().method() === 'GET' && r.url().includes(`/warehouse/movement/${movementId}`))
  const reseeded = page.waitForResponse((r: any) => r.request().method() === 'GET' && r.url().includes('/warehouse/product?') && r.url().includes(String(product._id)))
  await save().click()
  expect((await put).postDataJSON().productUpdates).toEqual([])
  await reloaded
  await reseeded
  expect((await apiGet(s, `/warehouse/product/${product._id}`)).product.purchasePrice).toBe(2.5)

  // A price typed into the tier „Цена 1" — which the article does not hold yet — adds it by name.
  const tier = heads.findIndex((h) => h.trim() === 'Цена 1')
  expect(tier).toBeGreaterThan(buying)
  await cell(tier).fill('5.2')
  put = page.waitForRequest(isPut)
  await save().click()
  expect((await put).postDataJSON().productUpdates).toEqual([
    { productId: product._id, priceTiers: [{ name: 'Цена 1', finalPrice: 5.2, manualOverride: true }] },
  ])
  await expect.poll(async () => (await apiGet(s, `/warehouse/product/${product._id}`)).product.priceTiers?.map((t: any) => [t.name, t.finalPrice]))
    .toEqual([['Цена 1', 5.2]])
  expect((await apiGet(s, `/warehouse/product/${product._id}`)).product.purchasePrice).toBe(2.5)
})
