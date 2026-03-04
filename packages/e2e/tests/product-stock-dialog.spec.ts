import { test, expect } from '@playwright/test'
import { loginForApp } from './helpers/login'

test.describe('Product Stock Dialog', () => {
  test('should show stock info button in products list actions', async ({ page }) => {
    await loginForApp(page)
    await page.goto('/warehouse/products')

    await expect(page.locator('.v-data-table')).toBeVisible({ timeout: 10000 })

    // Verify first row has a chart/stock icon button (mdi-chart-box)
    const stockBtn = page.locator('.v-data-table tbody tr').first().locator('.mdi-chart-box')
    if (await page.locator('.v-data-table tbody tr').count() > 0) {
      await expect(stockBtn).toBeVisible()
    }
  })

  test('should open product stock dialog with 3 tabs', async ({ page }) => {
    await loginForApp(page)
    await page.goto('/warehouse/products')

    await expect(page.locator('.v-data-table')).toBeVisible({ timeout: 10000 })

    const rows = page.locator('.v-data-table tbody tr')
    if (await rows.count() > 0) {
      // Click the stock icon on first row
      const stockBtn = rows.first().locator('.mdi-chart-box')
      await stockBtn.click()
      await page.waitForTimeout(500)

      // Verify dialog opens
      await expect(page.locator('.v-dialog')).toBeVisible({ timeout: 5000 })

      // Verify 3 tabs
      const tabs = page.locator('.v-dialog .v-tab')
      await expect(tabs).toHaveCount(3)
    }
  })

  test('should display stock levels for the selected product', async ({ page }) => {
    await loginForApp(page)
    await page.goto('/warehouse/products')

    await expect(page.locator('.v-data-table')).toBeVisible({ timeout: 10000 })

    const rows = page.locator('.v-data-table tbody tr')
    if (await rows.count() > 0) {
      const stockBtn = rows.first().locator('.mdi-chart-box')
      await stockBtn.click()
      await page.waitForTimeout(500)

      await expect(page.locator('.v-dialog')).toBeVisible({ timeout: 5000 })

      // Stock Levels tab should be active by default
      const levelTab = page.locator('.v-dialog .v-tab').first()
      await levelTab.click()
      await page.waitForTimeout(300)

      // Verify data table is visible in the tab
      await expect(page.locator('.v-dialog .v-data-table')).toBeVisible()
    }
  })

  test('should display movements for the selected product', async ({ page }) => {
    await loginForApp(page)
    await page.goto('/warehouse/products')

    await expect(page.locator('.v-data-table')).toBeVisible({ timeout: 10000 })

    const rows = page.locator('.v-data-table tbody tr')
    if (await rows.count() > 0) {
      const stockBtn = rows.first().locator('.mdi-chart-box')
      await stockBtn.click()
      await page.waitForTimeout(500)

      await expect(page.locator('.v-dialog')).toBeVisible({ timeout: 5000 })

      // Click Movements tab
      const movementTab = page.locator('.v-dialog .v-tab').nth(1)
      await movementTab.click()
      await page.waitForTimeout(300)

      // Verify data table is visible
      await expect(page.locator('.v-dialog .v-data-table')).toBeVisible()
    }
  })

  test('should display inventory counts for the selected product', async ({ page }) => {
    await loginForApp(page)
    await page.goto('/warehouse/products')

    await expect(page.locator('.v-data-table')).toBeVisible({ timeout: 10000 })

    const rows = page.locator('.v-data-table tbody tr')
    if (await rows.count() > 0) {
      const stockBtn = rows.first().locator('.mdi-chart-box')
      await stockBtn.click()
      await page.waitForTimeout(500)

      await expect(page.locator('.v-dialog')).toBeVisible({ timeout: 5000 })

      // Click Inventory Counts tab
      const countTab = page.locator('.v-dialog .v-tab').nth(2)
      await countTab.click()
      await page.waitForTimeout(300)

      // Verify data table is visible
      await expect(page.locator('.v-dialog .v-data-table')).toBeVisible()
    }
  })
})
