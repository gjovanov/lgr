import { test, expect, type Page } from '@playwright/test'
import { loginForApp } from './helpers/login'
import { apiDelete, apiGet, apiLogin, apiPost, type ApiSession } from './helpers/api'
import { lineDescription, lineUnitPrice } from './helpers/document-form'

/**
 * The owner, 2026-11-12: "Manual price, unavailable for Seller, but available for Sales Consultant."
 *
 * `sales-docs.manual-price` (FR-27): on a sales document line the Seller PICKS a price the engine offers (the field's
 * list, the Select-price icon) and cannot type one; the Sales Consultant may type one, "12,5" included. Both users are
 * made through the API here and removed after.
 *
 * The server holds it too (#724, `services/biz/sales-lines.ts`): the last test sends the Seller's typed price past the
 * form, and a picked one beside it.
 */

// The line's product search is a fixed overlay under the input: give it room (invoicing-product-autocomplete.spec.ts).
test.use({ viewport: { width: 1280, height: 1200 } })
test.describe.configure({ mode: 'serial' })

const PASSWORD = 'e2e-test-pw-12345'
const STAMP = Date.now().toString(36)
const SKU = `E2E-MANUAL-${STAMP}`

let admin: ApiSession
let productId = ''
const users: Record<'seller' | 'sales_consultant', { username: string; id: string }> = {
  seller: { username: `e2e-seller-mp-${STAMP}`, id: '' },
  sales_consultant: { username: `e2e-consultant-mp-${STAMP}`, id: '' },
}
const invoices: string[] = []

async function okJson(res: Response) {
  const body = await res.json().catch(() => null)
  expect(res.ok, JSON.stringify(body)).toBe(true)
  return body
}

test.beforeAll(async () => {
  admin = await apiLogin()
  // A selling price of 10 and a tier that applies from one piece: the line resolves to 8, and its list offers both.
  const { product } = await okJson(await apiPost(admin, '/warehouse/product', {
    sku: SKU, name: `Manual price ${SKU}`, category: 'Test', type: 'service', unit: 'pcs', sellingPrice: 10, taxRate: 20,
    priceTiers: [{ name: 'Bulk', percent: 0, finalPrice: 8, manualOverride: true, contactIds: [], tags: [], minQuantity: 1 }],
  }))
  productId = String(product?._id || product?.id)
  for (const role of ['seller', 'sales_consultant'] as const) {
    const u = users[role]
    const { user } = await okJson(await apiPost(admin, '/user', {
      email: `${u.username}@acme.com`, username: u.username, password: PASSWORD, firstName: 'Manual', lastName: role, role,
    }))
    u.id = String(user?._id || user?.id)
  }
})

test.afterAll(async () => {
  for (const id of invoices) await apiDelete(admin, `/invoices/${id}`).catch(() => null)
  for (const u of Object.values(users)) if (u.id) await apiDelete(admin, `/user/${u.id}`).catch(() => null)
  if (productId) await apiDelete(admin, `/warehouse/product/${productId}`).catch(() => null)
})

/** A new invoice for the first customer, with one line of the test product, its resolved price arrived. */
async function invoiceWithTheProduct(page: Page) {
  await page.goto('/invoicing/invoices/new')
  await expect(page.getByRole('heading', { name: /new invoice/i })).toBeVisible({ timeout: 15000 })
  await page.locator('.v-autocomplete input').first().click({ force: true })
  await page.locator('.v-overlay .v-list-item').first().click()
  await page.getByRole('button', { name: /add line/i }).click()
  const row = page.locator('.v-table tbody tr').first()
  await lineDescription(row).locator('input').first().fill(SKU)
  const found = page.locator('.pld-overlay .pld-item').first()
  await expect(found).toBeVisible({ timeout: 10000 })
  await found.scrollIntoViewIfNeeded()
  await found.click({ force: true })
  await expect(lineDescription(row).locator('.v-chip')).toBeVisible({ timeout: 5000 })
  await expect(row.getByTestId('price-combobox')).toContainText('8.00000', { timeout: 10000 })
  return row
}

/** Save the draft and read it back as the API stores it. */
async function saveAndRead(page: Page): Promise<any> {
  await page.getByRole('button', { name: /^save$/i }).first().click()
  await expect(page).toHaveURL(/\/invoicing\/invoices\/[^/]+\/edit/, { timeout: 15000 })
  const id = new URL(page.url()).pathname.split('/').at(-2)!
  invoices.push(id)
  const { invoice } = await apiGet(admin, `/invoices/${id}`)
  return invoice
}

test('a Seller picks a price on a sales invoice line, and cannot type one', async ({ page }) => {
  await loginForApp(page, 'acme-corp', users.seller.username, PASSWORD)
  const row = await invoiceWithTheProduct(page)
  const field = row.getByTestId('price-combobox')

  // A list of the offered prices, said so, with no text to type into.
  await expect(field).toHaveAttribute('data-typed', 'false')
  await expect(field).toHaveClass(/v-select/)
  await expect(row.getByTestId('price-pick-only')).toBeVisible()
  // The Select-price icon is still there.
  await expect(row.getByRole('button', { name: /select price/i })).toBeVisible()

  // Typing changes nothing: "99.99" is not a price the list offers.
  await field.locator('input').focus()
  await page.keyboard.type('99.99')
  await page.keyboard.press('Escape')
  await page.keyboard.press('Tab')
  await expect(field).toContainText('8.00000')
  await expect(field).not.toContainText('99.99')

  // Picking one of the list works: the selling price, 10.
  await field.locator('.v-field__input').click()
  const selling = page.locator('.v-overlay--active .v-list-item').filter({ hasText: /^\s*10\.00/ })
  await expect(selling.first()).toBeVisible({ timeout: 5000 })
  await selling.first().click()
  await expect(field).toContainText('10.00000')

  const invoice = await saveAndRead(page)
  expect(invoice.lines[0].unitPrice).toBe(10)
  expect((invoice.lines[0].priceExplanation || []).map((s: any) => s.type)).not.toContain('override')
})

test('a Sales Consultant types a price, "12,5" read as 12.5', async ({ page }) => {
  await loginForApp(page, 'acme-corp', users.sales_consultant.username, PASSWORD)
  const row = await invoiceWithTheProduct(page)
  const field = row.getByTestId('price-combobox')

  await expect(field).toHaveAttribute('data-typed', 'true')
  await expect(row.getByTestId('price-pick-only')).toHaveCount(0)

  await lineUnitPrice(row).fill('12,5')
  await lineUnitPrice(row).press('Tab')
  await expect(field).toContainText('12.50000')

  const invoice = await saveAndRead(page)
  expect(invoice.lines[0].unitPrice).toBe(12.5)
  const steps = invoice.lines[0].priceExplanation || []
  expect(steps.at(-1)).toMatchObject({ type: 'override', price: 12.5 })
})

test('the server holds it too: the Seller\'s typed price is refused past the form, a picked one is not (#724)', async () => {
  const seller = await apiLogin('acme-corp', users.seller.username, PASSWORD)
  const { contacts } = await apiGet(admin, '/invoicing/contact?type=customer&size=50')
  const contact = (contacts as any[]).find(c => c.isActive !== false)
  expect(contact, 'an active customer in the demo org').toBeTruthy()
  const body = (unitPrice: number) => ({
    type: 'invoice', direction: 'outgoing', contactId: String(contact._id || contact.id), issueDate: new Date().toISOString().slice(0, 10), currency: 'EUR',
    lines: [{ productId, description: `Manual price ${SKU}`, quantity: 1, unit: 'pcs', unitPrice, taxRate: 20 }],
    subtotal: unitPrice, total: +(unitPrice * 1.2).toFixed(2),
  })
  const typed = await apiPost(seller, '/invoices', body(99.99))
  const refused = await typed.json().catch(() => null)
  expect(typed.status, JSON.stringify(refused)).toBe(403)
  expect(refused).toMatchObject({ code: 'price_not_offered', lines: [{ line: 1, unitPrice: 99.99 }] })
  // The tier the line resolves to: what the form gives a Seller without a click.
  const { invoice } = await okJson(await apiPost(seller, '/invoices', body(8)))
  invoices.push(String(invoice?._id || invoice?.id))
  expect(invoice.lines[0].unitPrice).toBe(8)
})
