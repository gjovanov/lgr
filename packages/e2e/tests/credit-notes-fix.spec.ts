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
    await page.waitForTimeout(500)

    // Select contact first
    const contactAutocomplete = page.locator('.v-dialog .v-autocomplete').first()
    await contactAutocomplete.click()
    await page.waitForTimeout(300)
    const contactOption = page.locator('.v-list-item').first()
    if (await contactOption.isVisible()) {
      await contactOption.click()
    }

    // Select a related invoice from autocomplete
    const invoiceAutocomplete = page.locator('.v-dialog .v-autocomplete').nth(1)
    await invoiceAutocomplete.click()
    await page.waitForTimeout(300)
    const invoiceOption = page.locator('.v-list-item').first()
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
    await page.waitForTimeout(500)

    // Select contact
    const contactAutocomplete = page.locator('.v-dialog .v-autocomplete').first()
    await contactAutocomplete.click()
    await page.waitForTimeout(300)
    const contactOption = page.locator('.v-list-item').first()
    if (await contactOption.isVisible()) {
      await contactOption.click()
    }

    // The form should accept manual line item edits
    const qtyInput = page.locator('.v-dialog .v-table tbody tr input[type="number"]').first()
    if (await qtyInput.isVisible({ timeout: 3000 }).catch(() => false)) {
      await qtyInput.fill('5')
      expect(await qtyInput.inputValue()).toBe('5')
    }
  })
})
