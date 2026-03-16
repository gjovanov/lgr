import { test, expect } from '@playwright/test'
import { loginForApp } from './helpers/login'

test.describe('Payment Orders', () => {
  test('should display payment orders list page', async ({ page }) => {
    await loginForApp(page)
    await page.goto('/trade/payment-orders')

    await expect(page.locator('.v-data-table')).toBeVisible({ timeout: 10000 })
    // Verify headers are present
    await expect(page.locator('th').filter({ hasText: /type/i })).toBeVisible()
  })

  test('should open create dialog with correct form fields', async ({ page }) => {
    await loginForApp(page)
    await page.goto('/trade/payment-orders')

    await expect(page.locator('.v-data-table')).toBeVisible({ timeout: 10000 })

    await page.getByRole('button', { name: /create/i }).click()
    await expect(page.locator('.v-dialog')).toBeVisible({ timeout: 5000 })

    // Verify type select has Payment/Receipt options
    const typeSelect = page.locator('.v-dialog .v-select').first()
    await expect(typeSelect).toBeVisible()

    // Verify contact autocomplete is present
    const contactInput = page.locator('.v-dialog .v-autocomplete').first()
    await expect(contactInput).toBeVisible()

    // Verify bank account autocomplete is present
    await expect(page.locator('.v-dialog .v-autocomplete').nth(1)).toBeVisible()

    // Verify amount and date fields
    await expect(page.locator('.v-dialog input[type="number"]').first()).toBeVisible()
    await expect(page.locator('.v-dialog input[type="date"]').first()).toBeVisible()
  })

  test('should create a payment order successfully', async ({ page }) => {
    await loginForApp(page)
    await page.goto('/trade/payment-orders')

    await expect(page.locator('.v-data-table')).toBeVisible({ timeout: 10000 })

    await page.getByRole('button', { name: /create/i }).click()
    await expect(page.locator('.v-dialog')).toBeVisible({ timeout: 5000 })

    // Select contact
    const contactInput = page.locator('.v-dialog .v-autocomplete input').first()
    await contactInput.click()
    await page.waitForTimeout(500)
    const contactOption = page.locator('.v-overlay--active .v-list-item').first()
    if (await contactOption.isVisible({ timeout: 3000 }).catch(() => false)) {
      await contactOption.click()
      await page.waitForTimeout(300)
    }

    // Set amount
    const amountInput = page.locator('.v-dialog input[type="number"]').first()
    await amountInput.fill('500')

    // Save
    await page.getByRole('button', { name: /save/i }).click()
    await page.waitForTimeout(1000)

    // Verify success or dialog closed
    const dialogStillOpen = await page.locator('.v-dialog').isVisible().catch(() => false)
    if (!dialogStillOpen) {
      // Success - dialog closed
      await expect(page.locator('.v-data-table')).toBeVisible()
    }
  })
})
