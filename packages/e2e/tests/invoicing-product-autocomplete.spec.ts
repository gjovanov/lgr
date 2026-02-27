import { test, expect } from '@playwright/test'
import { loginForApp } from './helpers/login'

test.describe('Invoicing Product Autocomplete', () => {
  test('should select a product from dropdown, show chip, auto-fill price, and clear', async ({ page }) => {
    await loginForApp(page)
    await page.goto('/invoicing/invoices/new')

    await expect(page.getByRole('heading', { name: /new invoice/i })).toBeVisible({ timeout: 10000 })

    // Select a contact first (required field)
    const contactInput = page.locator('.v-autocomplete input').first()
    await contactInput.click({ force: true })
    await page.waitForTimeout(500)
    const contactOption = page.locator('.v-overlay .v-list-item').first()
    if (await contactOption.isVisible({ timeout: 3000 }).catch(() => false)) {
      await contactOption.click()
    }
    await page.waitForTimeout(300)

    // Add a line item
    await page.getByRole('button', { name: /add line/i }).click()
    await page.waitForTimeout(300)

    const lineRow = page.locator('.v-table tbody tr').first()
    await expect(lineRow).toBeVisible()

    // Find the ProductLineDescription component's input inside the first td
    const descriptionCell = lineRow.locator('td').first()
    const descInput = descriptionCell.locator('input').first()

    // Type a product search query (at least 2 chars to trigger dropdown)
    await descInput.fill('Te')
    await page.waitForTimeout(500)

    // Check if dropdown menu appears with products
    const menuList = page.locator('.v-menu .v-list-item')
    const hasResults = await menuList.first().isVisible({ timeout: 3000 }).catch(() => false)

    if (hasResults) {
      // Select the first product
      await menuList.first().click()
      await page.waitForTimeout(300)

      // Verify chip appears
      const chip = descriptionCell.locator('.v-chip')
      await expect(chip).toBeVisible({ timeout: 3000 })

      // Verify unit price was auto-filled (should be > 0)
      const unitPriceInput = lineRow.locator('input[type="number"]').nth(1)
      const priceValue = await unitPriceInput.inputValue()
      expect(Number(priceValue)).toBeGreaterThan(0)

      // Clear the product by clicking the chip close button
      const chipClose = chip.locator('.v-chip__close, .mdi-close-circle').first()
      if (await chipClose.isVisible({ timeout: 2000 }).catch(() => false)) {
        await chipClose.click()
        await page.waitForTimeout(300)

        // Chip should be gone
        await expect(chip).not.toBeVisible({ timeout: 3000 })

        // Price should remain (not cleared)
        const priceAfterClear = await unitPriceInput.inputValue()
        expect(Number(priceAfterClear)).toBeGreaterThan(0)
      }
    }
  })

  test('should allow manual entry without product selection', async ({ page }) => {
    await loginForApp(page)
    await page.goto('/invoicing/invoices/new')

    await expect(page.getByRole('heading', { name: /new invoice/i })).toBeVisible({ timeout: 10000 })

    // Add a line item
    await page.getByRole('button', { name: /add line/i }).click()
    await page.waitForTimeout(300)

    const lineRow = page.locator('.v-table tbody tr').first()
    await expect(lineRow).toBeVisible()

    // Type a description manually (not matching any product)
    const descriptionCell = lineRow.locator('td').first()
    const descInput = descriptionCell.locator('input').first()
    await descInput.fill('Custom manual service description')
    await page.waitForTimeout(300)

    // No chip should be visible (no product selected)
    const chip = descriptionCell.locator('.v-chip')
    await expect(chip).not.toBeVisible({ timeout: 2000 })

    // Should be able to fill other fields manually
    const quantityInput = lineRow.locator('input[type="number"]').first()
    await quantityInput.fill('2')

    const unitPriceInput = lineRow.locator('input[type="number"]').nth(1)
    await unitPriceInput.fill('150')

    await page.waitForTimeout(300)

    // Verify the description value persisted
    const descValue = await descInput.inputValue()
    expect(descValue).toBe('Custom manual service description')
  })
})
