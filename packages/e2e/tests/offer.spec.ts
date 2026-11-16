import { test, expect } from '@playwright/test'
import { loginForApp } from './helpers/login'
import { apiGet, apiLogin, apiPost } from './helpers/api'
import { draftDocument } from './helpers/draft-document'
import { rowAction, rowOf } from './helpers/row-actions'

/**
 * Offers („оферти") at /invoicing/offer: the proforma's list and form, in a series of their own —
 * DRF-OFR while a draft, OFR once issued — and converted, once, into a proforma or straight into an
 * invoice, which opens at once.
 *
 * The seed has no offers: each test makes its own through the API, a one-line service document for
 * the seeded customer, so nothing here moves stock.
 */

const NUMBER = '.doc-banner-meta .text-h6'

test.describe('Offers', () => {
  test('the menu leads to the offers, and „New Offer" to a blank offer of the offer series', async ({ page }) => {
    await loginForApp(page)
    await page.goto('/invoicing/offer')
    await expect(page.locator('.v-data-table')).toBeVisible({ timeout: 15000 })
    await expect(page.locator('.v-data-table th', { hasText: /converted into/i })).toBeVisible()

    await page.getByRole('link', { name: /new offer/i }).first().click()

    await page.waitForURL(/\/invoicing\/offer\/new/)
    await expect(page.getByRole('heading', { name: /new offer/i })).toBeVisible()
    // The number it will take, previewed: the offer draft series, never the proforma's or the invoices'.
    await expect(page.locator(NUMBER)).toHaveText(/^DRF-OFR-\d{4}-\d{5}$/)
  })

  test('issued from its form it takes an OFR number; „Convert to Proforma" opens the proforma it became', async ({ page }) => {
    const offer = await draftDocument('offer', 'outgoing', `E2E offer ${Date.now().toString(36)}`)
    expect(offer.invoiceNumber).toMatch(/^DRF-OFR-\d{4}-\d{5}$/)
    await loginForApp(page)
    await page.goto(`/invoicing/offer/${offer.id}/edit`)
    await expect(page.getByRole('heading', { name: /edit offer/i })).toBeVisible({ timeout: 15000 })
    await expect(page.locator(NUMBER)).toHaveText(offer.invoiceNumber)

    await page.getByRole('button', { name: /^issue$/i }).first().click()

    await expect(page.locator(NUMBER)).toHaveText(/^OFR-\d{4}-\d{5}$/, { timeout: 15000 })
    const issuedNumber = (await page.locator(NUMBER).textContent())!.trim()

    await page.getByRole('button', { name: /convert to proforma/i }).first().click()

    await page.waitForURL(/\/invoicing\/proforma\/[0-9a-f]{24}\/edit/, { timeout: 15000 })
    await expect(page.getByRole('heading', { name: /edit proforma invoice/i })).toBeVisible()
    await expect(page.locator('.v-snackbar').filter({ hasText: /converted to proforma/i })).toBeVisible()
    // A draft of the proforma draft series, which names the offer it came from.
    await expect(page.locator(NUMBER)).toHaveText(/^DRF-PRF-\d{4}-\d{5}$/)
    const proformaId = page.url().match(/\/proforma\/([0-9a-f]{24})\/edit/)![1]
    const session = await apiLogin()
    const proforma = (await apiGet(session, `/invoices/${proformaId}`)).invoice
    expect(proforma.type).toBe('proforma')
    expect(String(proforma.offerId)).toBe(offer.id)
    const converted = (await apiGet(session, `/invoices/${offer.id}`)).invoice
    expect(converted.status).toBe('converted')
    expect(String(converted.convertedInvoiceId)).toBe(proformaId)

    // The offer's row names what it became, and leads to it.
    await page.goto('/invoicing/offer')
    const row = rowOf(page, issuedNumber)
    await expect(row).toBeVisible({ timeout: 15000 })
    await row.getByRole('link', { name: proforma.invoiceNumber, exact: true }).click()
    await page.waitForURL(new RegExp(`/invoicing/proforma/${proformaId}/edit`))
  })

  test('an issued offer is converted straight into an invoice from its row', async ({ page }) => {
    const session = await apiLogin()
    const offer = await draftDocument('offer', 'outgoing', `E2E offer to invoice ${Date.now().toString(36)}`)
    const sent = await apiPost(session, `/invoices/${offer.id}/send`, {})
    expect(sent.status).toBe(200)
    const issuedNumber: string = (await sent.json()).invoice.invoiceNumber
    expect(issuedNumber).toMatch(/^OFR-\d{4}-\d{5}$/)
    await loginForApp(page)
    await page.goto('/invoicing/offer')
    const row = rowOf(page, issuedNumber)
    await expect(row).toBeVisible({ timeout: 15000 })

    // Both ways on are offered; this one goes straight to the invoice.
    await expect(await rowAction(row, 'convert-proforma')).toBeVisible()
    await page.keyboard.press('Escape')
    await (await rowAction(row, 'convert')).click()

    await page.waitForURL(/\/invoicing\/invoices\/[0-9a-f]{24}\/edit/, { timeout: 15000 })
    await expect(page.getByRole('heading', { name: /edit invoice/i })).toBeVisible()
    await expect(page.locator(NUMBER)).toHaveText(/^DRF-INV-\d{4}-\d{5}$/)
    const invoiceId = page.url().match(/\/invoices\/([0-9a-f]{24})\/edit/)![1]
    const invoice = (await apiGet(session, `/invoices/${invoiceId}`)).invoice
    expect(invoice.type).toBe('invoice')
    expect(String(invoice.offerId)).toBe(offer.id)
    expect(invoice.proformaId).toBeUndefined()

    // Converted once: the row offers no conversion any more.
    await page.goto('/invoicing/offer')
    const again = rowOf(page, issuedNumber)
    await expect(again).toBeVisible({ timeout: 15000 })
    const menu = await rowAction(again, 'convert')
    await expect(menu).toHaveCount(0)
  })
})
