import { test, expect } from '@playwright/test'
import { loginForApp } from './helpers/login'

test.describe('Product Stock Dialog', () => {
  test('should show stock info button in products list actions', async ({ page }) => {
    await loginForApp(page)
    await page.goto('/warehouse/products')

    await expect(page.locator('.v-data-table')).toBeVisible({ timeout: 10000 })

    if (await page.locator('.v-data-table tbody tr').count() > 0) {
      // Verify first row has a stock icon button (title="Product Stock")
      const stockBtn = page.locator('.v-data-table tbody tr').first().locator('button[title]').first()
      await expect(stockBtn).toBeVisible()
    }
  })

  test('should open product stock dialog with 4 tabs', async ({ page }) => {
    await loginForApp(page)
    await page.goto('/warehouse/products')

    await expect(page.locator('.v-data-table')).toBeVisible({ timeout: 10000 })

    const rows = page.locator('.v-data-table tbody tr')
    if (await rows.count() > 0) {
      // Click the first icon button in the actions column
      const stockBtn = rows.first().locator('button[title]').first()
      await stockBtn.click()
      await page.waitForTimeout(500)

      // Verify dialog opens
      await expect(page.locator('.v-dialog')).toBeVisible({ timeout: 5000 })

      // Verify 4 tabs (Levels, Ledger, Movements, Counts)
      const tabs = page.locator('.v-dialog .v-tab')
      await expect(tabs).toHaveCount(4)
    }
  })

  test('should display stock levels for the selected product', async ({ page }) => {
    await loginForApp(page)
    await page.goto('/warehouse/products')

    await expect(page.locator('.v-data-table')).toBeVisible({ timeout: 10000 })

    const rows = page.locator('.v-data-table tbody tr')
    if (await rows.count() > 0) {
      const stockBtn = rows.first().locator('button[title]').first()
      await stockBtn.click()
      await page.waitForTimeout(500)

      await expect(page.locator('.v-dialog')).toBeVisible({ timeout: 5000 })

      // Stock Levels tab should be active by default
      const levelTab = page.locator('.v-dialog .v-tab').first()
      await levelTab.click()
      await page.waitForTimeout(500)

      // Verify a data table is visible in the active tab window
      await expect(page.locator('.v-dialog .v-window-item--active .v-data-table')).toBeVisible({ timeout: 5000 })
    }
  })

  test('should display movements for the selected product', async ({ page }) => {
    await loginForApp(page)
    await page.goto('/warehouse/products')

    await expect(page.locator('.v-data-table')).toBeVisible({ timeout: 10000 })

    const rows = page.locator('.v-data-table tbody tr')
    if (await rows.count() > 0) {
      const stockBtn = rows.first().locator('button[title]').first()
      await stockBtn.click()
      await page.waitForTimeout(500)

      await expect(page.locator('.v-dialog')).toBeVisible({ timeout: 5000 })

      // Click Movements tab (index 2: Levels=0, Ledger=1, Movements=2, Counts=3)
      const movementTab = page.locator('.v-dialog .v-tab').nth(2)
      await movementTab.click()
      await page.waitForTimeout(500)

      // Verify data table is visible in the active tab window
      await expect(page.locator('.v-dialog .v-window-item--active .v-data-table')).toBeVisible({ timeout: 5000 })
    }
  })

  test('should display inventory counts for the selected product', async ({ page }) => {
    await loginForApp(page)
    await page.goto('/warehouse/products')

    await expect(page.locator('.v-data-table')).toBeVisible({ timeout: 10000 })

    const rows = page.locator('.v-data-table tbody tr')
    if (await rows.count() > 0) {
      const stockBtn = rows.first().locator('button[title]').first()
      await stockBtn.click()
      await page.waitForTimeout(500)

      await expect(page.locator('.v-dialog')).toBeVisible({ timeout: 5000 })

      // Click Inventory Counts tab (index 3)
      const countTab = page.locator('.v-dialog .v-tab').nth(3)
      await countTab.click()
      await page.waitForTimeout(500)

      // Verify data table is visible in the active tab window
      await expect(page.locator('.v-dialog .v-window-item--active .v-data-table')).toBeVisible({ timeout: 5000 })
    }
  })
})
