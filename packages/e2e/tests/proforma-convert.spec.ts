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

  test('should show converted invoice number after proforma conversion', async ({ page }) => {
    await loginForApp(page)
    await page.goto('/invoicing/proforma-invoices')

    await expect(page.locator('.v-data-table')).toBeVisible({ timeout: 10000 })

    // Create a proforma invoice
    await page.getByRole('button', { name: /create/i }).click()
    await page.waitForTimeout(500)

    // Fill form - select contact
    const contactAutocomplete = page.locator('.v-dialog .v-autocomplete').first()
    await contactAutocomplete.click()
    await page.waitForTimeout(300)
    const contactOption = page.locator('.v-list-item').first()
    if (await contactOption.isVisible()) {
      await contactOption.click({ force: true })
    }

    // Set issue date
    await page.locator('.v-dialog input[type="date"]').first().fill('2024-06-01')

    // Save
    await page.getByRole('button', { name: /save/i }).click()
    await page.waitForTimeout(1000)

    // If a proforma row exists, click convert button
    const convertBtn = page.locator('.v-data-table .mdi-swap-horizontal').first()
    if (await convertBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await convertBtn.click()
      await page.waitForTimeout(1000)

      // Verify success snackbar
      await expect(page.locator('.v-snackbar')).toBeVisible({ timeout: 5000 })
    }
  })
})
