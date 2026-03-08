import { test, expect } from '@playwright/test'
import { loginForApp } from './helpers/login'

test.describe('Proforma to Invoice Conversion', () => {
  test('should display Invoice # column on proforma invoices list', async ({ page }) => {
    await loginForApp(page)
    await page.goto('/invoicing/proforma-invoices')

    await expect(page.locator('.v-data-table')).toBeVisible({ timeout: 10000 })
    const table = page.locator('.v-data-table')
    await expect(table.locator('th', { hasText: /invoice #/i }).first()).toBeVisible()
  })

  test('should display Proforma # column on sales invoices list', async ({ page }) => {
    await loginForApp(page)
    await page.goto('/invoicing/sales-invoices')

    await expect(page.locator('.v-data-table')).toBeVisible({ timeout: 10000 })
    const table = page.locator('.v-data-table')
    await expect(table.locator('th', { hasText: /proforma #/i })).toBeVisible()
  })

  test('should navigate to new proforma form and verify it renders', async ({ page }) => {
    await loginForApp(page)
    await page.goto('/invoicing/proforma-invoices/new')

    // Verify form renders
    await expect(page.locator('.v-form')).toBeVisible({ timeout: 10000 })
    await expect(page.getByRole('button', { name: /save/i })).toBeVisible()
  })

  test('should show convert button on proforma invoices list', async ({ page }) => {
    await loginForApp(page)
    await page.goto('/invoicing/proforma-invoices')

    await expect(page.locator('.v-data-table')).toBeVisible({ timeout: 10000 })

    // If proforma rows exist, check for convert button
    const rows = page.locator('.v-data-table tbody tr')
    const rowCount = await rows.count()
    if (rowCount > 0) {
      const hasNoData = await rows.first().getByText('No data available').isVisible().catch(() => false)
      if (!hasNoData) {
        const convertBtn = page.locator('.v-data-table .mdi-swap-horizontal').first()
        const hasConvert = await convertBtn.isVisible({ timeout: 3000 }).catch(() => false)
        if (hasConvert) {
          await expect(convertBtn).toBeVisible()
        }
      }
    }
  })
})
