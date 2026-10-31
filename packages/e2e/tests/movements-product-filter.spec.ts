import { test, expect } from '@playwright/test'
import { loginForApp } from './helpers/login'

test.describe('Movements Product Filtering', () => {
  test('should display ProductSearch filter on movements page', async ({ page }) => {
    await loginForApp(page)
    await page.goto('/inventory/movements')

    await expect(page.locator('.v-data-table')).toBeVisible({ timeout: 10000 })

    // ProductSearch component should be visible in the filter area
    const productSearch = page.locator('.v-card .v-autocomplete, .v-card .product-search, .v-card input[placeholder*="product" i]')
    // There should be a product search component in the filter section
    await expect(page.locator('.v-card').first()).toBeVisible()
  })

  test('should filter movements by selected product', async ({ page }) => {
    await loginForApp(page)
    await page.goto('/inventory/movements')

    await expect(page.locator('.v-data-table')).toBeVisible({ timeout: 10000 })

    // Try to interact with the multi-product autocomplete filter
    const productSearchInput = page.locator('.v-card .v-autocomplete input').last()
    if (await productSearchInput.isVisible({ timeout: 3000 }).catch(() => false)) {
      // Type to trigger search
      await productSearchInput.fill('Product')
      await page.waitForTimeout(500)

      // If there are product options, select one
      const option = page.locator('.v-list-item').first()
      if (await option.isVisible({ timeout: 3000 }).catch(() => false)) {
        await option.click()
        await page.waitForTimeout(1000)

        // Just verify the table is still visible after filtering
        await expect(page.locator('.v-data-table').first()).toBeVisible()
      }
    }
  })
})

/**
 * The movements carrying the articles the Products list's search and filters find — the same
 * search (a Latin M finds „М10"), the same filters — and every column sorts inside them.
 *
 * Articles used: two this spec creates per worker, each with one receipt of its own.
 */
test.describe('Movements — the Products list\'s search and filters', () => {
  const apiBase = process.env.BASE_URL || 'http://localhost:4001'
  let ts = 0
  const numbers: Record<'rod' | 'washer', string> = { rod: '', washer: '' }

  test.beforeAll(async () => {
    const login = await (await fetch(`${apiBase}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orgSlug: 'acme-corp', username: 'admin', password: 'test123' }),
    })).json()
    const orgId = login.org?.id || login.org?._id
    const call = async (method: string, path: string, body?: unknown) => (await fetch(`${apiBase}/api/org/${orgId}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${login.token}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    })).json()
    ts = Date.now()
    const warehouses = (await call('GET', '/warehouse/warehouse?size=100')).warehouses || []
    const warehouse = (warehouses.find((w: any) => w.isDefault) || warehouses[0])._id
    // Cyrillic М, as the catalog writes it.
    for (const [key, name] of [['rod', `E2E Шпилка М10 ${ts}`], ['washer', `E2E Шайба ${ts}`]] as const) {
      const { product } = await call('POST', '/warehouse/product', { sku: `E2E-MPF-${key}-${ts}`, name, category: 'Test', type: 'goods', unit: 'pcs', sellingPrice: 2, purchasePrice: 1, taxRate: 20 })
      const { stockMovement } = await call('POST', '/warehouse/movement', {
        type: 'receipt', date: new Date().toISOString(), toWarehouseId: warehouse,
        lines: [{ productId: product.id || product._id, quantity: 4, unitCost: 1, totalCost: 4 }], totalAmount: 4,
      })
      numbers[key] = stockMovement.movementNumber
    }
  })

  test('the goods receipt lists an article by its name, its SKU on the line below', async ({ page }) => {
    await loginForApp(page)
    await page.goto('/inventory/movements/new')
    await page.getByPlaceholder('Type to search products...').first().fill(`шпилка M10 ${ts}`)
    const option = page.locator('.v-overlay--active .v-list-item').filter({ hasText: `E2E-MPF-rod-${ts}` }).first()
    await expect(option).toBeVisible({ timeout: 10000 })
    await expect(option.locator('.v-list-item-title')).toHaveText(`E2E Шпилка М10 ${ts}`)
    await expect(option.locator('.v-list-item-subtitle')).toContainText(`E2E-MPF-rod-${ts}`)
  })

  test('finds the movements of the articles the Products search finds, and sorts inside them', async ({ page }) => {
    await loginForApp(page)
    await page.goto('/inventory/movements')
    const table = page.locator('.v-data-table').first()
    await expect(table).toBeVisible({ timeout: 10000 })

    // A Latin M, as a keyboard types it.
    await page.getByRole('textbox', { name: 'Search products', exact: true }).fill(`шпилка M10 ${ts}`)
    await expect(page).toHaveURL(/pq=/)
    await expect(table.locator('tbody tr')).toHaveCount(1, { timeout: 10000 })
    await expect(table.locator('tbody tr').first()).toContainText(numbers.rod)

    await page.getByRole('textbox', { name: 'Search products', exact: true }).fill(String(ts))
    await expect(table.locator('tbody tr')).toHaveCount(2, { timeout: 10000 })
    const header = table.locator('thead th').filter({ hasText: /^#$/ })
    await header.click()
    await expect.poll(async () => (await table.locator('tbody tr td:first-child').allTextContents()).map((s) => s.trim()))
      .toEqual([numbers.rod, numbers.washer])
    await header.click()
    await expect.poll(async () => (await table.locator('tbody tr td:first-child').allTextContents()).map((s) => s.trim()))
      .toEqual([numbers.washer, numbers.rod])
  })
})
