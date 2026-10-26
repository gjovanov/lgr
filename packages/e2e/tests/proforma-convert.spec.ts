import { test, expect } from '@playwright/test'
import { loginForApp } from './helpers/login'
import { rowAction } from './helpers/row-actions'

test.describe('Proforma to Invoice Conversion', () => {
  test('should display Invoice # column on proforma invoices list', async ({ page }) => {
    await loginForApp(page)
    await page.goto('/invoicing/proforma')

    await expect(page.locator('.v-data-table')).toBeVisible({ timeout: 10000 })
    const table = page.locator('.v-data-table')
    await expect(table.locator('th', { hasText: /invoice #/i }).first()).toBeVisible()
  })

  test('should show the proforma an invoice came from on the sales invoices list', async ({ page }) => {
    await loginForApp(page)
    await page.goto('/invoicing/invoices')

    await expect(page.locator('.v-data-table')).toBeVisible({ timeout: 10000 })
    const table = page.locator('.v-data-table')
    // FR-22.23: „Related document" — the proforma an invoice came from, or the invoice a note
    // corrects. It was two columns („Proforma #", „Related invoice"), each empty on most rows.
    await expect(table.locator('th', { hasText: /related document/i })).toBeVisible()
  })

  test('should navigate to new proforma form and verify it renders', async ({ page }) => {
    await loginForApp(page)
    await page.goto('/invoicing/proforma/new')

    // Verify form renders
    await expect(page.locator('.v-form')).toBeVisible({ timeout: 10000 })
    await expect(page.getByRole('button', { name: /^save$/i }).first()).toBeVisible()
  })

  test('should show convert button on proforma invoices list', async ({ page }) => {
    await loginForApp(page)
    await page.goto('/invoicing/proforma')

    await expect(page.locator('.v-data-table')).toBeVisible({ timeout: 10000 })

    // If proforma rows exist, check for convert button
    const rows = page.locator('.v-data-table tbody tr')
    const rowCount = await rows.count()
    if (rowCount > 0) {
      const hasNoData = await rows.first().getByText('No data available').isVisible().catch(() => false)
      if (!hasNoData) {
        // FR-22.23: the row's actions are in its ⋮ menu, and Convert is offered on a proforma
        // that is not yet converted, voided or cancelled.
        const open = rows.filter({ hasNotText: /converted|voided|cancelled/i }).first()
        if (await open.isVisible({ timeout: 3000 }).catch(() => false)) {
          await expect(await rowAction(open, 'convert')).toBeVisible()
        }
      }
    }
  })
})
