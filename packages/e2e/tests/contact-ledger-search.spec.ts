import { test, expect } from '@playwright/test'
import { loginForApp } from './helpers/login'

/**
 * #526: a contact's ledger (`/invoicing/contacts/:id/ledger`) searches by product and by document
 * number on the server: the page sends what is typed once typing pauses, the rows narrow, and
 * clearing the field brings them back.
 *
 * Data: a customer, two articles and one issued invoice selling both, all this spec's own. The
 * bolt's name is spelled with a Cyrillic „Е" and searched with a Latin one, as people type it.
 */

const apiBase = process.env.BASE_URL || 'http://localhost:4001'
const ts = Date.now()
const BOLT = `Болт Е2Е ${ts}`
const GADGET = `Gadget E2E ${ts}`
let contactId = ''
let invoiceNumber = ''

test.beforeAll(async () => {
  const login = await (await fetch(`${apiBase}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ orgSlug: 'acme-corp', username: 'admin', password: 'test123' }),
  })).json()
  const orgId = login.org?.id || login.org?._id
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${apiBase}/api/org/${orgId}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${login.token}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const json = await res.json()
    if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${JSON.stringify(json).slice(0, 300)}`)
    return json
  }

  const warehouses = (await call('GET', '/warehouse/warehouse?size=100')).warehouses || []
  const warehouseId = (warehouses.find((w: any) => w.isDefault) || warehouses[0])._id
  const articles: any[] = []
  for (const [sku, name, price] of [[`E2E-LDG-B-${ts}`, BOLT, 2], [`E2E-LDG-G-${ts}`, GADGET, 10]] as const) {
    const { product } = await call('POST', '/warehouse/product', {
      sku, name, category: 'Test', type: 'goods', unit: 'pcs', sellingPrice: price, purchasePrice: 1, taxRate: 20,
    })
    articles.push({ ...product, price })
    // Stock to sell: issuing the invoice dispatches it.
    const { stockMovement } = await call('POST', '/warehouse/movement', {
      type: 'receipt', date: new Date().toISOString(), toWarehouseId: warehouseId,
      lines: [{ productId: product._id || product.id, quantity: 5, unitCost: 1, totalCost: 5 }], totalAmount: 5,
    })
    await call('POST', `/warehouse/movement/${stockMovement._id || stockMovement.id}/confirm`, {})
  }

  const { contact } = await call('POST', '/invoicing/contact', { type: 'customer', companyName: `E2E Ledger Customer ${ts}` })
  contactId = contact._id || contact.id

  const lines = articles.map((p) => ({
    productId: p._id || p.id, description: p.name, quantity: 1, unit: 'pcs', unitPrice: p.price, discount: 0, taxRate: 20,
    taxAmount: +(p.price * 0.2).toFixed(2), lineTotal: +(p.price * 1.2).toFixed(2), warehouseId,
  }))
  const subtotal = articles.reduce((s, p) => s + p.price, 0)
  const taxTotal = +(subtotal * 0.2).toFixed(2)
  const today = new Date().toISOString().slice(0, 10)
  const { invoice } = await call('POST', '/invoices', {
    type: 'invoice', direction: 'outgoing', contactId, issueDate: today, dueDate: today, currency: 'EUR', exchangeRate: 1,
    paymentMethod: 'bank_transfer', lines, subtotal, discountTotal: 0, taxTotal, total: +(subtotal + taxTotal).toFixed(2),
  })
  const sent = await call('POST', `/invoices/${invoice._id || invoice.id}/send`, {})
  invoiceNumber = sent.invoice.invoiceNumber
  expect(invoiceNumber).toBeTruthy()
})

test('typing a product or a number narrows the rows, and clearing it brings them back', async ({ page }) => {
  await loginForApp(page)
  await page.goto(`/invoicing/contacts/${contactId}/ledger`)
  const rows = page.locator('.v-data-table tbody tr')
  await expect(rows).toHaveCount(2, { timeout: 15000 })

  const product = page.getByTestId('ledger-product-search').locator('input')
  await product.fill('болт e2e')
  await expect(rows).toHaveCount(1)
  await expect(rows.first()).toContainText(BOLT)
  await product.fill('')
  await expect(rows).toHaveCount(2)

  const number = page.getByTestId('ledger-number-search').locator('input')
  await number.fill(invoiceNumber.slice(-6).toLowerCase())
  await expect(rows).toHaveCount(2)
  await expect(rows.first()).toContainText(invoiceNumber)
  await number.fill('no-such-number')
  await expect(page.getByText('No matching records')).toBeVisible()
  await number.fill('')
  await expect(rows).toHaveCount(2)
  await expect(page.getByText(GADGET)).toBeVisible()
})
