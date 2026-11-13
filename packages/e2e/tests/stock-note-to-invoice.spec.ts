import { test, expect } from '@playwright/test'
import { loginForApp } from './helpers/login'
import { apiGet, apiLogin, apiPost } from './helpers/api'
import { answerIssuePayment, lineQuantity, lineValues } from './helpers/document-form'
import { rowAction, rowOf } from './helpers/row-actions'

/**
 * FR-22.61 / FR-22.62 (#725): the customer's invoice for goods a stock note already delivered.
 *
 * Goods leave on a dispatch that names the customer, and the invoice comes after. An invoice typed by hand for them
 * used to take them out of stock a second time. Now the dispatch's page makes its invoice (linked, so it moves no
 * stock), an invoice typed anyway is asked before it is issued, and a draft can be linked from its form or from the
 * contact's ledger.
 *
 * Every test makes its own customer and its own article, so no other spec's invoice meets these notes, and a test
 * run again starts from nothing. Ten are delivered, three leave on the note: the stock reads 7 until an invoice
 * dispatches again.
 */

interface World {
  session: Awaited<ReturnType<typeof apiLogin>>
  company: string
  article: string
  contactId: string
  productId: string
  warehouseId: string
  noteId: string
  noteNumber: string
}

const idOf = (doc: any) => String(doc._id || doc.id)
const today = () => new Date().toISOString().slice(0, 10)

async function post(w: Pick<World, 'session'>, path: string, body: unknown = {}) {
  const res = await apiPost(w.session, path, body)
  const json = await res.json()
  expect(res.ok, `POST ${path}: ${res.status} ${JSON.stringify(json).slice(0, 300)}`).toBe(true)
  return json
}

async function world(tag: string, noteQuantity = 3, named = true): Promise<World> {
  const session = await apiLogin()
  const stamp = `${tag}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`
  const company = `E2E Note Customer ${stamp}`
  const article = `E2E Note Bolt ${stamp}`
  const warehouses = (await apiGet(session, '/warehouse/warehouse?size=100')).warehouses || []
  const warehouseId = idOf(warehouses.find((x: any) => x.isDefault) || warehouses[0])
  const w = { session }
  const { product } = await post(w, '/warehouse/product', {
    sku: `E2E-SN-${stamp}`, name: article, category: 'Test', type: 'goods', unit: 'pcs', sellingPrice: 2, purchasePrice: 1, taxRate: 20,
  })
  const productId = idOf(product)
  const { contact } = await post(w, '/invoicing/contact', { type: 'customer', companyName: company })
  const contactId = idOf(contact)
  const book = async (movement: Record<string, unknown>) => {
    const { stockMovement } = await post(w, '/warehouse/movement', { date: new Date().toISOString(), ...movement })
    await post(w, `/warehouse/movement/${idOf(stockMovement)}/confirm`)
    return stockMovement
  }
  await book({ type: 'receipt', toWarehouseId: warehouseId, lines: [{ productId, quantity: 10, unitCost: 1, totalCost: 10 }], totalAmount: 10 })
  const note = await book({
    type: 'dispatch', fromWarehouseId: warehouseId, ...(named ? { contactId } : {}),
    lines: [{ productId, quantity: noteQuantity, unitCost: 1, totalCost: noteQuantity }], totalAmount: noteQuantity,
  })
  return { session, company, article, contactId, productId, warehouseId, noteId: idOf(note), noteNumber: note.movementNumber }
}

/** A draft sales invoice typed by hand for the world's customer and article. */
async function typedInvoice(w: World, quantity: number, unitPrice: number) {
  const net = quantity * unitPrice
  const { invoice } = await post(w, '/invoices', {
    type: 'invoice', direction: 'outgoing', contactId: w.contactId, issueDate: today(), dueDate: today(), currency: 'EUR', exchangeRate: 1,
    paymentMethod: 'bank_transfer', subtotal: +net.toFixed(2), discountTotal: 0, taxTotal: +(net * 0.2).toFixed(2), total: +(net * 1.2).toFixed(2),
    lines: [{
      productId: w.productId, description: w.article, quantity, unit: 'pcs', unitPrice, discount: 0, taxRate: 20,
      taxAmount: +(net * 0.2).toFixed(2), lineTotal: +(net * 1.2).toFixed(2), warehouseId: w.warehouseId,
    }],
  })
  return { id: idOf(invoice), number: invoice.invoiceNumber as string }
}

const stockOf = async (w: World) =>
  (await apiGet(w.session, `/warehouse/stock-level?productId=${w.productId}&warehouseId=${w.warehouseId}&size=5`)).stockLevels?.[0]?.quantity ?? 0
const invoiceOf = async (w: World, id: string) => (await apiGet(w.session, `/invoices/${id}`)).invoice
const noteOf = async (w: World) => (await apiGet(w.session, `/warehouse/movement/${w.noteId}`)).stockMovement
const issueButton = (page: any) => page.getByRole('button', { name: 'Issue', exact: true }).first()
const draftId = (url: string) => /\/invoicing\/invoices\/([0-9a-f]{24})\/edit/.exec(url)?.[1] || ''

test('a completed dispatch makes its invoice: the customer\'s price, linked, and issuing it moves no stock', async ({ page }) => {
  const w = await world('made')
  expect(await stockOf(w)).toBe(7)
  await loginForApp(page)
  await page.goto(`/inventory/movements/${w.noteId}`)

  await page.getByRole('button', { name: 'Sales invoice' }).click()
  await expect(page).toHaveURL(/\/invoicing\/invoices\/[0-9a-f]{24}\/edit/, { timeout: 20000 })
  const id = draftId(page.url())

  // The draft: the note's three at the selling price (2.00, never its cost of 1.00), and the note named on it.
  const banner = page.getByTestId('invoice-dispatches')
  await expect(banner).toBeVisible({ timeout: 15000 })
  await expect(banner.getByTestId('invoice-dispatch-link')).toHaveText(w.noteNumber)
  await expect(banner.getByTestId('invoice-dispatch-link')).toHaveAttribute('href', new RegExp(`/inventory/movements/${w.noteId}$`))
  const row = page.locator('.line-table tbody tr').first()
  await expect(lineQuantity(row)).toHaveValue('3')
  expect((await lineValues(page))[0]).toContain(w.article)
  expect((await invoiceOf(w, id)).lines.map((l: any) => [l.quantity, l.unitPrice, l.lineTotal])).toEqual([[3, 2, 7.2]])
  // Linked already, it is offered no second link.
  await expect(page.getByTestId('link-note-btn')).toHaveCount(0)

  // Issued, it asks nothing about the goods and takes none.
  await issueButton(page).click()
  await answerIssuePayment(page)
  await expect(page.getByTestId('dispatch-overlap-dialog')).toHaveCount(0)
  await expect.poll(async () => (await invoiceOf(w, id)).status, { timeout: 15000 }).toBe('sent')
  expect(await stockOf(w)).toBe(7)
  const invoice = await invoiceOf(w, id)
  expect(invoice.lines.map((l: any) => [l.quantity, l.unitPrice])).toEqual([[3, 2]])
  expect(invoice.total).toBe(7.2)

  // The dispatch names its invoice, on its page and in the list, and offers no second one.
  await page.goto(`/inventory/movements/${w.noteId}`)
  const sale = page.getByTestId('dispatch-sale')
  await expect(sale).toBeVisible({ timeout: 15000 })
  await expect(sale.getByTestId('dispatch-sale-link')).toHaveText(invoice.invoiceNumber)
  await expect(page.getByRole('button', { name: 'Sales invoice' })).toHaveCount(0)
  await page.goto(`/inventory/movements?productId=${w.productId}`)
  const listed = page.locator('.v-data-table tbody tr').filter({ hasText: w.noteNumber })
  await expect(listed.getByTestId('movement-invoiced')).toHaveAttribute('href', new RegExp(`/invoicing/invoices/${id}/edit$`), { timeout: 15000 })
})

test('a dispatch that names no customer asks whose goods they were, and takes the customer its invoice is made out to', async ({ page }) => {
  const w = await world('nobody', 3, false)
  await loginForApp(page)
  await page.goto(`/inventory/movements/${w.noteId}`)
  await page.getByRole('button', { name: 'Sales invoice' }).click()

  // The question comes first, and nothing is made until it is answered.
  const dialog = page.getByTestId('invoice-customer-dialog')
  await expect(dialog).toBeVisible({ timeout: 15000 })
  await expect(dialog).toContainText('names no customer')
  await expect(dialog.getByTestId('invoice-customer-confirm')).toBeDisabled()
  expect((await noteOf(w)).invoiceId ?? null).toBeNull()

  await dialog.locator('input').first().fill(w.company)
  await page.getByRole('option').filter({ hasText: w.company }).first().click()
  await dialog.getByTestId('invoice-customer-confirm').click()

  await expect(page).toHaveURL(/\/invoicing\/invoices\/[0-9a-f]{24}\/edit/, { timeout: 20000 })
  const id = draftId(page.url())
  await expect(page.getByTestId('invoice-dispatches')).toContainText(w.noteNumber, { timeout: 15000 })
  const invoice = await invoiceOf(w, id)
  expect(String(invoice.contactId?._id || invoice.contactId)).toBe(w.contactId)
  // The dispatch keeps the customer for as long as the invoice holds it.
  expect(String((await noteOf(w)).contactId)).toBe(w.contactId)
})

test('an invoice typed for the same goods is asked first: linked, it keeps its price and takes no stock', async ({ page }) => {
  const w = await world('link')
  const typed = await typedInvoice(w, 3, 1.9)
  await loginForApp(page)
  await page.goto(`/invoicing/invoices/${typed.id}/edit`)
  await expect(issueButton(page)).toBeVisible({ timeout: 15000 })

  // The question comes before the payment method and before any stock is checked.
  await issueButton(page).click()
  const question = page.getByTestId('dispatch-overlap-dialog')
  await expect(question).toBeVisible({ timeout: 15000 })
  await expect(page.getByTestId('issue-payment-confirm')).toHaveCount(0)
  const noteRow = question.getByTestId('dispatch-overlap-row')
  await expect(noteRow).toHaveCount(1)
  await expect(noteRow).toContainText(w.noteNumber)
  // The one note that names this customer is ticked for the person.
  await expect(noteRow.getByRole('checkbox')).toBeChecked()

  await question.getByTestId('dispatch-overlap-link').click()
  // Its lines already said what the note delivered, so it is issued as typed.
  await answerIssuePayment(page)
  await expect.poll(async () => (await invoiceOf(w, typed.id)).status, { timeout: 15000 }).toBe('sent')
  expect(await stockOf(w)).toBe(7)
  const invoice = await invoiceOf(w, typed.id)
  expect(invoice.lines.map((l: any) => [l.quantity, l.unitPrice])).toEqual([[3, 1.9]])
  expect(invoice.stockSource.marker).toBe(`dispatch:${w.noteId}`)
  await expect(page.getByTestId('invoice-dispatches')).toContainText(w.noteNumber)
  expect((await noteOf(w)).sale).toMatchObject({ id: typed.id })
})

test('"other goods" issues the invoice as it is, and the goods leave again', async ({ page }) => {
  const w = await world('other')
  const typed = await typedInvoice(w, 3, 1.9)
  await loginForApp(page)
  await page.goto(`/invoicing/invoices/${typed.id}/edit`)
  await expect(issueButton(page)).toBeVisible({ timeout: 15000 })

  // Closed without an answer, it stays a draft and says why.
  await issueButton(page).click()
  const question = page.getByTestId('dispatch-overlap-dialog')
  await expect(question).toBeVisible({ timeout: 15000 })
  await question.getByRole('button', { name: 'Cancel' }).click()
  await expect(question).toBeHidden()
  await expect(page.getByText('Not issued')).toBeVisible()
  expect((await invoiceOf(w, typed.id)).status).toBe('draft')
  expect(await stockOf(w)).toBe(7)

  await issueButton(page).click()
  await expect(question).toBeVisible({ timeout: 15000 })
  await question.getByTestId('dispatch-overlap-issue').click()
  await answerIssuePayment(page)
  await expect.poll(async () => (await invoiceOf(w, typed.id)).status, { timeout: 15000 }).toBe('sent')
  expect(await stockOf(w)).toBe(4)
  expect((await invoiceOf(w, typed.id)).stockSource?.marker || '').toBe('')
  // The note is still nobody's.
  expect((await noteOf(w)).invoiceable).toBe(true)
})

test('an invoice that says something else is told how, and takes the note\'s lines only on a second press', async ({ page }) => {
  const w = await world('differ')
  const typed = await typedInvoice(w, 2, 1.9)
  await loginForApp(page)
  await page.goto(`/invoicing/invoices/${typed.id}/edit`)
  await expect(issueButton(page)).toBeVisible({ timeout: 15000 })

  await issueButton(page).click()
  const question = page.getByTestId('dispatch-overlap-dialog')
  await expect(question).toBeVisible({ timeout: 15000 })
  await expect(question.getByTestId('dispatch-differs')).toHaveCount(0)
  await question.getByTestId('dispatch-overlap-link').click()

  // Nothing is linked yet: the difference is named, and the button says what the next press does.
  const differs = question.getByTestId('dispatch-differs')
  await expect(differs).toBeVisible()
  await expect(differs.getByTestId('dispatch-differs-line')).toHaveText(`${w.article}: dispatched 3, invoiced 2`)
  expect((await invoiceOf(w, typed.id)).stockSource?.marker || '').toBe('')
  await expect(question.getByTestId('dispatch-overlap-link')).toHaveText('Replace the lines and link')

  await question.getByTestId('dispatch-overlap-link').click()
  await expect(question).toBeHidden()
  // Linked, with the note's three at the customer's price, and still a draft to be read.
  await expect(page.getByTestId('invoice-dispatches')).toContainText(w.noteNumber, { timeout: 15000 })
  await expect(lineQuantity(page.locator('.line-table tbody tr').first())).toHaveValue('3')
  await expect(page.getByTestId('issue-payment-confirm')).toHaveCount(0)
  const invoice = await invoiceOf(w, typed.id)
  expect([invoice.status, invoice.lines.map((l: any) => [l.quantity, l.unitPrice]), invoice.total]).toEqual(['draft', [[3, 2]], 7.2])
  expect(await stockOf(w)).toBe(7)

  // Its quantity is the note's from now on: the form's save is refused in the user's words.
  await lineQuantity(page.locator('.line-table tbody tr').first()).fill('5')
  await page.getByRole('button', { name: 'Save', exact: true }).first().click()
  await expect(page.getByText(`„${w.article}“ was dispatched 3 and is invoiced 5`)).toBeVisible()
  expect((await invoiceOf(w, typed.id)).lines[0].quantity).toBe(3)
})

test('a new invoice takes a stock note from its form: the picker lists the customer\'s notes', async ({ page }) => {
  const w = await world('pick')
  await loginForApp(page)
  await page.goto('/invoicing/invoices/new')
  const party = page.locator('.v-autocomplete').first()
  await party.locator('input').fill(w.company)
  await page.getByRole('option', { name: w.company }).click()

  await page.getByTestId('link-note-btn').click()
  const picker = page.getByTestId('link-note-dialog')
  const rows = picker.getByTestId('link-note-row')
  await expect(rows).toHaveCount(1, { timeout: 15000 })
  await expect(rows).toContainText(w.noteNumber)
  await expect(rows).toContainText('1 line, 3 in all')
  await expect(rows.getByRole('checkbox')).toBeChecked()
  await picker.getByTestId('link-note-confirm').click()

  await expect(page).toHaveURL(/\/invoicing\/invoices\/[0-9a-f]{24}\/edit/, { timeout: 20000 })
  const id = draftId(page.url())
  await expect(page.getByTestId('invoice-dispatches')).toContainText(w.noteNumber, { timeout: 15000 })
  await expect(lineQuantity(page.locator('.line-table tbody tr').first())).toHaveValue('3')
  const invoice = await invoiceOf(w, id)
  expect([invoice.status, invoice.stockSource.marker, String(invoice.contactId?._id || invoice.contactId)]).toEqual(['draft', `dispatch:${w.noteId}`, w.contactId])

  // Nothing is left to pick for this customer.
  expect((await apiGet(w.session, `/invoicing/sales/invoiceable-dispatches?contactId=${w.contactId}`)).dispatches).toEqual([])
})

test('a draft with other quantities is linked from its form only after the difference is shown', async ({ page }) => {
  const w = await world('pickdiff')
  const typed = await typedInvoice(w, 2, 1.9)
  await loginForApp(page)
  await page.goto(`/invoicing/invoices/${typed.id}/edit`)

  await page.getByTestId('link-note-btn').click()
  const picker = page.getByTestId('link-note-dialog')
  await expect(picker.getByTestId('link-note-row')).toHaveCount(1, { timeout: 15000 })
  await expect(picker.getByTestId('link-note-confirm')).toHaveText('Link')
  await picker.getByTestId('link-note-confirm').click()

  // Refused, with the difference by name; the invoice is as it was.
  await expect(picker.getByTestId('dispatch-differs-line')).toHaveText(`${w.article}: dispatched 3, invoiced 2`)
  await expect(picker.getByTestId('link-note-confirm')).toHaveText('Replace the lines and link')
  expect((await invoiceOf(w, typed.id)).stockSource?.marker || '').toBe('')

  await picker.getByTestId('link-note-confirm').click()
  await expect(picker).toBeHidden()
  await expect(page.getByTestId('invoice-dispatches')).toContainText(w.noteNumber, { timeout: 15000 })
  await expect(lineQuantity(page.locator('.line-table tbody tr').first())).toHaveValue('3')
  const invoice = await invoiceOf(w, typed.id)
  expect([invoice.status, invoice.stockSource.marker, invoice.lines.map((l: any) => [l.quantity, l.unitPrice])]).toEqual(['draft', `dispatch:${w.noteId}`, [[3, 2]]])
})

test('the contact ledger offers a stock note as a link, never as lines', async ({ page }) => {
  const w = await world('ledger')
  await loginForApp(page)
  await page.goto('/invoicing/invoices/new')
  const party = page.locator('.v-autocomplete').first()
  await party.locator('input').fill(w.company)
  await page.getByRole('option', { name: w.company }).click()
  await page.getByTitle('Contact Ledger').click()

  const dialog = page.locator('.v-dialog').filter({ hasText: 'Contact Ledger' })
  const noteRow = dialog.locator('.v-data-table tbody tr').filter({ hasText: w.noteNumber })
  await expect(noteRow).toHaveCount(1, { timeout: 15000 })
  const link = dialog.getByTestId('ledger-link-notes')
  await expect(link).toBeDisabled()
  await noteRow.getByTestId('ledger-note-tick').locator('input').check()
  // The note's tick adds no line to the invoice.
  await expect(dialog.getByRole('button', { name: 'Add Line Items' })).toBeDisabled()
  await link.click()

  await expect(page).toHaveURL(/\/invoicing\/invoices\/[0-9a-f]{24}\/edit/, { timeout: 20000 })
  await expect(page.getByTestId('invoice-dispatches')).toContainText(w.noteNumber, { timeout: 15000 })
  expect((await invoiceOf(w, draftId(page.url()))).stockSource.marker).toBe(`dispatch:${w.noteId}`)
  // Held by a draft, the note stays a row of the ledger, with nothing left to tick.
  await page.getByTitle('Contact Ledger').click()
  await expect(noteRow).toHaveCount(1, { timeout: 15000 })
  await expect(noteRow.getByTestId('ledger-note-tick')).toHaveCount(0)
})

test('the sales list asks the same question before it issues a row', async ({ page }) => {
  const w = await world('list')
  const typed = await typedInvoice(w, 3, 1.9)
  await loginForApp(page)
  await page.goto(`/invoicing/invoices?q=${encodeURIComponent(typed.number)}`)
  const row = rowOf(page, typed.number)
  await expect(row).toHaveCount(1, { timeout: 15000 })

  await (await rowAction(row, 'issue')).click()
  const question = page.getByTestId('dispatch-overlap-dialog')
  await expect(question).toBeVisible({ timeout: 15000 })
  await expect(question.getByTestId('dispatch-overlap-row')).toContainText(w.noteNumber)
  await question.getByTestId('dispatch-overlap-link').click()
  await answerIssuePayment(page)
  await expect.poll(async () => (await invoiceOf(w, typed.id)).status, { timeout: 15000 }).toBe('sent')
  expect(await stockOf(w)).toBe(7)
})
