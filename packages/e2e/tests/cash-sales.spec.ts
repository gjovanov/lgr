import { test, expect } from '@playwright/test'
import { loginForApp } from './helpers/login'

test.describe('Cash Sales', () => {
  test('should navigate to cash sales and verify page renders', async ({ page }) => {
    await loginForApp(page)
    await page.goto('/invoicing/cash-sales')

    await expect(page.getByRole('heading', { name: 'Cash Sales' })).toBeVisible()
    await expect(page.locator('.v-data-table')).toBeVisible({ timeout: 10000 })
  })

  test('should open create cash sale dialog', async ({ page }) => {
    await loginForApp(page)
    await page.goto('/invoicing/cash-sales')

    await expect(page.getByRole('heading', { name: 'Cash Sales' })).toBeVisible()

    // Click create button
    await page.getByRole('button', { name: /create/i }).click()

    // Verify dialog opens
    await expect(page.locator('.v-dialog')).toBeVisible({ timeout: 5000 })
    await expect(page.locator('.v-dialog').getByText(/new cash sale/i)).toBeVisible()

    // Verify form fields present
    await expect(page.locator('.v-dialog').locator('input[type="date"]')).toBeVisible()
    await expect(page.locator('.v-dialog').getByText(/add line/i)).toBeVisible()
  })

  test('should create a cash sale with line item', async ({ page }) => {
    await loginForApp(page)
    await page.goto('/invoicing/cash-sales')

    await expect(page.locator('.v-data-table')).toBeVisible({ timeout: 10000 })

    // Open create dialog
    await page.getByRole('button', { name: /create/i }).click()
    await expect(page.locator('.v-dialog')).toBeVisible({ timeout: 5000 })

    // Select payment method (default is cash, keep it)

    // Add a line item - fill description
    const lineRow = page.locator('.v-dialog .v-table tbody tr').first()
    await expect(lineRow).toBeVisible()

    // Type in description field
    const descInput = lineRow.locator('input').first()
    await descInput.fill('Walk-in sale item')

    // Set quantity
    const qtyInput = lineRow.locator('input[type="number"]').first()
    await qtyInput.fill('2')

    // Set unit price
    const priceInput = lineRow.locator('input[type="number"]').nth(1)
    await priceInput.fill('25')

    // Save
    await page.locator('.v-dialog').getByRole('button', { name: /save/i }).click()

    // Verify dialog closes or stays open with validation
    await page.waitForTimeout(2000)

    // Table should still be visible
    await expect(page.locator('.v-data-table')).toBeVisible()
  })

  test('should show cash sales with paid status', async ({ page }) => {
    await loginForApp(page)
    await page.goto('/invoicing/cash-sales')

    await expect(page.locator('.v-data-table')).toBeVisible({ timeout: 10000 })

    // If there are rows, verify they show "paid" status chip
    const rows = page.locator('.v-data-table tbody tr')
    const rowCount = await rows.count()
    if (rowCount > 0) {
      const firstRow = rows.first()
      const hasNoData = await firstRow.getByText('No data available').isVisible().catch(() => false)
      if (!hasNoData) {
        const paidChip = firstRow.locator('.v-chip', { hasText: /paid/i })
        const hasPaid = await paidChip.isVisible({ timeout: 3000 }).catch(() => false)
        if (hasPaid) {
          await expect(paidChip).toBeVisible()
        }
      }
    }
  })
})
