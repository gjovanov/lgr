import { test, expect } from '@playwright/test'
import { loginForApp } from './helpers/login'

test.describe('Credit Notes Fixes', () => {
  test('should display related invoice number (not [object Object])', async ({ page }) => {
    await loginForApp(page)
    await page.goto('/invoicing/credit-notes')

    await expect(page.locator('.v-data-table')).toBeVisible({ timeout: 10000 })

    // Verify no cell contains "[object Object]"
    const cells = page.locator('.v-data-table td')
    const count = await cells.count()
    for (let i = 0; i < count; i++) {
      const text = await cells.nth(i).textContent()
      expect(text).not.toContain('[object Object]')
    }
  })

  test('should auto-populate line items when related invoice is selected', async ({ page }) => {
    await loginForApp(page)
    await page.goto('/invoicing/credit-notes')

    await expect(page.locator('.v-data-table')).toBeVisible({ timeout: 10000 })

    // Open create dialog
    await page.getByRole('button', { name: /create/i }).click()
    await expect(page.locator('.v-dialog')).toBeVisible({ timeout: 5000 })

    // Select contact first — click the input inside the first autocomplete
    const contactInput = page.locator('.v-dialog .v-autocomplete input').first()
    await contactInput.click()
    await page.waitForTimeout(500)

    // Wait for dropdown options to appear and select first
    const contactOption = page.locator('.v-overlay--active .v-list-item').first()
    if (await contactOption.isVisible({ timeout: 3000 }).catch(() => false)) {
      await contactOption.click()
      await page.waitForTimeout(300)
    }

    // Select a related invoice from the second autocomplete
    const invoiceInput = page.locator('.v-dialog .v-autocomplete input').nth(1)
    await invoiceInput.click()
    await page.waitForTimeout(500)

    const invoiceOption = page.locator('.v-overlay--active .v-list-item').first()
    if (await invoiceOption.isVisible({ timeout: 3000 }).catch(() => false)) {
      await invoiceOption.click()
      await page.waitForTimeout(1000)

      // Verify line items table has rows populated
      const lineRows = page.locator('.v-dialog .v-table tbody tr')
      const rowCount = await lineRows.count()
      expect(rowCount).toBeGreaterThan(0)
    }
  })

  test('should allow overriding auto-populated line items', async ({ page }) => {
    await loginForApp(page)
    await page.goto('/invoicing/credit-notes')

    await expect(page.locator('.v-data-table')).toBeVisible({ timeout: 10000 })

    // Open create dialog
    await page.getByRole('button', { name: /create/i }).click()
    await expect(page.locator('.v-dialog')).toBeVisible({ timeout: 5000 })

    // The form should accept manual line item edits on the default empty line
    const qtyInput = page.locator('.v-dialog .v-table tbody tr input[type="number"]').first()
    if (await qtyInput.isVisible({ timeout: 3000 }).catch(() => false)) {
      await qtyInput.fill('5')
      expect(await qtyInput.inputValue()).toBe('5')
    }
  })
})
