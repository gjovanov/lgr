import { test, expect } from '@playwright/test'
import { loginForApp } from './helpers/login'

test.describe('POS Devices', () => {
  test('should navigate to POS Devices page and verify heading renders', async ({ page }) => {
    await loginForApp(page)
    await page.goto('/pos/devices')
    await page.waitForLoadState('networkidle')

    await expect(page.getByRole('heading', { name: /POS Devices/i })).toBeVisible()
  })

  test('should verify "New Device" button is present', async ({ page }) => {
    await loginForApp(page)
    await page.goto('/pos/devices')
    await page.waitForLoadState('networkidle')

    await expect(page.getByRole('link', { name: /New Device/i })).toBeVisible()
  })

  test('should click "New Device" and navigate to new device form', async ({ page }) => {
    await loginForApp(page)
    await page.goto('/pos/devices')
    await page.waitForLoadState('networkidle')

    await page.getByRole('link', { name: /New Device/i }).click()
    await page.waitForURL('**/devices/new')

    await expect(page.getByRole('heading', { name: /New POS Device/i })).toBeVisible()
  })

  test('should verify new device form has tabs (General, Operators tab hidden for new)', async ({ page }) => {
    await loginForApp(page)
    await page.goto('/pos/devices/new')
    await page.waitForLoadState('networkidle')

    // General tab should be visible
    await expect(page.getByRole('tab', { name: /General/i })).toBeVisible()

    // Operators and Reports tabs are hidden for new devices (v-if="!isNew")
    await expect(page.getByRole('tab', { name: /Operators/i })).toHaveCount(0)
    await expect(page.getByRole('tab', { name: /Reports/i })).toHaveCount(0)
  })

  test('should fill General tab fields and verify save button exists', async ({ page }) => {
    await loginForApp(page)
    await page.goto('/pos/devices/new')
    await page.waitForLoadState('networkidle')

    // Fill Name field
    await page.getByLabel(/^Name$/i).fill('Test POS Device')

    // Fill Device Number field (must be 8 chars)
    await page.getByLabel(/Device Number/i).fill('12345678')

    // Verify Create/Save button is present
    await expect(page.getByRole('button', { name: /Create|Save/i })).toBeVisible()
  })

  test('should verify operator table renders on Operators tab for existing device', async ({ page }) => {
    await loginForApp(page)
    await page.goto('/pos/devices')
    await page.waitForLoadState('networkidle')

    const table = page.locator('.v-data-table-server, .v-data-table')
    await expect(table).toBeVisible({ timeout: 10000 })

    // Check if there are existing devices
    const rows = table.locator('tbody tr')
    const rowCount = await rows.count()

    if (rowCount > 0) {
      const hasNoData = await rows.first().getByText(/No data/i).isVisible().catch(() => false)

      if (!hasNoData) {
        // Click the first device name link to go to detail
        const deviceLink = rows.first().locator('a').first()
        const hasLink = await deviceLink.isVisible({ timeout: 3000 }).catch(() => false)

        if (hasLink) {
          await deviceLink.click()
          await page.waitForLoadState('networkidle')

          // Click Operators tab
          await page.getByRole('tab', { name: /Operators/i }).click()

          // Verify operator table renders with expected columns
          const operatorTable = page.locator('.v-table')
          await expect(operatorTable).toBeVisible({ timeout: 5000 })
          await expect(operatorTable.locator('th', { hasText: /Name/i })).toBeVisible()
          await expect(operatorTable.locator('th', { hasText: /Password/i })).toBeVisible()
        }
      }
    }
  })

  test('should verify Reports tab has report buttons for existing device', async ({ page }) => {
    await loginForApp(page)
    await page.goto('/pos/devices')
    await page.waitForLoadState('networkidle')

    const table = page.locator('.v-data-table-server, .v-data-table')
    await expect(table).toBeVisible({ timeout: 10000 })

    // Check if there are existing devices
    const rows = table.locator('tbody tr')
    const rowCount = await rows.count()

    if (rowCount > 0) {
      const hasNoData = await rows.first().getByText(/No data/i).isVisible().catch(() => false)

      if (!hasNoData) {
        // Click the first device name link to go to detail
        const deviceLink = rows.first().locator('a').first()
        const hasLink = await deviceLink.isVisible({ timeout: 3000 }).catch(() => false)

        if (hasLink) {
          await deviceLink.click()
          await page.waitForLoadState('networkidle')

          // Click Reports tab
          await page.getByRole('tab', { name: /Reports/i }).click()

          // Verify report cards are visible
          await expect(page.getByText('Daily X-Report')).toBeVisible({ timeout: 5000 })
          await expect(page.getByText('Daily Z-Report')).toBeVisible()
          await expect(page.getByText('Operator Report')).toBeVisible()
          await expect(page.getByText('FM Report by Date')).toBeVisible()
          await expect(page.getByText('FM Report by Number')).toBeVisible()
          await expect(page.getByText('Electronic Journal (KLEN)')).toBeVisible()
        }
      }
    }
  })
})
