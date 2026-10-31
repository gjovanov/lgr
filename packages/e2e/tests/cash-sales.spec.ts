import { test, expect } from '@playwright/test'
import { loginForApp } from './helpers/login'
import { createBackOfficeCashSale } from './helpers/cash-register'
import { appears } from './helpers/vuetify'

const apiBase = process.env.BASE_URL || 'http://localhost:4001'

// Same API setup as tag-pricing.spec.ts: the demo org's admin, straight to the API.
async function getAuthToken(org = 'acme-corp', username = 'admin', password = 'test123') {
  const res = await fetch(`${apiBase}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ orgSlug: org, username, password }),
  })
  const data = await res.json()
  return { token: data.token as string, orgId: (data.org?.id || data.org?._id) as string }
}

async function apiCall(method: string, path: string, token: string, body?: any) {
  const res = await fetch(`${apiBase}/api${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: body ? JSON.stringify(body) : undefined,
  })
  return res.json()
}

test.describe('Cash Register Sales', () => {
  test('should navigate to cash register sales and verify page renders', async ({ page }) => {
    await loginForApp(page)
    await page.goto('/invoicing/cash-sales')

    await expect(page.getByRole('heading', { name: 'Cash Register Sales' })).toBeVisible()
    await expect(page.locator('.v-data-table')).toBeVisible({ timeout: 10000 })
  })

  test('should navigate to the POS-style new cash sale screen', async ({ page }) => {
    await loginForApp(page)
    await page.goto('/invoicing/cash-sales')

    await expect(page.getByRole('heading', { name: 'Cash Register Sales' })).toBeVisible()

    // Click create button — navigates to /cash-sales/new. `.first()`: an empty list (the seed has
    // no cash sales) offers a second Create in its empty state, to the same page.
    await page.locator('a.v-btn', { hasText: /create/i }).first().click()
    await page.waitForURL('**/cash-sales/new')

    // FR-03: the detail page is a terminal — product catalog left, cart right.
    await expect(page.locator('.v-form')).toBeVisible({ timeout: 10000 })
    await expect(page.locator('.register-catalog')).toBeVisible({ timeout: 10000 })
    await expect(page.getByRole('button', { name: /^save$/i }).first()).toBeVisible()
  })

  test('should create a cash register sale by clicking a product card', async ({ page }) => {
    await loginForApp(page)
    await page.goto('/invoicing/cash-sales/new')

    await expect(page.locator('.v-form')).toBeVisible({ timeout: 10000 })

    // FR-03: lines are added by clicking product cards — there is no free-text line editor.
    const card = page.getByTestId('register-card').first()
    test.skip(!(await appears(card, 10000)), 'no products seeded — nothing to sell')

    await card.click()

    // The cart shows the line with its qty stepper; Save becomes enabled.
    await expect(page.locator('[data-testid^="cart-line-"]').first()).toBeVisible()
    const saveBtn = page.getByRole('button', { name: /^save$/i }).first()
    await expect(saveBtn).toBeEnabled()
    await saveBtn.click()

    // Either straight back to the list, or the stock-transfer dialog intervenes on short stock.
    await expect(
      page.getByRole('heading', { name: 'Cash Register Sales' }).or(page.locator('.v-dialog')),
    ).toBeVisible({ timeout: 10000 })
  })

  // #134: a cart line prices from a dropdown listing EVERY named price, the filterless
  // „Цена N" slots included — which the invoice dropdown does not show.
  test('a cart line offers every named price in its dropdown', async ({ page }) => {
    const { token, orgId } = await getAuthToken()
    const sku = `E2E-CSP-${Date.now()}`
    const created = await apiCall('POST', `/org/${orgId}/warehouse/product`, token, {
      sku, name: `Cash price ${sku}`, category: 'Test', type: 'goods', unit: 'pcs',
      sellingPrice: 10, taxRate: 20,
      priceTiers: [
        { name: 'Цена 1', percent: 0, finalPrice: 9, manualOverride: true, contactIds: [], tags: [] },
        { name: 'Цена 2', percent: 0, finalPrice: 8, manualOverride: true, contactIds: [], tags: [] },
      ],
    })
    expect(created.product?.id || created.product?._id).toBeTruthy()

    await loginForApp(page)
    await page.goto('/invoicing/cash-sales/new')
    await expect(page.locator('.register-catalog')).toBeVisible({ timeout: 10000 })
    await page.locator('.register-catalog input').first().fill(sku)
    await page.getByTestId('register-card').filter({ hasText: sku }).click()

    const row = page.locator('[data-testid^="cart-line-"]', { hasText: sku })
    const price = row.getByTestId('price-combobox')
    await expect(price).toBeVisible()
    // The selling price applies until the cashier picks another.
    await expect(price).toContainText('10.00000')

    // Click the field wrapper, not the input (tests/helpers/vuetify.ts explains why).
    await price.locator('.v-field').first().click()
    const options = page.getByRole('option')
    await expect(options.filter({ hasText: 'Цена 1' })).toBeVisible()
    await expect(options.filter({ hasText: 'Цена 2' })).toBeVisible()

    await options.filter({ hasText: 'Цена 2' }).click()
    await expect(price).toContainText('8.00000')
  })

  // FR-21.13: the page is the cash-register journal. A paid cash sale reads "Completed" — or
  // "Stornoed" once a storno reverses it — and there is no Void any more.
  test('shows a back-office cash sale as completed, with no Void button', async ({ page }) => {
    // The seed has no cash sales; a fresh one keeps this independent of the other specs.
    const sale = await createBackOfficeCashSale()
    await loginForApp(page)
    await page.goto(`/invoicing/cash-sales?q=${sale.number}`)

    const row = page.locator('.v-data-table tbody tr').filter({ has: page.getByRole('link', { name: sale.number, exact: true }) })
    await expect(row).toBeVisible({ timeout: 10000 })
    await expect(row.getByTestId('journal-status-chip')).toHaveText('Completed')
    await expect(row.getByTestId('journal-kind-chip')).toHaveText('Sale')
    await expect(row).toContainText('Back office')
    await expect(page.getByRole('button', { name: /^void$/i })).toHaveCount(0)
  })
})
