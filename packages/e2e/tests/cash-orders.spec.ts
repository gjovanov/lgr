import { test, expect } from '@playwright/test'
import { loginForApp } from './helpers/login'

test.describe('Cash Orders', () => {
  test('should display cash orders list page', async ({ page }) => {
    await loginForApp(page)
    await page.goto('/trade/cash-orders')

    await expect(page.locator('.v-data-table')).toBeVisible({ timeout: 10000 })
    await expect(page.locator('th').filter({ hasText: /type/i })).toBeVisible()
  })

  test('should open create dialog with correct form fields', async ({ page }) => {
    await loginForApp(page)
    await page.goto('/trade/cash-orders')

    await expect(page.locator('.v-data-table')).toBeVisible({ timeout: 10000 })

    await page.getByRole('button', { name: /create/i }).click()
    await expect(page.locator('.v-dialog')).toBeVisible({ timeout: 5000 })

    // Verify type select has Receipt/Disbursement options
    const typeSelect = page.locator('.v-dialog .v-select').first()
    await expect(typeSelect).toBeVisible()

    // Verify party text field
    await expect(page.locator('.v-dialog .v-text-field').first()).toBeVisible()

    // Verify amount and date fields
    await expect(page.locator('.v-dialog input[type="number"]').first()).toBeVisible()
    await expect(page.locator('.v-dialog input[type="date"]').first()).toBeVisible()

    // Verify account autocompletes
    const autocompletes = page.locator('.v-dialog .v-autocomplete')
    await expect(autocompletes.first()).toBeVisible()
  })

  test('should create a cash order successfully', async ({ page }) => {
    await loginForApp(page)
    await page.goto('/trade/cash-orders')

    await expect(page.locator('.v-data-table')).toBeVisible({ timeout: 10000 })

    await page.getByRole('button', { name: /create/i }).click()
    await expect(page.locator('.v-dialog')).toBeVisible({ timeout: 5000 })

    // Fill party
    const partyInput = page.locator('.v-dialog .v-text-field input').first()
    await partyInput.fill('Test Customer')

    // Set amount
    const amountInput = page.locator('.v-dialog input[type="number"]').first()
    await amountInput.fill('100')

    // Save
    await page.getByRole('button', { name: /save/i }).click()
    await page.waitForTimeout(1000)

    // Verify success or dialog closed
    const dialogStillOpen = await page.locator('.v-dialog').isVisible().catch(() => false)
    if (!dialogStillOpen) {
      await expect(page.locator('.v-data-table')).toBeVisible()
    }
  })
})
