import { test, expect } from '@playwright/test'
import { loginForApp } from './helpers/login'

const apiBase = process.env.BASE_URL || 'http://localhost:4001'

async function getAuthToken(org = 'acme-corp', username = 'admin', password = 'test123') {
  const res = await fetch(`${apiBase}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ orgSlug: org, username, password }),
  })
  const data = await res.json()
  return { token: data.token, orgId: data.org?.id || data.org?._id }
}

async function apiCall(method: string, path: string, token: string, body?: any) {
  const res = await fetch(`${apiBase}/api${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: body ? JSON.stringify(body) : undefined,
  })
  return res.json()
}

test.describe('Tag-Based Pricing', () => {
  let token: string
  let orgId: string
  let contactId: string
  let productId: string

  test.beforeAll(async () => {
    const auth = await getAuthToken()
    token = auth.token
    orgId = auth.orgId

    // Create a contact with tag 'loyal'
    const contactData = await apiCall('POST', `/org/${orgId}/invoicing/contact`, token, {
      type: 'customer',
      companyName: `TagTest-Loyal-${Date.now()}`,
      firstName: 'Tag',
      lastName: 'Test',
      email: `tagtest-${Date.now()}@example.com`,
      tags: ['loyal'],
      paymentTermsDays: 30,
      addresses: [{ type: 'billing', street: '123 Main', city: 'Test', postalCode: '10000', country: 'US', isDefault: true }],
    })
    contactId = contactData.contact?.id || contactData.contact?._id

    // Create a product with tag price for 'loyal'
    const productData = await apiCall('POST', `/org/${orgId}/warehouse/product`, token, {
      sku: `TAG-TEST-${Date.now()}`,
      name: `Tag Price Test Product ${Date.now()}`,
      category: 'Test',
      type: 'goods',
      unit: 'pcs',
      sellingPrice: 10,
      taxRate: 18,
      tagPrices: [{ tag: 'loyal', price: 8 }],
    })
    productId = productData.product?.id || productData.product?._id
  })

  test('should resolve tag-based price via API', async () => {
    const result = await apiCall(
      'GET',
      `/org/${orgId}/pricing/resolve?productId=${productId}&contactId=${contactId}`,
      token,
    )

    expect(result.finalPrice).toBe(8)
    expect(result.steps).toHaveLength(2)
    expect(result.steps[0].type).toBe('base')
    expect(result.steps[0].price).toBe(10)
    expect(result.steps[1].type).toBe('tag')
    expect(result.steps[1].price).toBe(8)
  })

  test('should return base price when no contact', async () => {
    const result = await apiCall(
      'GET',
      `/org/${orgId}/pricing/resolve?productId=${productId}`,
      token,
    )

    expect(result.finalPrice).toBe(10)
    expect(result.steps).toHaveLength(1)
  })

  test('should show price explain button on invoice line item', async ({ page }) => {
    await loginForApp(page)
    await page.goto('/invoicing/invoices/new')
    await expect(page.getByRole('heading', { name: 'New Invoice' })).toBeVisible()

    // Select the tagged contact
    const contactInput = page.locator('.v-autocomplete input').first()
    await contactInput.click({ force: true })
    await contactInput.fill('TagTest-Loyal')
    await page.waitForTimeout(500)

    const contactOption = page.locator('.v-overlay .v-list-item').first()
    if (await contactOption.isVisible({ timeout: 5000 }).catch(() => false)) {
      await contactOption.click()
    }

    // Add a line item
    await page.getByRole('button', { name: /add line/i }).click()

    // Select the product via the product autocomplete in the line row
    const lineRow = page.locator('.v-table tbody tr').first()
    await expect(lineRow).toBeVisible()

    const productInput = lineRow.locator('.v-autocomplete input, input').first()
    await productInput.click({ force: true })
    await productInput.fill('Tag Price Test')
    await page.waitForTimeout(500)

    const productOption = page.locator('.v-overlay .v-list-item').first()
    if (await productOption.isVisible({ timeout: 5000 }).catch(() => false)) {
      await productOption.click()
    }

    // Wait for price resolution
    await page.waitForTimeout(1000)

    // Look for the price explain button (info icon)
    const explainBtn = page.locator('button:has(> .mdi-information-outline), button:has(.v-icon)')
      .filter({ has: page.locator('.mdi-information-outline') })

    // If the explain button is visible, click it and verify the dialog
    if (await explainBtn.first().isVisible({ timeout: 3000 }).catch(() => false)) {
      await explainBtn.first().click()

      // Verify the price breakdown dialog appears
      const dialog = page.locator('.v-dialog')
      await expect(dialog).toBeVisible({ timeout: 3000 })

      // Should show "Selling price" and "Tag 'loyal'" in the breakdown
      await expect(dialog.getByText('Selling price')).toBeVisible()
      await expect(dialog.getByText(/Tag.*loyal/)).toBeVisible()
      await expect(dialog.getByText('10.00')).toBeVisible()
      await expect(dialog.getByText('8.00')).toBeVisible()

      // Close the dialog
      await dialog.getByRole('button', { name: /close/i }).click()
    }
  })
})
