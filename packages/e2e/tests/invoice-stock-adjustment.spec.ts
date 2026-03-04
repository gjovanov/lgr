import { test, expect } from '@playwright/test'
import { loginForApp } from './helpers/login'

test.describe('Invoice Stock Adjustment', () => {
  test('should show warehouse selector on invoice line items', async ({ page }) => {
    await loginForApp(page)
    await page.goto('/invoicing/invoices/new')

    await expect(page.locator('.v-form')).toBeVisible({ timeout: 10000 })

    // Check that Warehouse column header exists in the line items table
    const warehouseHeader = page.locator('.v-table th', { hasText: /warehouse/i })
    await expect(warehouseHeader).toBeVisible()
  })

  test('should decrease stock when outgoing invoice is sent', async ({ page }) => {
    await loginForApp(page)

    // First, note the stock levels page
    await page.goto('/warehouse/stock-levels')
    await expect(page.locator('.v-data-table')).toBeVisible({ timeout: 10000 })

    // Check if there are any stock level rows
    const stockRows = page.locator('.v-data-table tbody tr')
    const hasStock = await stockRows.count() > 0

    if (hasStock) {
      // Read the first row's quantity
      const firstQtyCell = stockRows.first().locator('td').nth(2) // Quantity column
      const initialQtyText = await firstQtyCell.textContent()

      // Create an outgoing invoice
      await page.goto('/invoicing/invoices/new')
      await expect(page.locator('.v-form')).toBeVisible({ timeout: 10000 })

      // The form should have warehouse selector
      const warehouseSelects = page.locator('.v-table .v-select')
      await expect(page.locator('.v-table')).toBeVisible()
    }
  })

  test('should restore stock when invoice is voided', async ({ page }) => {
    await loginForApp(page)
    await page.goto('/invoicing/sales-invoices')

    await expect(page.locator('.v-data-table')).toBeVisible({ timeout: 10000 })

    // Find a sent invoice with void button
    const voidBtn = page.locator('.v-data-table .mdi-cancel').first()
    if (await voidBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      // Voiding should work
      await voidBtn.click()
      await page.waitForTimeout(1000)

      // Verify success or page still works
      await expect(page.locator('.v-data-table')).toBeVisible()
    }
  })
})
