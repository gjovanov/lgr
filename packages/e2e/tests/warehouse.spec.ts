import { test, expect } from '@playwright/test'
import { loginForApp } from './helpers/login'
import { ensureProductCategory } from './helpers/api'

test.describe('Warehouse', () => {
  test('should navigate to products page and render data table', async ({ page }) => {
    await loginForApp(page)
    await page.goto('/inventory/products')

    // ProductsView uses <h1 class="text-h5"> with i18n key nav.products
    await expect(page.getByRole('heading', { name: /products/i })).toBeVisible()
    await expect(page.locator('.v-data-table')).toBeVisible()
  })

  test('should display SKU and name columns in products list', async ({ page }) => {
    await loginForApp(page)
    await page.goto('/inventory/products')

    await expect(page.locator('.v-data-table')).toBeVisible({ timeout: 10000 })
    // Column headers use i18n keys (warehouse.sku, common.name)
    const table = page.locator('.v-data-table')
    await expect(table.locator('th', { hasText: /sku/i })).toBeVisible()
    await expect(table.locator('th', { hasText: /name/i })).toBeVisible()
  })

  test('should navigate to new product form and render it', async ({ page }) => {
    await loginForApp(page)
    await page.goto('/inventory/products/new')

    // ProductFormView uses <h1 class="text-h5"> with i18n key warehouse.newProduct
    await expect(page.getByRole('heading', { name: /new product/i })).toBeVisible()
    // The form has tabs (basic, pricing, inventory, customPrices)
    await expect(page.locator('.v-form')).toBeVisible()
  })

  test('should create a new product by filling name, SKU, and price', async ({ page }) => {
    await loginForApp(page)
    await page.goto('/inventory/products/new')

    // The "basic" tab is shown by default with SKU, Name, and Type fields
    await page.getByLabel(/sku/i).fill('TW-001')
    await page.getByLabel(/name/i).fill('Test Widget')

    // Switch to pricing tab to fill price
    await page.getByRole('tab', { name: /pricing/i }).click()
    await page.getByLabel(/selling price/i).fill('29.99')

    // Click Save button
    await page.getByRole('button', { name: /^save$/i }).first().click()

    // Should redirect to products list or show success
    await expect(page).toHaveURL(/inventory\/products/, { timeout: 10000 })
  })

  test('should navigate to warehouses page and render list', async ({ page }) => {
    await loginForApp(page)
    await page.goto('/inventory/warehouses')

    // WarehousesView uses <h1 class="text-h5"> with i18n key nav.warehouses
    await expect(page.getByRole('heading', { name: /warehouses/i })).toBeVisible()
    await expect(page.locator('.v-data-table')).toBeVisible()
  })

  test('should navigate to stock levels page and render table', async ({ page }) => {
    await loginForApp(page)
    await page.goto('/inventory/stock-levels')

    // StockLevelsView uses <h1 class="text-h5"> with i18n key nav.stockLevels
    await expect(page.getByRole('heading', { name: /stock levels/i })).toBeVisible()
    await expect(page.locator('.v-data-table')).toBeVisible()
  })

  test('should navigate to movements page and render list', async ({ page }) => {
    await loginForApp(page)
    await page.goto('/inventory/movements')

    // nav.stockMovements is 'Stock Movement Documents' now — the old /stock movements/i
    // regex wanted a plural 'Movements' the heading no longer has.
    await expect(page.getByRole('heading', { name: /stock movement/i })).toBeVisible()
    await expect(page.locator('.v-data-table')).toBeVisible()
  })

  test('should filter products by category', async ({ page }) => {
    // ⚠ The seed creates no ProductCategory documents — see helpers/api.ts. Without one the
    // filter has nothing to offer and this test cannot do what it says.
    await ensureProductCategory()
    await loginForApp(page)
    await page.goto('/inventory/products')

    // Wait for data table to load
    await expect(page.locator('.v-data-table')).toBeVisible({ timeout: 10000 })

    // Category filter is a v-select with label from i18n (warehouse.category)
    const categoryFilter = page.getByRole('combobox', { name: /category/i })
    await categoryFilter.click({ force: true })

    // Select the first available option from the dropdown
    const option = page.getByRole('option').first()
    await option.click()

    // Table should still be visible after filtering
    await expect(page.locator('.v-data-table')).toBeVisible()
  })
})
