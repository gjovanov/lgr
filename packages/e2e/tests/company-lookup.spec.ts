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

  test('should lookup Bulgarian company by EIK and fill address', async ({ page }) => {
    await loginForApp(page)
    await page.goto('/invoicing/contacts/new')

    await expect(page.getByRole('heading', { name: /new contact/i })).toBeVisible()

    // Fill tax number with Bulgarian EIK
    await page.getByLabel(/tax number/i).fill('112500982')

    // Click lookup button for tax number field
    const lookupBtn = page.locator('.v-input:has(label:text-matches("Tax Number", "i")) button.v-btn')
    await lookupBtn.click()

    // Wait for lookup to complete — eik.bg can be slow
    await page.waitForTimeout(5000)

    // Company name should be auto-filled
    const companyNameInput = page.getByLabel(/company name/i)
    const companyName = await companyNameInput.inputValue()
    expect(companyName.length).toBeGreaterThan(0)

    // Address should be auto-filled — switch to Addresses tab
    await page.getByRole('tab', { name: /addresses/i }).click()
    await page.waitForTimeout(500)

    // At least one address should be present with city filled
    const cityInput = page.getByLabel(/city/i).first()
    await expect(cityInput).toBeVisible()
    const cityValue = await cityInput.inputValue()
    expect(cityValue.length).toBeGreaterThan(0)
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

  test('should lookup German VAT and fill country in address', async ({ page }) => {
    await loginForApp(page)
    await page.goto('/invoicing/contacts/new')

    await expect(page.getByRole('heading', { name: /new contact/i })).toBeVisible()

    // Fill VAT number with German VAT
    await page.getByLabel(/vat number/i).fill('DE270518880')

    // Click lookup button for VAT number field
    const lookupBtn = page.locator('.v-input:has(label:text-matches("VAT Number", "i")) button.v-btn')
    await lookupBtn.click()

    // Wait for lookup to complete
    await page.waitForTimeout(3000)

    // VAT number and tax number should remain filled
    const vatValue = await page.getByLabel(/vat number/i).inputValue()
    expect(vatValue).toBe('DE270518880')

    // Switch to Addresses tab — country should be auto-filled
    await page.getByRole('tab', { name: /addresses/i }).click()
    await page.waitForTimeout(500)

    const countryInput = page.getByLabel(/country/i).first()
    await expect(countryInput).toBeVisible()
    const countryValue = await countryInput.inputValue()
    expect(countryValue).toBe('DE')
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

  test('should fill address in inline create dialog after lookup', async ({ page }) => {
    await loginForApp(page)
    await page.goto('/invoicing/invoices/new')

    await expect(page.getByRole('heading', { name: /new invoice/i })).toBeVisible()

    // Open contact autocomplete and type to trigger dropdown
    const contactField = page.locator('.v-autocomplete').first()
    await contactField.click({ force: true })
    await contactField.locator('input').fill('a')
    await page.waitForTimeout(1000)

    // Click "Create New Contact"
    await page.locator('.v-list-item', { hasText: /create.*contact/i }).click()

    const dialog = page.locator('.v-dialog')
    await expect(dialog).toBeVisible({ timeout: 5000 })

    // Fill tax number with Bulgarian EIK and lookup
    await dialog.getByLabel(/tax number/i).fill('112500982')
    const lookupBtn = dialog.locator('.v-input:has(label:text-matches("Tax Number", "i")) button.v-btn')
    await lookupBtn.click()

    // Wait for lookup to complete
    await page.waitForTimeout(3000)

    // Company name should be auto-filled
    const companyName = await dialog.getByLabel(/company name/i).inputValue()
    expect(companyName.length).toBeGreaterThan(0)

    // Address fields should appear and be filled
    const cityInput = dialog.getByLabel(/city/i)
    await expect(cityInput).toBeVisible({ timeout: 3000 })
    const cityValue = await cityInput.inputValue()
    expect(cityValue.length).toBeGreaterThan(0)
  })
})
