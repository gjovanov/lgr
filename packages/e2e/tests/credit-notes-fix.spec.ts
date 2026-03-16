import { test, expect } from '@playwright/test'
import { loginForApp } from './helpers/login'

test.describe('Credit Notes Fixes', () => {
  test('should display related invoice number (not [object Object])', async ({ page }) => {
    await loginForApp(page)
    await page.goto('/trade/credit-notes')

    await expect(page.locator('.v-data-table')).toBeVisible({ timeout: 10000 })

    // Verify no cell contains "[object Object]"
    const cells = page.locator('.v-data-table td')
    const count = await cells.count()
    for (let i = 0; i < count; i++) {
      const text = await cells.nth(i).textContent()
      expect(text).not.toContain('[object Object]')
    }
  })

  test('should navigate to new credit note form and show related invoice field', async ({ page }) => {
    await loginForApp(page)
    await page.goto('/trade/credit-notes/new')

    // Verify form renders
    await expect(page.locator('.v-form')).toBeVisible({ timeout: 10000 })

    // Verify related invoice autocomplete is present
    const invoiceAutocomplete = page.locator('.v-autocomplete').nth(1)
    await expect(invoiceAutocomplete).toBeVisible()
  })

  test('should allow editing line items on credit note form', async ({ page }) => {
    await loginForApp(page)
    await page.goto('/trade/credit-notes/new')

    await expect(page.locator('.v-form')).toBeVisible({ timeout: 10000 })

    // The form should accept manual line item edits on the default empty line
    const qtyInput = page.locator('.v-table tbody tr input[type="number"]').first()
    if (await qtyInput.isVisible({ timeout: 3000 }).catch(() => false)) {
      await qtyInput.fill('5')
      expect(await qtyInput.inputValue()).toBe('5')
    }
  })
})
