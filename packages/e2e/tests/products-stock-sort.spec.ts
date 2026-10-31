import { test, expect, type Page } from '@playwright/test'
import { loginForApp } from './helpers/login'
import { columnValues } from './helpers/table'

/**
 * The Products list sorts by its stock columns: „Наличност" by the quantity on hand, over every
 * filtered article, the article without stock last either way; „Резервирано" and „Поръчано" sort
 * as well. `products-supply-list.flow.test.ts` holds the rules for all three; this is the page.
 *
 * Articles used: three this spec creates per worker (`E2E-STK-<ts>-a..c`): 7 and 3 received, b none.
 */
test.use({ viewport: { width: 1920, height: 900 } })

const apiBase = process.env.BASE_URL || 'http://localhost:4001'
let prefix = ''

test.beforeAll(async () => {
  const login = await (await fetch(`${apiBase}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ orgSlug: 'acme-corp', username: 'admin', password: 'test123' }),
  })).json()
  const orgId = login.org?.id || login.org?._id
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${apiBase}/api/org/${orgId}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${login.token}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    expect(res.ok, `${method} ${path}`).toBe(true)
    return res.json()
  }
  prefix = `E2E-STK-${Date.now()}`
  const warehouses = (await call('GET', '/warehouse/warehouse?size=100')).warehouses || []
  const warehouse = (warehouses.find((w: any) => w.isDefault) || warehouses[0])._id
  for (const [key, quantity] of [['a', 7], ['b', 0], ['c', 3]] as const) {
    const { product } = await call('POST', '/warehouse/product', {
      sku: `${prefix}-${key}`, name: `E2E Stock ${key} ${prefix}`, category: 'Test', type: 'goods', unit: 'pcs',
      purchasePrice: 1, sellingPrice: 2, taxRate: 20,
    })
    if (!quantity) continue
    const { stockMovement } = await call('POST', '/warehouse/movement', {
      type: 'receipt', date: new Date().toISOString(), toWarehouseId: warehouse,
      lines: [{ productId: product.id || product._id, quantity, unitCost: 1, totalCost: quantity }], totalAmount: quantity,
    })
    await call('POST', `/warehouse/movement/${stockMovement.id || stockMovement._id}/confirm`, {})
  }
})

async function openList(page: Page) {
  await page.goto(`/inventory/products?q=${prefix}`)
  const table = page.locator('.v-data-table').first()
  await expect(table.locator('tbody tr')).toHaveCount(3, { timeout: 15000 })
  return table
}

const skus = async (table: ReturnType<Page['locator']>) => (await columnValues(table, 'SKU')).map((s) => s.slice(prefix.length + 1))

test('sorts by the stock on hand both ways, the article without stock last', async ({ page }) => {
  await loginForApp(page)
  const table = await openList(page)
  const header = table.locator('thead th').filter({ hasText: /^Stock$/ })

  await header.click()
  await expect(page).toHaveURL(/sortBy=stock&sortOrder=asc/)
  await expect.poll(() => skus(table)).toEqual(['c', 'a', 'b'])
  await header.click()
  await expect.poll(() => skus(table)).toEqual(['a', 'c', 'b'])
})

test('„Резервирано" and „Поръчано" sort too: none of the three has either, so by name', async ({ page }) => {
  await loginForApp(page)
  const table = await openList(page)
  for (const [title, key] of [['Reserved', 'reserved'], ['On order', 'onOrder']] as const) {
    await table.locator('thead th').filter({ hasText: new RegExp(`^${title}$`) }).click()
    await expect(page).toHaveURL(new RegExp(`sortBy=${key}&sortOrder=asc`))
    await expect.poll(() => skus(table)).toEqual(['a', 'b', 'c'])
  }
})
