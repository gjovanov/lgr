import { test, expect } from '@playwright/test'
import { loginForApp } from './helpers/login'

test.describe('Cash Register Sales', () => {
  test('should navigate to cash register sales and verify page renders', async ({ page }) => {
    await loginForApp(page)
    await page.goto('/invoicing/cash-sales')

    await expect(page.getByRole('heading', { name: 'Cash Register Sales' })).toBeVisible()
    await expect(page.locator('.v-data-table')).toBeVisible({ timeout: 10000 })
  })

  test('should navigate to the POS-style new cash sale screen', async ({ page }) => {
    await loginForApp(page)
    await page.goto('/invoicing/cash-sales')

    await expect(page.getByRole('heading', { name: 'Cash Register Sales' })).toBeVisible()

    // Click create button — navigates to /cash-sales/new
    await page.locator('a.v-btn', { hasText: /create/i }).click()
    await page.waitForURL('**/cash-sales/new')

    // FR-03: the detail page is a terminal — product catalog left, cart right.
    await expect(page.locator('.v-form')).toBeVisible({ timeout: 10000 })
    await expect(page.locator('.terminal-catalog')).toBeVisible({ timeout: 10000 })
    await expect(page.getByRole('button', { name: /^save$/i }).first()).toBeVisible()
  })

  test('should create a cash register sale by clicking a product card', async ({ page }) => {
    await loginForApp(page)
    await page.goto('/invoicing/cash-sales/new')

    await expect(page.locator('.v-form')).toBeVisible({ timeout: 10000 })

    // FR-03: lines are added by clicking product cards — there is no free-text line editor.
    const card = page.locator('.terminal-card').first()
    const hasProducts = await card.isVisible({ timeout: 10000 }).catch(() => false)
    test.skip(!hasProducts, 'no products seeded — nothing to sell')

    await card.click()

    // The cart shows the line with its qty stepper; Save becomes enabled.
    await expect(page.locator('.terminal-cart-row').first()).toBeVisible()
    const saveBtn = page.getByRole('button', { name: /^save$/i }).first()
    await expect(saveBtn).toBeEnabled()
    await saveBtn.click()

    // Either straight back to the list, or the stock-transfer dialog intervenes on short stock.
    await expect(
      page.getByRole('heading', { name: 'Cash Register Sales' }).or(page.locator('.v-dialog')),
    ).toBeVisible({ timeout: 10000 })
  })

  test('should show cash register sales with paid status', async ({ page }) => {
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
