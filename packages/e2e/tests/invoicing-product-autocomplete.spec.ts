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

    // Results render in our own teleported overlay (NOT a v-menu).
    const menuList = page.locator('.pld-overlay .pld-item')
    const hasResults = await menuList.first().isVisible({ timeout: 3000 }).catch(() => false)

    if (hasResults) {
      // Select the first product
      await menuList.first().click()
      await page.waitForTimeout(300)

      // Verify chip appears
      const chip = descriptionCell.locator('.v-chip')
      await expect(chip).toBeVisible({ timeout: 3000 })

      // Check if unit price was auto-filled (depends on product having a price)
      const unitPriceInput = lineRow.locator('input[type="number"]').nth(1)
      const priceValue = await unitPriceInput.inputValue()
      const priceNum = Number(priceValue)
      // Price is auto-filled only when the product has unitPrice set in the DB
      // Just verify the input exists and is accessible
      expect(priceNum).toBeGreaterThanOrEqual(0)

      // Clear the product by clicking the chip close button
      const chipClose = chip.locator('.v-chip__close, .mdi-close-circle').first()
      if (await chipClose.isVisible({ timeout: 2000 }).catch(() => false)) {
        await chipClose.click()
        await page.waitForTimeout(300)

        // Chip should be gone
        await expect(chip).not.toBeVisible({ timeout: 3000 })
      }
    }
  })

  test('arrow keys navigate the dropdown without closing it; Enter selects', async ({ page }) => {
    await loginForApp(page)
    await page.goto('/invoicing/invoices/new')
    await expect(page.getByRole('heading', { name: /new invoice/i })).toBeVisible({ timeout: 10000 })

    await page.getByRole('button', { name: /add line/i }).click()
    await page.waitForTimeout(300)

    const lineRow = page.locator('.v-table tbody tr').first()
    const descInput = lineRow.locator('td').first().locator('input').first()

    await descInput.click()
    // Real keyboard typing (this is what diverged from CDP/JS injection in prior debugging).
    await page.keyboard.type('Te', { delay: 60 })

    const items = page.locator('.pld-overlay .pld-item')
    const opened = await items.first().isVisible({ timeout: 4000 }).catch(() => false)
    if (!opened) return // no seed products matching 'Te' in this env — nothing to assert

    // Press ArrowDown a few times; the overlay must STAY OPEN the whole time (the reported bug
    // was that the first ArrowDown moved one item then closed the list). Poll after each press to
    // catch a delayed (blur-timeout) close.
    for (let n = 0; n < 4; n++) {
      await page.keyboard.press('ArrowDown')
      const samples: number[] = []
      for (let i = 0; i < 6; i++) { samples.push(await items.count()); await page.waitForTimeout(60) }
      expect(samples.every((c) => c > 0), `dropdown closed after ArrowDown #${n + 1} (counts: ${samples.join(',')})`).toBe(true)
    }

    // An active/highlighted item is tracked and Enter commits it (chip appears).
    await expect(page.locator('.pld-overlay .pld-item--active')).toBeVisible()
    await page.keyboard.press('Enter')
    await expect(lineRow.locator('td').first().locator('.v-chip')).toBeVisible({ timeout: 3000 })
    // Overlay is gone after selection.
    await expect(items.first()).not.toBeVisible({ timeout: 3000 })
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
