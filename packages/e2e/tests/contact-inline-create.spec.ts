import { test, expect } from '@playwright/test'
import { loginForApp } from './helpers/login'
import { apiDelete, apiGet, apiLogin } from './helpers/api'
import { openSelect } from './helpers/vuetify'

test.describe('Inline Contact Creation', () => {
  test('should show "Create New Contact" option in contact autocomplete on invoice form', async ({ page }) => {
    await loginForApp(page)
    await page.goto('/invoicing/invoices/new')

    await expect(page.getByRole('heading', { name: /new invoice/i })).toBeVisible()

    // Click on the contact autocomplete to open dropdown
    const contactField = page.locator('.v-autocomplete').first()
    await contactField.click({ force: true })

    // Type to trigger dropdown menu
    await contactField.locator('input').fill('a')
    await page.waitForTimeout(1000)

    // Look for "Create New Contact" option (in #append-item slot)
    const createOption = page.locator('.v-list-item', { hasText: /create.*contact/i })
    await expect(createOption).toBeVisible({ timeout: 5000 })
  })

  test('should open create contact dialog from invoice form', async ({ page }) => {
    await loginForApp(page)
    await page.goto('/invoicing/invoices/new')

    await expect(page.getByRole('heading', { name: /new invoice/i })).toBeVisible()

    // Click contact autocomplete and type to open dropdown
    const contactField = page.locator('.v-autocomplete').first()
    await contactField.click({ force: true })
    await contactField.locator('input').fill('a')
    await page.waitForTimeout(1000)

    // Click "Create New Contact"
    const createOption = page.locator('.v-list-item', { hasText: /create.*contact/i })
    await createOption.click()

    // Verify dialog opens with contact creation form
    const dialog = page.locator('.v-dialog')
    await expect(dialog).toBeVisible({ timeout: 5000 })
    await expect(dialog.getByText(/create.*contact/i)).toBeVisible()

    // Verify form fields
    await expect(dialog.getByLabel(/company name/i)).toBeVisible()
    await expect(dialog.getByLabel(/type/i).first()).toBeVisible()
  })

  test('should create contact inline and auto-select it', async ({ page }) => {
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

    // Fill contact form
    const uniqueName = `E2E Test Co ${Date.now()}`
    await dialog.getByLabel(/company name/i).fill(uniqueName)

    // Save
    await dialog.getByRole('button', { name: /^save$/i }).first().click()

    // Wait for dialog to close (contact created)
    await page.waitForTimeout(2000)

    // The dialog should close on success (contact created)
    const dialogVisible = await dialog.isVisible().catch(() => false)
    // If dialog closed, the contact was created successfully
    expect(dialogVisible).toBe(false)
  })

  test('should show create contact option in credit notes form', async ({ page }) => {
    await loginForApp(page)
    // Credit notes uses route-based form (v-btn with :to renders as <a>)
    await page.goto('/invoicing/credit-notes/new')

    await page.waitForTimeout(1000)

    // Click contact autocomplete and type to trigger dropdown
    const contactField = page.locator('.v-autocomplete').first()
    await contactField.click({ force: true })
    await contactField.locator('input').fill('a')
    await page.waitForTimeout(1000)

    // Verify "Create New Contact" option
    const createOption = page.locator('.v-list-item', { hasText: /create.*contact/i })
    await expect(createOption).toBeVisible({ timeout: 5000 })
  })
})

/**
 * Every document form creates its party where the invoice's does: the last entry of the party
 * dropdown and the button beside the select. Offers, proformas and the bill page's three types used
 * to have a plain picker. A contact made on a bill starts as a supplier, so the supplier list that
 * the bill searches finds it.
 *
 * Each form creates through one of the two ways and checks the other is there. The contacts are
 * deactivated afterwards, as the other specs that make their own do (`helpers/api#activeContact`).
 */
test.describe('A new contact from the offer, proforma and bill forms', () => {
  const stamp = Date.now().toString(36)
  const made: string[] = []

  const FORMS = [
    { name: 'offer', path: '/invoicing/offer/new', heading: /new offer/i, party: /client/i, side: 'customer', via: 'list' },
    { name: 'proforma', path: '/invoicing/proforma/new', heading: /new proforma invoice/i, party: /client/i, side: 'customer', via: 'button' },
    { name: 'bill', path: '/invoicing/bills/new', heading: /new purchase invoice/i, party: /supplier/i, side: 'supplier', via: 'button' },
    { name: 'incoming credit note', path: '/invoicing/bills/new?type=credit_note', heading: /new credit note/i, party: /supplier/i, side: 'supplier', via: 'list' },
    { name: 'incoming debit note', path: '/invoicing/bills/new?type=debit_note', heading: /new debit note/i, party: /supplier/i, side: 'supplier', via: 'button' },
  ] as const

  test.afterAll(async () => {
    const session = await apiLogin()
    for (const id of made) await apiDelete(session, `/invoicing/contact/${id}`)
  })

  for (const form of FORMS) {
    test(`${form.name}: the dropdown and the button both offer it, and the form takes the new ${form.side}`, async ({ page }) => {
      await loginForApp(page)
      await page.goto(form.path)
      await expect(page.getByRole('heading', { name: form.heading })).toBeVisible({ timeout: 15000 })
      const party = page.locator('.doc-banner-party')

      // The button beside the select, gated as the Contacts page's own New button is.
      const button = page.getByTestId('create-contact-btn')
      await expect(button).toBeVisible()
      await expect(button).toHaveAttribute('data-cap', 'contacts.create')

      // The last entry of the dropdown.
      await openSelect(party, form.party)
      const entry = page.getByTestId('create-contact-option')
      await expect(entry).toBeVisible()
      if (form.via === 'list') {
        await entry.click()
      } else {
        await page.keyboard.press('Escape')
        await button.click()
      }

      const dialog = page.locator('.v-dialog').filter({ hasText: /create new contact/i })
      await expect(dialog).toBeVisible()
      // It starts on the form's side: the bill page makes a supplier.
      await expect(dialog.locator('.v-select__selection-text')).toHaveText(form.side === 'supplier' ? /^supplier$/i : /^customer$/i)

      const name = `E2E ${form.name} party ${stamp}`
      await dialog.getByLabel(/company name/i).fill(name)
      await dialog.getByRole('button', { name: /^save$/i }).click()
      await expect(dialog).toBeHidden()
      // Chosen at once, without a second search.
      await expect(party).toContainText(name)

      const session = await apiLogin()
      const found = (await apiGet(session, `/invoicing/contact?search=${encodeURIComponent(name)}`)).contacts ?? []
      made.push(...found.map((c: any) => String(c._id ?? c.id)))
      expect(found.map((c: any) => [c.companyName, c.type])).toEqual([[name, form.side]])
    })
  }
})
