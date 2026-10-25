import { test, expect } from '@playwright/test'
import { loginForApp } from './helpers/login'

/**
 * #171 „Фактура към касова продажба": from a paid cash sale, issue the customer's invoice. The
 * invoice is born paid, points at its cash sale, the cash sale lists it, and the stock the cash
 * sale moved is not moved a second time.
 */

const apiBase = process.env.BASE_URL || 'http://localhost:4001'

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

const today = () => new Date().toISOString().slice(0, 10)

/** A product, a customer and a paid cash sale of 2 × 10.00 + 20 % VAT to that customer. */
async function seedCashSale(token: string, orgId: string, withCustomer: boolean) {
  const ts = Date.now()
  const sku = `E2E-CSI-${ts}`
  const product = (await apiCall('POST', `/org/${orgId}/warehouse/product`, token, {
    sku, name: `E2E Болт ${sku}`, category: 'Test', type: 'goods', unit: 'pcs', sellingPrice: 10, taxRate: 20,
  })).product
  const productId = product.id || product._id
  const warehouses = (await apiCall('GET', `/org/${orgId}/warehouse/warehouse?size=1000`, token)).warehouses || []
  const warehouse = warehouses.find((w: any) => w.isDefault) || warehouses[0]
  const customer = (await apiCall('POST', `/org/${orgId}/invoicing/contact`, token, {
    type: 'customer', companyName: `E2E Купувач ${ts}`, email: `e2e-csi-${ts}@test.com`, paymentTermsDays: 0,
    addresses: [{ type: 'billing', street: 'ул. Витоша 1', city: 'София', postalCode: '1000', country: 'BG', isDefault: true }],
  })).contact
  const customerId = customer.id || customer._id
  const created = await apiCall('POST', `/org/${orgId}/invoices`, token, {
    type: 'cash_sale', direction: 'outgoing', issueDate: today(), currency: 'EUR',
    ...(withCustomer ? { contactId: customerId } : {}),
    lines: [{ productId, warehouseId: warehouse._id, description: product.name, quantity: 2, unitPrice: 10, taxRate: 20, taxAmount: 4, lineTotal: 24 }],
    subtotal: 20, taxTotal: 4, total: 24, paymentMethod: 'cash',
    // The demo stock may be zero; the test is about the invoice, not availability.
    allowNegativeStock: true,
  })
  const cashSale = created.invoice
  return { cashSale, cashSaleId: cashSale.id || cashSale._id, productId, warehouseId: warehouse._id, customer, customerId }
}

async function stockOf(token: string, orgId: string, productId: string, warehouseId: string): Promise<number> {
  const data = await apiCall('GET', `/org/${orgId}/warehouse/stock-level?productId=${productId}&size=0`, token)
  const level = (data.stockLevels || []).find((l: any) => String(l.warehouseId?._id || l.warehouseId) === String(warehouseId))
  return Number(level?.quantity) || 0
}

test.describe('Invoice for a cash sale (#171)', () => {
  test('issues the customer\'s invoice from the cash sale: paid, linked both ways, no second dispatch', async ({ page }) => {
    const { token, orgId } = await getAuthToken()
    const s = await seedCashSale(token, orgId, true)
    const stockAfterSale = await stockOf(token, orgId, s.productId, s.warehouseId)

    await loginForApp(page)
    await page.goto(`/invoicing/cash-sales/${s.cashSaleId}/edit`)
    await page.getByRole('button', { name: /^issue invoice$/i }).click()

    const dialog = page.locator('.v-dialog').filter({ hasText: `Invoice for cash sale ${s.cashSale.invoiceNumber}` })
    await expect(dialog).toBeVisible({ timeout: 10000 })
    // The sale named its customer: the dialog takes it, and the whole sale.
    await expect(dialog.getByText(/invoiced once, with every line in full/i)).toBeVisible()
    await dialog.getByRole('button', { name: /^issue invoice$/i }).click()

    await page.waitForURL('**/invoicing/invoices/*/edit', { timeout: 15000 })
    await expect(page.getByText(`Invoice for cash sale ${s.cashSale.invoiceNumber}`, { exact: false })).toBeVisible()
    const invoiceId = page.url().split('/invoices/')[1].split('/')[0]
    const invoice = (await apiCall('GET', `/org/${orgId}/invoices/${invoiceId}`, token)).invoice
    expect(invoice.status).toBe('paid')
    expect(invoice.total).toBe(24)
    expect(invoice.cashSaleRef.number).toBe(s.cashSale.invoiceNumber)

    // No second dispatch: the cash sale already moved the two bolts.
    expect(await stockOf(token, orgId, s.productId, s.warehouseId)).toBe(stockAfterSale)

    // The cash sale lists its invoice and offers no second one.
    await page.getByRole('link', { name: /open the cash sale/i }).click()
    await page.waitForURL(`**/invoicing/cash-sales/${s.cashSaleId}/edit`)
    await expect(page.locator('.v-chip', { hasText: invoice.invoiceNumber })).toBeVisible({ timeout: 10000 })
    await expect(page.getByRole('button', { name: /^issue invoice$/i })).toHaveCount(0)
  })

  test('a sale without a customer can be invoiced in part, from the list', async ({ page }) => {
    const { token, orgId } = await getAuthToken()
    const s = await seedCashSale(token, orgId, false)

    // The customer is chosen in the dialog; the API path is what the dialog posts.
    const state = (await apiCall('GET', `/org/${orgId}/invoices/${s.cashSaleId}/to-invoice`, token)).invoicing
    expect(state.wholeOnly).toBe(false)
    const one = await apiCall('POST', `/org/${orgId}/invoices/${s.cashSaleId}/to-invoice`, token, {
      contactId: s.customerId, lines: [{ lineId: state.lines[0].lineId, quantity: 1 }],
    })
    expect(one.invoice.total).toBe(12)

    await loginForApp(page)
    await page.goto('/invoicing/cash-sales')
    const row = page.locator('.v-data-table tbody tr', { hasText: s.cashSale.invoiceNumber })
    await expect(row.locator('.v-chip', { hasText: one.invoice.invoiceNumber })).toBeVisible({ timeout: 10000 })
    // One bolt is still to invoice, so the row still offers the action.
    await row.getByRole('button', { name: /^issue invoice$/i }).click()
    const dialog = page.locator('.v-dialog').filter({ hasText: 'Invoice for cash sale' })
    await expect(dialog.getByText(/what remains can be invoiced later/i)).toBeVisible({ timeout: 10000 })
    await expect(dialog.locator('.v-chip', { hasText: one.invoice.invoiceNumber })).toBeVisible()
  })
})
