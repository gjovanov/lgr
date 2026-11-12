import { test, expect } from '@playwright/test'
import { loginForApp } from './helpers/login'
import { openSelect } from './helpers/vuetify'

/**
 * A contact's ledger shows the stock movements too. A document's line names the movement that moved
 * its goods, and a movement of the contact's that no document carries is a row of its own: a
 * "Stock Movement Document", which the Type filter offers. The same table is the dialog a document
 * form opens from its contact field, where a movement's row is listed and not offered for the
 * document.
 *
 * Data, all this spec's own: an article with stock, a contact, an issued invoice selling one (its
 * dispatch is the invoice's movement) and a dispatch of two to the contact with no invoice.
 */

const apiBase = process.env.BASE_URL || 'http://localhost:4001'
// Named in the setup, not here: a setup that runs again in the same worker (a repeated run) makes its own.
let COMPANY = ''
let ARTICLE = ''
let REFERENCE = ''
let contactId = ''
let invoiceNumber = ''
/** The dispatch the invoice booked when it was issued. */
let invoiceMovement = ''
/** The dispatch to the contact that no invoice carries. */
let ownMovement = ''
let ownMovementId = ''

test.beforeAll(async () => {
  const ts = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  COMPANY = `E2E Ledger Movements ${ts}`
  ARTICLE = `Nut E2E ${ts}`
  REFERENCE = `e2e-note-${ts}`
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
  const idOf = (doc: any) => String(doc._id || doc.id)
  const today = new Date().toISOString().slice(0, 10)

  const warehouses = (await call('GET', '/warehouse/warehouse?size=100')).warehouses || []
  const warehouseId = idOf(warehouses.find((w: any) => w.isDefault) || warehouses[0])
  const { product } = await call('POST', '/warehouse/product', {
    sku: `E2E-LDM-${ts}`, name: ARTICLE, category: 'Test', type: 'goods', unit: 'pcs', sellingPrice: 2, purchasePrice: 1, taxRate: 20,
  })
  const productId = idOf(product)
  const book = async (movement: Record<string, unknown>) => {
    // A movement takes the number after the latest: two made at the same moment (another worker's setup) draw the
    // same one, and the second is refused. Asked again, it draws the next.
    let made: any
    for (let attempt = 0; !made; attempt++) {
      made = await call('POST', '/warehouse/movement', { date: new Date().toISOString(), ...movement }).catch((e: Error) => {
        if (attempt >= 5 || !/already exists/.test(e.message)) throw e
        return null
      })
    }
    await call('POST', `/warehouse/movement/${idOf(made.stockMovement)}/confirm`, {})
    return made.stockMovement
  }
  // Stock to sell, from nobody in particular: no row of anybody's ledger.
  await book({ type: 'receipt', toWarehouseId: warehouseId, lines: [{ productId, quantity: 10, unitCost: 1, totalCost: 10 }], totalAmount: 10 })

  // A customer and a supplier at once, so the sales forms and the bill form both find it.
  const { contact } = await call('POST', '/invoicing/contact', { type: 'both', companyName: COMPANY })
  contactId = idOf(contact)

  const { invoice } = await call('POST', '/invoices', {
    type: 'invoice', direction: 'outgoing', contactId, issueDate: today, dueDate: today, currency: 'EUR', exchangeRate: 1,
    paymentMethod: 'bank_transfer', subtotal: 2, discountTotal: 0, taxTotal: 0.4, total: 2.4,
    lines: [{ productId, description: ARTICLE, quantity: 1, unit: 'pcs', unitPrice: 2, discount: 0, taxRate: 20, taxAmount: 0.4, lineTotal: 2.4, warehouseId }],
  })
  const sent = await call('POST', `/invoices/${idOf(invoice)}/send`, {})
  invoiceNumber = sent.invoice.invoiceNumber
  const booked = (await call('GET', `/warehouse/movement?productId=${productId}&size=50`)).stockMovements
    .find((m: any) => String(m.invoiceId || '') === idOf(invoice))
  invoiceMovement = booked?.number || ''

  const own = await book({
    type: 'dispatch', fromWarehouseId: warehouseId, contactId, reference: REFERENCE,
    lines: [{ productId, quantity: 2, unitCost: 1, totalCost: 2 }], totalAmount: 2,
  })
  ownMovement = own.movementNumber
  ownMovementId = idOf(own)
  expect([invoiceNumber, invoiceMovement, ownMovement].every(Boolean)).toBe(true)
})

test('the ledger page: an invoice row names its movement, and a movement without an invoice is a row of its own', async ({ page }) => {
  await loginForApp(page)
  await page.goto(`/invoicing/contacts/${contactId}/ledger`)
  const rows = page.locator('.v-data-table tbody tr')
  await expect(rows).toHaveCount(2, { timeout: 15000 })
  await expect(page.getByRole('columnheader', { name: 'Stock movement' })).toBeVisible()

  const invoiceRow = rows.filter({ hasText: invoiceNumber })
  await expect(invoiceRow.getByTestId('ledger-movement')).toHaveText(invoiceMovement)
  await expect(invoiceRow).toContainText('Invoice')

  // The movement's own row: what it is, its number, the document it was booked from, and no invoice.
  const movementRow = rows.filter({ hasText: ownMovement })
  await expect(movementRow).toContainText('Dispatch')
  await expect(movementRow).toContainText(ARTICLE)
  await expect(movementRow.getByTestId('ledger-movement-reference')).toHaveText(REFERENCE)
  await expect(movementRow).not.toContainText('INV')
  await expect(movementRow.getByRole('link', { name: ownMovement })).toHaveAttribute('href', `/inventory/movements/${ownMovementId}`)

  // Type: Stock Movement Document leaves the movements; without it, both again.
  await openSelect(page, /^type$/i)
  await page.getByRole('option', { name: 'Stock Movement Document' }).click()
  await page.keyboard.press('Escape')
  await expect(rows).toHaveCount(1)
  await expect(rows.first()).toContainText(ownMovement)
  await page.locator('.v-select .v-chip__close').click()
  await expect(rows).toHaveCount(2)

  // The number search finds a movement by its number or by the document it was booked from, and the invoice by its
  // movement's.
  const number = page.getByTestId('ledger-number-search').locator('input')
  await number.fill(REFERENCE)
  await expect(rows).toHaveCount(1)
  await expect(rows.first()).toContainText(ownMovement)
  await number.fill(invoiceMovement.toLowerCase())
  await expect(rows).toHaveCount(1)
  await expect(rows.first()).toContainText(invoiceNumber)
  await number.fill('')
  await expect(rows).toHaveCount(2)

  // The number opens the movement.
  await movementRow.getByRole('link', { name: ownMovement }).click()
  await expect(page).toHaveURL(new RegExp(`/inventory/movements/${ownMovementId}`))
})

for (const [form, path] of [['invoice', '/invoicing/invoices/new'], ['bill', '/invoicing/bills/new'], ['proforma', '/invoicing/proforma/new']] as const) {
  test(`a new ${form}: the ledger its contact field opens lists the movements, and offers the document lines only`, async ({ page }) => {
    await loginForApp(page)
    await page.goto(path)
    const party = page.locator('.v-autocomplete').first()
    await party.locator('input').fill(COMPANY)
    await page.getByRole('option', { name: COMPANY }).click()
    await page.getByTitle('Contact Ledger').click()

    const dialog = page.locator('.v-dialog').filter({ hasText: 'Contact Ledger' })
    const rows = dialog.locator('.v-data-table tbody tr')
    await expect(rows).toHaveCount(2, { timeout: 15000 })
    await expect(dialog.getByRole('columnheader', { name: 'Stock movement' })).toBeVisible()

    const invoiceRow = rows.filter({ hasText: invoiceNumber })
    await expect(invoiceRow.getByTestId('ledger-movement')).toHaveText(invoiceMovement)
    await expect(invoiceRow.getByRole('checkbox')).toHaveCount(1)

    // A movement's own row is listed, with no box to tick.
    const movementRow = rows.filter({ hasText: ownMovement })
    await expect(movementRow).toContainText('Dispatch')
    await expect(movementRow.getByRole('checkbox')).toHaveCount(0)

    await openSelect(dialog, /^type$/i)
    await page.getByRole('option', { name: 'Stock Movement Document' }).click()
    await page.keyboard.press('Escape')
    await expect(rows).toHaveCount(1)
    await expect(rows.first()).toContainText(ownMovement)
  })
}
