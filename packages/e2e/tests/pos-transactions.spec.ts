import { test, expect } from '@playwright/test'
import { loginForApp } from './helpers/login'

test.describe('POS Transactions', () => {
  test('should navigate to POS Transactions page and verify heading renders', async ({ page }) => {
    await loginForApp(page)
    await page.goto('/pos/orders')
    await page.waitForLoadState('networkidle')

    await expect(page.getByRole('heading', { name: /POS Transactions/i })).toBeVisible()
  })

  test('should verify filter controls are present (search, type, status)', async ({ page }) => {
    await loginForApp(page)
    await page.goto('/pos/orders')
    await page.waitForLoadState('networkidle')

    // Search input
    await expect(page.getByLabel(/search/i)).toBeVisible()

    // Type select (Vuetify v-select)
    await expect(page.getByRole('combobox', { name: /Type/i })).toBeVisible()

    // Status select (Vuetify v-select)
    await expect(page.getByRole('combobox', { name: /Status/i })).toBeVisible()
  })

  test('should verify data table renders with correct column headers', async ({ page }) => {
    await loginForApp(page)
    await page.goto('/pos/orders')
    await page.waitForLoadState('networkidle')

    const table = page.locator('.v-data-table-server, .v-data-table')
    await expect(table).toBeVisible({ timeout: 10000 })

    // Verify column headers
    await expect(table.locator('th', { hasText: /Transaction #/i })).toBeVisible()
    await expect(table.locator('th', { hasText: /Type/i })).toBeVisible()
    await expect(table.locator('th', { hasText: /Status/i })).toBeVisible()
    await expect(table.locator('th', { hasText: /UNP/i })).toBeVisible()
    await expect(table.locator('th', { hasText: /Total/i })).toBeVisible()
    await expect(table.locator('th', { hasText: /Payment/i })).toBeVisible()
    await expect(table.locator('th', { hasText: /Fiscal/i })).toBeVisible()
  })

  test('should verify pagination controls are present', async ({ page }) => {
    await loginForApp(page)
    await page.goto('/pos/orders')
    await page.waitForLoadState('networkidle')

    const table = page.locator('.v-data-table-server, .v-data-table')
    await expect(table).toBeVisible({ timeout: 10000 })

    // Vuetify server data table includes pagination footer
    const footer = page.locator('.v-data-table-footer')
    await expect(footer).toBeVisible()
  })

  test('should apply type filter "sale" and verify table updates without errors', async ({ page }) => {
    await loginForApp(page)
    await page.goto('/pos/orders')
    await page.waitForLoadState('networkidle')

    const table = page.locator('.v-data-table-server, .v-data-table')
    await expect(table).toBeVisible({ timeout: 10000 })

    // Click the Type combobox
    const typeSelect = page.getByRole('combobox', { name: /Type/i })
    await typeSelect.click({ force: true })

    // Select "sale" option
    const saleOption = page.getByRole('option', { name: /sale/i })
    await saleOption.click()

    // Wait for network to settle after filter change
    await page.waitForLoadState('networkidle')

    // Table should still be visible (no crash)
    await expect(table).toBeVisible()
  })

  test('should apply search text and verify no crash', async ({ page }) => {
    await loginForApp(page)
    await page.goto('/pos/orders')
    await page.waitForLoadState('networkidle')

    const table = page.locator('.v-data-table-server, .v-data-table')
    await expect(table).toBeVisible({ timeout: 10000 })

    // Type in the search field
    const searchField = page.getByLabel(/search/i)
    await searchField.fill('test-search-query')

    // Wait for debounced search to trigger
    await page.waitForLoadState('networkidle')

    // Table should still be visible (no crash)
    await expect(table).toBeVisible()
  })

  test('should navigate to detail page if rows exist and verify back button', async ({ page }) => {
    await loginForApp(page)
    await page.goto('/pos/orders')
    await page.waitForLoadState('networkidle')

    const table = page.locator('.v-data-table-server, .v-data-table')
    await expect(table).toBeVisible({ timeout: 10000 })

    // Check if there are data rows
    const rows = table.locator('tbody tr')
    const rowCount = await rows.count()

    if (rowCount > 0) {
      const firstRow = rows.first()
      const hasNoData = await firstRow.getByText(/No data/i).isVisible().catch(() => false)

      if (!hasNoData) {
        // Click the first row's eye icon (detail link)
        const detailBtn = firstRow.locator('a[href*="orders"], .v-btn')
        const hasLink = await detailBtn.first().isVisible({ timeout: 3000 }).catch(() => false)

        if (hasLink) {
          await detailBtn.first().click()
          await page.waitForLoadState('networkidle')

          // Should be on detail page
          await expect(page).toHaveURL(/orders\//)

          // Verify back button is present (mdi-arrow-left icon button)
          const backButton = page.locator('button.v-btn', { has: page.locator('.mdi-arrow-left') })
          await expect(backButton).toBeVisible()
        }
      }
    }
  })
})
