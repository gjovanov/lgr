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
 * Data, all this spec's own: a contact, an article they delivered ten of (a receipt with no bill), an
 * issued invoice selling them one (its dispatch is the invoice's movement) and a dispatch of two to
 * them with no invoice. The delivery names the contact, so it is nobody else's to bill: a receipt
 * naming no supplier would be offered to every other spec's bill.
 */

const apiBase = process.env.BASE_URL || 'http://localhost:4001'
// Named in the setup, not here: a setup that runs again in the same worker (a repeated run) makes its own.
let COMPANY = ''
let ARTICLE = ''
let NOTE = ''
let contactId = ''
let invoiceNumber = ''
/** The dispatch the invoice booked when it was issued. */
let invoiceMovement = ''
/** The dispatch to the contact that no invoice carries, booked from `NOTE`. */
let ownMovement = ''
let ownMovementId = ''
/** The delivery from the contact that no bill has come for. */
let delivery = ''

test.beforeAll(async () => {
  const ts = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  COMPANY = `E2E Ledger Movements ${ts}`
  ARTICLE = `Nut E2E ${ts}`
  NOTE = `e2e-note-${ts}`
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
  // A customer and a supplier at once, so the sales forms and the bill form both find it.
  const { contact } = await call('POST', '/invoicing/contact', { type: 'both', companyName: COMPANY })
  contactId = idOf(contact)

  const book = async (movement: Record<string, unknown>) => {
    // A movement takes the number after the latest: two made at the same moment (another worker's setup) draw the
    // same one, and the second is refused. Asked again, it draws the next.
    let made: any
    for (let attempt = 0; !made; attempt++) {
      made = await call('POST', '/warehouse/movement', { date: new Date().toISOString(), contactId, ...movement }).catch((e: Error) => {
        if (attempt >= 5 || !/already exists/.test(e.message)) throw e
        return null
      })
    }
    await call('POST', `/warehouse/movement/${idOf(made.stockMovement)}/confirm`, {})
    return made.stockMovement
  }
  delivery = (await book({ type: 'receipt', toWarehouseId: warehouseId, lines: [{ productId, quantity: 10, unitCost: 1, totalCost: 10 }], totalAmount: 10 })).movementNumber

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
    type: 'dispatch', fromWarehouseId: warehouseId, reference: NOTE,
    lines: [{ productId, quantity: 2, unitCost: 1, totalCost: 2 }], totalAmount: 2,
  })
  ownMovement = own.movementNumber
  ownMovementId = idOf(own)
  expect([invoiceNumber, invoiceMovement, ownMovement, delivery].every(Boolean)).toBe(true)
})

test('the ledger page: an invoice row names its movement, and a movement without an invoice is a row of its own', async ({ page }) => {
  await loginForApp(page)
  await page.goto(`/invoicing/contacts/${contactId}/ledger`)
  const rows = page.locator('.v-data-table tbody tr')
  await expect(rows).toHaveCount(3, { timeout: 15000 })
  await expect(page.getByRole('columnheader', { name: 'Stock movement' })).toBeVisible()

  const invoiceRow = rows.filter({ hasText: invoiceNumber })
  await expect(invoiceRow.getByTestId('ledger-movement')).toHaveText(invoiceMovement)
  await expect(invoiceRow).toContainText('Invoice')

  // A movement's own row: what it is, its number, the document it was booked from, and no invoice.
  const movementRow = rows.filter({ hasText: ownMovement })
  await expect(movementRow).toContainText('Dispatch')
  await expect(movementRow).toContainText(ARTICLE)
  await expect(movementRow.getByTestId('ledger-movement-reference')).toHaveText(NOTE)
  await expect(movementRow).not.toContainText('INV')
  await expect(movementRow.getByRole('link', { name: ownMovement })).toHaveAttribute('href', `/inventory/movements/${ownMovementId}`)
  await expect(rows.filter({ hasText: delivery })).toContainText('Receipt')

  // Type: Stock Movement Document leaves the movements; without it, the invoice is back.
  await openSelect(page, /^type$/i)
  await page.getByRole('option', { name: 'Stock Movement Document' }).click()
  await page.keyboard.press('Escape')
  await expect(rows).toHaveCount(2)
  await expect(invoiceRow).toHaveCount(0)
  await page.locator('.v-select .v-chip__close').click()
  await expect(rows).toHaveCount(3)

  // The number search finds a movement by its number or by the document it was booked from, and the invoice by its
  // movement's.
  const number = page.getByTestId('ledger-number-search').locator('input')
  await number.fill(NOTE)
  await expect(rows).toHaveCount(1)
  await expect(rows.first()).toContainText(ownMovement)
  await number.fill(invoiceMovement.toLowerCase())
  await expect(rows).toHaveCount(1)
  await expect(rows.first()).toContainText(invoiceNumber)
  await number.fill('')
  await expect(rows).toHaveCount(3)

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
    await expect(rows).toHaveCount(3, { timeout: 15000 })
    await expect(dialog.getByRole('columnheader', { name: 'Stock movement' })).toBeVisible()

    const invoiceRow = rows.filter({ hasText: invoiceNumber })
    await expect(invoiceRow.getByTestId('ledger-movement')).toHaveText(invoiceMovement)
    await expect(invoiceRow.getByRole('checkbox')).toHaveCount(1)

    // A movement's own row is listed, with no box to tick.
    const movementRow = rows.filter({ hasText: ownMovement })
    await expect(movementRow).toContainText('Dispatch')
    await expect(movementRow.getByRole('checkbox')).toHaveCount(0)
    await expect(rows.filter({ hasText: delivery }).getByRole('checkbox')).toHaveCount(0)

    await openSelect(dialog, /^type$/i)
    await page.getByRole('option', { name: 'Stock Movement Document' }).click()
    await page.keyboard.press('Escape')
    await expect(rows).toHaveCount(2)
    await expect(invoiceRow).toHaveCount(0)
  })
}

test('the contact form: its three buttons open their lists, and Movements lists the movements that name the contact', async ({ page }) => {
  await loginForApp(page)
  await page.goto(`/invoicing/contacts/${contactId}/edit`)
  const button = (label: string) => page.locator('.smart-button').filter({ hasText: label })
  const figure = (label: string) => button(label).locator('.font-weight-bold')
  const open = page.locator('.v-dialog.v-overlay--active')
  await expect(figure('Invoices')).toHaveText('1', { timeout: 15000 })

  // Invoices and Open Balance open the contact's ledger: the invoice's line and the two movements no document
  // carries, with nothing to tick (the form is the contact's own, not a document's).
  for (const label of ['Invoices', 'Open Balance']) {
    await button(label).click()
    await expect(open).toContainText('Contact Ledger')
    await expect(open.locator('.v-data-table tbody tr')).toHaveCount(3, { timeout: 15000 })
    await expect(open.locator('.v-data-table').getByRole('checkbox')).toHaveCount(0)
    await open.locator('.v-card-title .v-btn').click()
    await expect(open).toHaveCount(0)
  }

  // Movements: the delivery, the invoice's dispatch and the dispatch with no invoice.
  await expect(figure('Movements')).toHaveText('3')
  await button('Movements').click()

  const rows = page.getByTestId('contact-movements').locator('tbody tr')
  await expect(rows).toHaveCount(3)
  const own = rows.filter({ hasText: ownMovement })
  await expect(own).toContainText('Dispatch')
  await expect(own).toContainText(NOTE)
  await expect(own.getByRole('link', { name: ownMovement })).toHaveAttribute('href', `/inventory/movements/${ownMovementId}`)
  await expect(rows.filter({ hasText: invoiceMovement })).toContainText('Dispatch')
  await expect(rows.filter({ hasText: delivery })).toContainText('Receipt')
})
