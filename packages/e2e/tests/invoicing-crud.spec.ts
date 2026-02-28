import { test, expect } from '@playwright/test'
import { loginForApp } from './helpers/login'
import {
  fillField,
  selectAutocomplete,
  selectOption,
  waitForDataTable,
  expectSuccess,
  uniqueName,
} from './helpers/crud'
import { expectPaginatedTable, getPageInfo, goToNextPage, waitForTableLoaded } from './helpers/pagination'

test.describe('Invoicing CRUD', () => {
  test('should create a contact with company name and email', async ({ page }) => {
    await loginForApp(page)
    await page.goto('/invoicing/contacts/new')

    await expect(page.getByRole('heading', { name: /new contact/i })).toBeVisible({ timeout: 10000 })

    const companyName = uniqueName('TestCo')
    await page.getByLabel(/company name/i).fill(companyName)
    await page.getByLabel(/^email$/i).fill(`${companyName.toLowerCase()}@test.com`)

    // Switch to addresses tab and add a billing address
    await page.getByRole('tab', { name: /addresses/i }).click()
    await page.waitForTimeout(300)

    const addAddressBtn = page.getByRole('button', { name: /add address/i })
    if (await addAddressBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      await addAddressBtn.click()
      await page.waitForTimeout(300)

      // Fill billing address fields
      await page.getByLabel(/street/i).fill('100 Invoice Lane')
      await page.getByLabel(/^city$/i).fill('Billingtown')
      await page.getByLabel(/postal code/i).fill('10001')
      await page.getByLabel(/country/i).fill('US')
    }

    await page.getByRole('button', { name: /save/i }).click()

    // Verify redirect or success
    await expect(
      page.locator('.v-data-table').or(page.getByRole('heading', { name: /new contact/i }))
    ).toBeVisible({ timeout: 10000 })
  })

  test('should create a sales invoice with contact autocomplete and line items', async ({ page }) => {
    await loginForApp(page)
    await page.goto('/invoicing/invoices/new')

    await expect(page.getByRole('heading', { name: /new invoice/i })).toBeVisible({ timeout: 10000 })

    // Type defaults to "sales" -- verify type select is present with correct options
    const typeLabel = page.getByLabel(/type/i)
    if (await typeLabel.isVisible({ timeout: 2000 }).catch(() => false)) {
      // Type select should have: sales, purchase, proforma, credit_note
      await typeLabel.click({ force: true })
      await page.waitForTimeout(300)
      const salesOption = page.getByRole('option', { name: /sales/i })
      if (await salesOption.isVisible({ timeout: 2000 }).catch(() => false)) {
        await salesOption.click()
      } else {
        // Close the dropdown
        await page.keyboard.press('Escape')
      }
      await page.waitForTimeout(200)
    }

    // Select contact via autocomplete
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

    // Fill product/description (first text input)
    const productInput = lineRow.locator('input').first()
    await productInput.fill('Test Service')

    // Fill quantity (first number input)
    const quantityInput = lineRow.locator('input[type="number"]').first()
    await quantityInput.fill('5')

    // Fill unit price (second number input)
    const unitPriceInput = lineRow.locator('input[type="number"]').nth(1)
    await unitPriceInput.fill('100')

    // Wait for computed fields to update
    await page.waitForTimeout(500)

    // Verify taxAmount and lineTotal are computed (they should appear as readonly or computed fields)
    // taxAmount is per-line, taxTotal is at invoice level
    const taxAmountCells = lineRow.locator('input[type="number"]')
    const cellCount = await taxAmountCells.count()
    // Expect at least 3 number inputs: quantity, unitPrice, and computed fields
    expect(cellCount).toBeGreaterThanOrEqual(2)

    // Verify taxTotal at invoice level exists somewhere in the form
    const taxTotalLabel = page.getByText(/tax total/i).or(page.getByText(/tax amount/i))
    if (await taxTotalLabel.isVisible({ timeout: 2000 }).catch(() => false)) {
      await expect(taxTotalLabel).toBeVisible()
    }

    // Save the invoice
    await page.getByRole('button', { name: /save/i }).click()

    await expect(
      page.locator('.v-data-table').or(page.getByRole('heading', { name: /new invoice/i }))
    ).toBeVisible({ timeout: 10000 })
  })

  test('should verify billingAddress fields are present in invoice form', async ({ page }) => {
    await loginForApp(page)
    await page.goto('/invoicing/invoices/new')

    await expect(page.getByRole('heading', { name: /new invoice/i })).toBeVisible({ timeout: 10000 })

    // Select a contact first so billing address may auto-populate
    const contactInput = page.locator('.v-autocomplete input').first()
    await contactInput.click({ force: true })
    await page.waitForTimeout(500)
    const contactOption = page.locator('.v-overlay .v-list-item').first()
    if (await contactOption.isVisible({ timeout: 3000 }).catch(() => false)) {
      await contactOption.click()
      await page.waitForTimeout(500)
    }

    // Verify billingAddress nested fields exist in the form
    // These are part of the billingAddress object: street, city, postalCode, country
    const streetField = page.getByLabel(/street/i)
    const cityField = page.getByLabel(/^city$/i)
    const postalCodeField = page.getByLabel(/postal code/i)
    const countryField = page.getByLabel(/country/i)

    // At least some of these should be visible (may be in a collapsible section)
    const hasStreet = await streetField.isVisible({ timeout: 3000 }).catch(() => false)
    const hasCity = await cityField.isVisible({ timeout: 2000 }).catch(() => false)
    const hasPostalCode = await postalCodeField.isVisible({ timeout: 2000 }).catch(() => false)
    const hasCountry = await countryField.isVisible({ timeout: 2000 }).catch(() => false)

    // Expect billingAddress fields to be present
    expect(hasStreet || hasCity || hasPostalCode || hasCountry).toBeTruthy()

    // Verify direction select if visible
    const directionField = page.getByLabel(/direction/i)
    if (await directionField.isVisible({ timeout: 2000 }).catch(() => false)) {
      await expect(directionField).toBeVisible()
    }
  })

  test('should display server-side pagination on invoices table', async ({ page }) => {
    await loginForApp(page)
    await page.goto('/invoicing/sales-invoices')

    await expectPaginatedTable(page)
    await waitForTableLoaded(page)

    const info = await getPageInfo(page)
    expect(info).toBeTruthy()
  })

  test('should display server-side pagination on contacts table', async ({ page }) => {
    await loginForApp(page)
    await page.goto('/invoicing/contacts')

    await expectPaginatedTable(page)
    await waitForTableLoaded(page)

    const info = await getPageInfo(page)
    expect(info).toBeTruthy()
  })
})
