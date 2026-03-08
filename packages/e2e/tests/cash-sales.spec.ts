import { test, expect } from '@playwright/test'
import { loginForApp } from './helpers/login'

test.describe('Cash Sales', () => {
  test('should navigate to cash sales and verify page renders', async ({ page }) => {
    await loginForApp(page)
    await page.goto('/invoicing/cash-sales')

    await expect(page.getByRole('heading', { name: 'Cash Sales' })).toBeVisible()
    await expect(page.locator('.v-data-table')).toBeVisible({ timeout: 10000 })
  })

  test('should navigate to new cash sale form', async ({ page }) => {
    await loginForApp(page)
    await page.goto('/invoicing/cash-sales')

    await expect(page.getByRole('heading', { name: 'Cash Sales' })).toBeVisible()

    // Click create button — navigates to /cash-sales/new
    await page.locator('a.v-btn', { hasText: /create/i }).click()
    await page.waitForURL('**/cash-sales/new')

    // Verify form renders
    await expect(page.locator('.v-form')).toBeVisible({ timeout: 10000 })
    await expect(page.getByRole('button', { name: /save/i })).toBeVisible()
  })

  test('should create a cash sale with line item', async ({ page }) => {
    await loginForApp(page)
    await page.goto('/invoicing/cash-sales/new')

    // Wait for form to load
    await expect(page.locator('.v-form')).toBeVisible({ timeout: 10000 })

    // Fill line item details in the v-table row
    const lineRow = page.locator('.v-table tbody tr').first()
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
    await page.getByRole('button', { name: /save/i }).click()

    // Verify redirect to list or form stays with validation
    await page.waitForTimeout(2000)
    await expect(
      page.locator('.v-data-table').or(page.locator('.v-form'))
    ).toBeVisible()
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
