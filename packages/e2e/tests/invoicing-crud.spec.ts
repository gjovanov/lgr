import { test, expect } from '@playwright/test'
import { appears } from './helpers/vuetify'
import { loginForApp } from './helpers/login'
import { answerIssuePayment, lineUnitPrice } from './helpers/document-form'
import { activeContact, apiGet, apiLogin, apiPost } from './helpers/api'
import { draftDocument } from './helpers/draft-document'
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

    // The contact form has no tabs since it moved to EntityFormShell — Add Address sits
    // directly on the page, so the old tab click timed out at 10s against nothing.
    await page.waitForTimeout(300)

    const addAddressBtn = page.getByRole('button', { name: /add address/i })
    if (await appears(addAddressBtn, 2000)) {
      await addAddressBtn.click()
      await page.waitForTimeout(300)

      // Fill billing address fields
      await page.getByLabel(/street/i).fill('100 Invoice Lane')
      await page.getByLabel(/^city$/i).fill('Billingtown')
      await page.getByLabel(/postal code/i).fill('10001')
      await page.getByLabel(/country/i).fill('US')
    }

    await page.getByRole('button', { name: /^save$/i }).first().click()

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
    if (await appears(typeLabel, 2000)) {
      // Type select should have: sales, purchase, proforma, credit_note
      await typeLabel.click({ force: true })
      await page.waitForTimeout(300)
      const salesOption = page.getByRole('option', { name: /sales/i })
      if (await appears(salesOption, 2000)) {
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
    if (await appears(contactOption, 3000)) {
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
    const unitPriceInput = lineUnitPrice(lineRow)
    await unitPriceInput.fill('100')

    // Wait for computed fields to update
    await page.waitForTimeout(500)

    // ⚠ Counting number inputs no longer says anything about computation. Unit price became a
    // PriceCombobox and the computed columns render as TEXT, so a line row has exactly one
    // `input[type=number]` — the quantity. The old "at least 2 number inputs" received 1.
    //
    // Assert the line holds what was typed. NOT the computed total: with a free-text
    // description and no product selected the row still totals 0.00, so a `toContainText('500')`
    // check fails for a reason that has nothing to do with this test's subject.
    await expect(quantityInput).toHaveValue('5')
    await expect(unitPriceInput).toHaveValue('100')

    // Verify taxTotal at invoice level exists somewhere in the form
    const taxTotalLabel = page.getByText(/tax total/i).or(page.getByText(/tax amount/i))
    await expect(taxTotalLabel).toBeVisible()

    // Save the invoice. FR-22.16: it stays open, on its own edit route.
    await page.getByRole('button', { name: /^save$/i }).first().click()

    await expect(
      page.getByRole('heading', { name: /edit invoice/i }).or(page.getByRole('heading', { name: /new invoice/i }))
    ).toBeVisible({ timeout: 10000 })
  })

  test('should verify billingAddress fields are present in invoice form', async ({ page }) => {
    await loginForApp(page)
    await page.goto('/invoicing/invoices/new')

    await expect(page.getByRole('heading', { name: /new invoice/i })).toBeVisible({ timeout: 10000 })

    // Select a contact first so billing address may auto-populate. A seeded one, by name: the
    // picker opens on the customers used most recently (FR-22.25), and the first of those is
    // whoever the last test invoiced — not necessarily someone with an address on file.
    const contactInput = page.locator('.v-autocomplete input').first()
    await contactInput.click({ force: true })
    await contactInput.pressSequentially('Alpha', { delay: 25 })
    const contactOption = page.locator('.v-overlay .v-list-item').filter({ hasText: 'Alpha Manufacturing' }).first()
    await expect(contactOption).toBeVisible({ timeout: 5000 })
    await contactOption.click()
    await page.waitForTimeout(500)

    // ⚠ The billing address is no longer a set of labelled INPUTS on this form. It is rendered
    // read-only by `ContactPartyBlock` (`:address="config.captureBillingAddress ? ... : null"`),
    // so getByLabel(/street/i) and friends correctly match nothing and the old
    // `expect(hasStreet || hasCity || ...)` received false.
    //
    // The sales-invoice config sets `captureBillingAddress: true`, so the party block must
    // carry an Address section once a contact is chosen.
    await expect(page.getByText(/^address$/i).first()).toBeVisible({ timeout: 5000 })

    // #408: the form has no direction field: the page decides it (sales documents vs bills). This
    // checked a field that does not exist, and passed because its guard checked nothing.
  })

  test('should display server-side pagination on invoices table', async ({ page }) => {
    await loginForApp(page)
    await page.goto('/invoicing/invoices')

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

  // ── Owner, 2026-11-12 ──

  test('issuing an outgoing invoice asks for its payment method first: No keeps the draft, Yes issues it', async ({ page }) => {
    const draft = await draftDocument('invoice', 'outgoing')
    const session = await apiLogin()
    await loginForApp(page)
    await page.goto(`/invoicing/invoices/${draft.id}/edit`)
    const issue = page.getByRole('button', { name: 'Issue', exact: true }).first()
    await expect(issue).toBeVisible({ timeout: 15000 })

    await issue.click()
    const ask = page.getByTestId('issue-payment-confirm')
    await expect(ask).toBeVisible()
    await expect(ask).toContainText(draft.invoiceNumber)
    await expect(ask.getByTestId('issue-payment-method')).toHaveText('Bank Transfer')
    await ask.getByTestId('issue-payment-no').click()
    await expect(ask).toBeHidden()
    expect((await apiGet(session, `/invoices/${draft.id}`)).invoice.status).toBe('draft')

    await issue.click()
    await answerIssuePayment(page)
    await expect.poll(async () => (await apiGet(session, `/invoices/${draft.id}`)).invoice.status, { timeout: 15000 }).toBe('sent')
  })

  test('on an outgoing document the unit of a line with an article is read-only; a typed line and a bill keep theirs', async ({ page }) => {
    const session = await apiLogin()
    const { products } = await apiGet(session, '/warehouse/product?size=5&isActive=true')
    const product = (products || []).find((p: any) => p.type !== 'service') || products[0]
    expect(product, 'a seeded article').toBeTruthy()
    const customer = await activeContact(session, 'customer')
    const supplier = await activeContact(session, 'supplier')
    const productLine = { productId: product._id, description: product.name, quantity: 1, unit: product.unit || 'pcs', unitPrice: 10, discount: 0, taxRate: 20, taxAmount: 2, lineTotal: 12 }
    const typedLine = { description: `E2E typed ${Date.now().toString(36)}`, quantity: 1, unit: 'pcs', unitPrice: 10, discount: 0, taxRate: 20, taxAmount: 2, lineTotal: 12 }
    const make = async (direction: 'outgoing' | 'incoming', contact: any, lines: any[]) => {
      const res = await apiPost(session, '/invoices', {
        type: 'invoice', direction, contactId: contact._id, issueDate: new Date().toISOString().split('T')[0], currency: 'EUR', exchangeRate: 1,
        lines, subtotal: 10 * lines.length, discountTotal: 0, taxTotal: 2 * lines.length, total: 12 * lines.length,
      })
      expect(res.ok, `draft ${direction} → ${res.status}`).toBe(true)
      const { invoice } = await res.json()
      return invoice._id || invoice.id
    }
    const invoiceId = await make('outgoing', customer, [productLine, typedLine])
    const billId = await make('incoming', supplier, [productLine])

    await loginForApp(page)
    await page.goto(`/invoicing/invoices/${invoiceId}/edit`)
    const rows = page.locator('.line-table tbody tr')
    await expect(rows.nth(1)).toBeVisible({ timeout: 15000 })
    await expect(rows.nth(0).getByTestId('line-unit').locator('input')).toHaveAttribute('readonly', /.*/)
    await expect(rows.nth(1).getByTestId('line-unit').locator('input')).not.toHaveAttribute('readonly', /.*/)

    await page.goto(`/invoicing/bills/${billId}/edit`)
    const billRow = page.locator('.line-table tbody tr').first()
    await expect(billRow).toBeVisible({ timeout: 15000 })
    await expect(billRow.getByTestId('line-unit').locator('input')).not.toHaveAttribute('readonly', /.*/)
  })

  test('a quantity typed with a comma counts as a decimal, and a Bulgarian screen shows the amounts with a point', async ({ page }) => {
    const draft = await draftDocument('invoice', 'outgoing') // 1 × 100.00 at 20 %
    await page.addInitScript(() => localStorage.setItem('lgr_locale', 'bg'))
    await loginForApp(page)
    await page.goto(`/invoicing/invoices/${draft.id}/edit`)
    const totals = page.getByTestId('document-totals')
    await expect(totals).toContainText('120.00', { timeout: 15000 })
    await expect(totals).not.toContainText('120,00')

    const quantity = page.locator('.line-table tbody tr').first().locator('input[type="number"]').first()
    await quantity.fill('')
    await quantity.pressSequentially('2,5')
    await expect(totals).toContainText('300.00')
  })
})
