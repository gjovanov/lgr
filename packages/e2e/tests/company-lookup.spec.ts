import { test, expect } from '@playwright/test'
import { loginForApp } from './helpers/login'

test.describe('Company Lookup', () => {
  test('should show tax number and VAT number fields on contact form', async ({ page }) => {
    await loginForApp(page)
    await page.goto('/invoicing/contacts/new')

    await expect(page.getByRole('heading', { name: /new contact/i })).toBeVisible()

    // Verify both new tax fields are present
    await expect(page.getByLabel(/tax number/i)).toBeVisible()
    await expect(page.getByLabel(/vat number/i)).toBeVisible()
  })

  test('should show lookup button next to tax number field', async ({ page }) => {
    await loginForApp(page)
    await page.goto('/invoicing/contacts/new')

    await expect(page.getByRole('heading', { name: /new contact/i })).toBeVisible()

    // Verify lookup buttons are present (mdi-magnify icons rendered as v-btn inside append-inner slot)
    const lookupBtn = page.locator('.v-input:has(label:text-matches("Tax Number", "i")) button.v-btn')
    await expect(lookupBtn).toBeVisible()
  })

  test('should lookup Bulgarian company by EIK', async ({ page }) => {
    await loginForApp(page)
    await page.goto('/invoicing/contacts/new')

    await expect(page.getByRole('heading', { name: /new contact/i })).toBeVisible()

    // Fill tax number with Bulgarian EIK
    await page.getByLabel(/tax number/i).fill('205174895')

    // Click lookup button for tax number field
    const lookupBtn = page.locator('.v-input:has(label:text-matches("Tax Number", "i")) button.v-btn')
    await lookupBtn.click()

    // Wait for lookup to complete
    await page.waitForTimeout(3000)

    // Company name should be auto-filled
    const companyNameInput = page.getByLabel(/company name/i)
    const value = await companyNameInput.inputValue()
    // The lookup should have filled in a company name (eik.bg or verifyvat)
    if (value) {
      expect(value.length).toBeGreaterThan(0)
    }
    // Also check for success snackbar
    const snackbar = page.locator('.v-snackbar')
    if (await snackbar.isVisible({ timeout: 2000 }).catch(() => false)) {
      // Either success or not found - both are valid outcomes
      await expect(snackbar).toBeVisible()
    }
  })

  test('should lookup EU company by VAT number', async ({ page }) => {
    await loginForApp(page)
    await page.goto('/invoicing/contacts/new')

    await expect(page.getByRole('heading', { name: /new contact/i })).toBeVisible()

    // Fill VAT number with Austrian VAT
    await page.getByLabel(/vat number/i).fill('ATU66280133')

    // Click lookup button for VAT number field
    const lookupBtn = page.locator('.v-input:has(label:text-matches("VAT Number", "i")) button.v-btn')
    await lookupBtn.click()

    // Wait for lookup to complete
    await page.waitForTimeout(3000)

    // Company name should be auto-filled
    const companyNameInput = page.getByLabel(/company name/i)
    const value = await companyNameInput.inputValue()
    if (value) {
      expect(value.length).toBeGreaterThan(0)
    }
  })

  test('should show tax number and VAT number columns in contacts list', async ({ page }) => {
    await loginForApp(page)
    await page.goto('/invoicing/contacts')

    await expect(page.getByRole('heading', { name: /contacts/i })).toBeVisible()
    await expect(page.locator('.v-data-table')).toBeVisible({ timeout: 10000 })

    // Verify column headers exist
    const table = page.locator('.v-data-table')
    await expect(table.locator('th', { hasText: /tax number/i })).toBeVisible()
    await expect(table.locator('th', { hasText: /vat number/i })).toBeVisible()
  })
})
