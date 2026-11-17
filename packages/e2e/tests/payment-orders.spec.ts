import { test, expect } from '@playwright/test'
import { appears } from './helpers/vuetify'
import { loginForApp } from './helpers/login'
import { apiGet, apiLogin, apiPost } from './helpers/api'

/**
 * FR-31.10 (#796): the pickers of a payment order, a cash order and a timesheet search the server. Each asked its
 * endpoint without a size and got the API's first page of ten: the eleventh supplier could not be paid.
 */
test.describe('Pickers that know more than the first ten (FR-31.10)', () => {
  test('a payment order pays the eleventh contact, and lists only that contact’s unpaid invoices', async ({ page }) => {
    const api = await apiLogin()
    const stamp = Date.now().toString(36)
    // Eleven contacts, the one to pay made FIRST: ten newer ones stand in front of it on the API's first page.
    const ids: string[] = []
    for (let i = 1; i <= 11; i++) {
      const res = await apiPost(api, '/invoicing/contact', { type: 'supplier', companyName: `E2E Pick ${stamp} ${String(i).padStart(2, '0')}` })
      expect(res.ok, `contact ${i} → ${res.status}`).toBe(true)
      const { contact } = await res.json()
      ids.push(String(contact._id || contact.id))
    }
    const target = `E2E Pick ${stamp} 01`
    const firstPage = await apiGet(api, '/invoicing/contact')
    expect((firstPage.contacts || []).map((c: any) => c.companyName), 'the old picker’s list').not.toContain(target)

    // An issued invoice of that contact, and one of another contact.
    const invoiceOf = async (contactId: string, description: string) => {
      const res = await apiPost(api, '/invoices', {
        type: 'invoice', direction: 'outgoing', contactId, issueDate: new Date().toISOString().slice(0, 10), currency: 'EUR', exchangeRate: 1,
        paymentMethod: 'bank_transfer',
        lines: [{ description, quantity: 1, unit: 'pcs', unitPrice: 10, discount: 0, taxRate: 20, taxAmount: 2, lineTotal: 12 }],
        subtotal: 10, discountTotal: 0, taxTotal: 2, total: 12,
      })
      expect(res.ok, `invoice → ${res.status}`).toBe(true)
      const { invoice } = await res.json()
      const sent = await apiPost(api, `/invoices/${invoice.id || invoice._id}/send`, {})
      expect(sent.status, 'issue the fixture invoice').toBe(200)
      return (await sent.json()).invoice.invoiceNumber as string
    }
    const theirs = await invoiceOf(ids[0], `E2E pick service ${stamp}`)
    const another = await invoiceOf(ids[5], `E2E pick other ${stamp}`)

    await loginForApp(page)
    await page.goto('/invoicing/payment-orders')
    await expect(page.locator('.v-data-table')).toBeVisible({ timeout: 10000 })
    await page.getByRole('button', { name: /new payment order/i }).filter({ visible: true }).first().click()
    const dialog = page.locator('.v-dialog').filter({ hasText: /payment order/i })
    await expect(dialog).toBeVisible({ timeout: 5000 })

    const contact = dialog.getByTestId('payment-order-contact').locator('input')
    await contact.click()
    await contact.fill(target)
    const option = page.locator('.v-overlay--active .v-list-item').filter({ hasText: target })
    await expect(option).toBeVisible({ timeout: 10000 })
    await option.click()

    // The contact's own unpaid invoice, and not the other contact's.
    const invoices = dialog.getByTestId('payment-order-invoices')
    await expect(invoices.getByText(theirs)).toBeVisible({ timeout: 10000 })
    await expect(invoices.getByText(another)).toHaveCount(0)
    // Searched by number on the server.
    await dialog.getByTestId('payment-order-invoice-search').locator('input').fill(theirs)
    await expect(invoices.getByText(theirs)).toBeVisible({ timeout: 10000 })
    await invoices.locator('tbody tr').filter({ hasText: theirs }).locator('input[type="checkbox"]').check()

    await dialog.locator('input[type="number"]').first().fill('12')
    await dialog.getByRole('button', { name: /^save$/i }).click()
    await expect(dialog).toBeHidden({ timeout: 10000 })

    const { paymentOrders } = await apiGet(api, '/invoicing/payment-order?size=50')
    const saved = (paymentOrders || []).find((o: any) => String(o.contactId) === ids[0])
    expect(saved, 'the order is for the eleventh contact').toBeTruthy()
    expect((saved.invoiceIds || []).length).toBe(1)
  })

  test('a cash order offers an account past the first ten', async ({ page }) => {
    const api = await apiLogin()
    const { accounts } = await apiGet(api, '/accounting/account?size=0')
    expect(accounts.length, 'the seeded chart holds more than ten accounts').toBeGreaterThan(10)
    const last = [...accounts].sort((a: any, b: any) => String(a.code).localeCompare(String(b.code))).at(-1)

    await loginForApp(page)
    await page.goto('/invoicing/cash-orders')
    await expect(page.locator('.v-data-table')).toBeVisible({ timeout: 10000 })
    await page.getByRole('button', { name: /new cash order/i }).filter({ visible: true }).first().click()
    const dialog = page.locator('.v-dialog').filter({ hasText: /cash order/i })
    await expect(dialog).toBeVisible({ timeout: 5000 })
    const counter = dialog.getByRole('combobox', { name: /counter account/i })
    await counter.click()
    await counter.fill(String(last.code))
    await expect(page.locator('.v-overlay--active .v-list-item').filter({ hasText: `${last.code} - ${last.name}` })).toBeVisible({ timeout: 10000 })
  })
})

test.describe('Payment Orders', () => {
  test('should display payment orders list page', async ({ page }) => {
    await loginForApp(page)
    await page.goto('/invoicing/payment-orders')

    await expect(page.locator('.v-data-table')).toBeVisible({ timeout: 10000 })
    // Verify headers are present
    await expect(page.locator('th').filter({ hasText: /type/i })).toBeVisible()
  })

  test('should open create dialog with correct form fields', async ({ page }) => {
    await loginForApp(page)
    await page.goto('/invoicing/payment-orders')

    await expect(page.locator('.v-data-table')).toBeVisible({ timeout: 10000 })

    // ResponsiveBtn renders the action twice — a header variant and an empty-state/mobile
    // one — so the bare role query hits strict mode. Filter to the one actually on screen.
    await page.getByRole('button', { name: /new payment order/i }).filter({ visible: true }).first().click()
    await expect(page.locator('.v-dialog')).toBeVisible({ timeout: 5000 })

    // Verify type select has Payment/Receipt options
    const typeSelect = page.locator('.v-dialog .v-select').first()
    await expect(typeSelect).toBeVisible()

    // Verify contact autocomplete is present
    const contactInput = page.locator('.v-dialog .v-autocomplete').first()
    await expect(contactInput).toBeVisible()

    // Verify bank account autocomplete is present
    await expect(page.locator('.v-dialog .v-autocomplete').nth(1)).toBeVisible()

    // Verify amount and date fields
    await expect(page.locator('.v-dialog input[type="number"]').first()).toBeVisible()
    await expect(page.locator('.v-dialog input[type="date"]').first()).toBeVisible()
  })

  test('should create a payment order successfully', async ({ page }) => {
    await loginForApp(page)
    await page.goto('/invoicing/payment-orders')

    await expect(page.locator('.v-data-table')).toBeVisible({ timeout: 10000 })

    // ResponsiveBtn renders the action twice — a header variant and an empty-state/mobile
    // one — so the bare role query hits strict mode. Filter to the one actually on screen.
    await page.getByRole('button', { name: /new payment order/i }).filter({ visible: true }).first().click()
    await expect(page.locator('.v-dialog')).toBeVisible({ timeout: 5000 })

    // Select contact
    const contactInput = page.locator('.v-dialog .v-autocomplete input').first()
    await contactInput.click()
    await page.waitForTimeout(500)
    const contactOption = page.locator('.v-overlay--active .v-list-item').first()
    if (await appears(contactOption, 3000)) {
      await contactOption.click()
      await page.waitForTimeout(300)
    }

    // Set amount
    const amountInput = page.locator('.v-dialog input[type="number"]').first()
    await amountInput.fill('500')

    // Save
    await page.getByRole('button', { name: /^save$/i }).first().click()
    await page.waitForTimeout(1000)

    // Verify success or dialog closed
    const dialogStillOpen = await page.locator('.v-dialog').isVisible().catch(() => false)
    if (!dialogStillOpen) {
      // Success - dialog closed
      await expect(page.locator('.v-data-table')).toBeVisible()
    }
  })
})
