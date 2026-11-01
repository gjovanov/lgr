import { test, expect, type Page } from '@playwright/test'
import { signInForUx, uxApi } from './helpers/ux-budget'
import { chooseOption, openSelect } from './helpers/vuetify'
import { rowAction, rowOf } from './helpers/row-actions'
import { deliveryNote, movementMarker } from '../../config/src/movement-notes'

/**
 * #168 in the Bulgarian UI: goods on a receipt become a bill, and the bill never books them twice.
 *
 * `ux-budgets/p3-bill.spec.ts` walks the path that always worked: a receipt that names its supplier.
 * This spec walks the ends that were dead:
 *   - a receipt with no supplier had no „Входяща фактура" and no way to get one;
 *   - a draft bill with typed lines could not take a delivery, and receiving it booked the goods a
 *     second time, from the form or from the list, with no warning;
 *   - a new movement starts as a receipt with its To warehouse filled in, and changing it to a
 *     dispatch kept that warehouse: the dispatch ADDED stock.
 *
 * Every test makes an article of its own, so no other spec's stock moves with it, and the supplier
 * and warehouse come from the seed.
 */

type Api = Awaited<ReturnType<typeof uxApi>>

interface World {
  api: Api
  warehouse: any
  supplier: any
  article: any
  stamp: string
}

async function world(tag: string): Promise<World> {
  const api = await uxApi()
  const stamp = `${tag}-${Date.now().toString(36)}`
  const warehouses = (await api.get('/warehouse/warehouse?size=100')).warehouses
  const warehouse = warehouses.find((w: any) => w.isDefault) || warehouses[0]
  const supplier = (await api.get('/invoicing/contact?type=supplier&size=5')).contacts[0]
  const { product } = await api.post('/warehouse/product', {
    sku: `E2E-RB-${stamp}`, name: `E2E доставка ${stamp}`, category: 'General', type: 'goods', unit: 'pcs',
    purchasePrice: 2.5, sellingPrice: 4, taxRate: 20,
  })
  return { api, warehouse, supplier, article: product, stamp }
}

const today = () => new Date().toISOString().split('T')[0]

/** The world's supplier becomes one of its own: what `/billable-receipts` lists is then this test's alone. */
async function ownSupplier(w: World) {
  const { contact } = await w.api.post('/invoicing/contact', { type: 'supplier', companyName: `Доставчик ${w.stamp}` })
  w.supplier = { ...contact, _id: contact._id || contact.id }
}

/** A completed receipt into the warehouse. `supplier: false` leaves it naming nobody. */
async function receipt(w: World, quantity: number, opts: { supplier?: boolean; notes?: string } = {}) {
  const { stockMovement } = await w.api.post('/warehouse/movement', {
    type: 'receipt', date: today(), toWarehouseId: w.warehouse._id, ...(opts.notes ? { notes: opts.notes } : {}),
    ...(opts.supplier === false ? {} : { contactId: w.supplier._id }),
    lines: [{ productId: w.article._id, quantity, unitCost: 2.5, totalCost: quantity * 2.5 }], totalAmount: quantity * 2.5,
  })
  const id = stockMovement._id || stockMovement.id
  const confirmed = await w.api.post(`/warehouse/movement/${id}/confirm`)
  expect(confirmed.stockMovement?.status).toBe('completed')
  return { id: String(id), number: stockMovement.movementNumber as string }
}

/** A supplier bill typed by hand, not received. */
async function typedBill(w: World, quantity: number, reference: string) {
  const subtotal = quantity * 2.75
  const { invoice } = await w.api.post('/invoices', {
    type: 'invoice', direction: 'incoming', contactId: w.supplier._id, issueDate: today(), dueDate: today(), currency: 'EUR', reference,
    lines: [{ productId: w.article._id, warehouseId: w.warehouse._id, description: w.article.name, quantity, unit: 'pcs', unitPrice: 2.75, taxRate: 20 }],
    subtotal, total: +(subtotal * 1.2).toFixed(2),
  })
  return { id: String(invoice.id || invoice._id), number: invoice.invoiceNumber as string }
}

const stockOf = async (w: World) => {
  const { stockLevels } = await w.api.get(`/warehouse/stock-level?productId=${w.article._id}&warehouseId=${w.warehouse._id}&size=5`)
  return stockLevels?.[0]?.quantity ?? 0
}
const movementsOf = async (w: World) => (await w.api.get(`/warehouse/movement?productId=${w.article._id}&size=50`)).total as number
const billOf = async (w: World, id: string) => (await w.api.get(`/invoices/${id}`)).invoice
const movementOf = async (w: World, id: string) => (await w.api.get(`/warehouse/movement/${id}`)).stockMovement

const actions = (page: Page) => page.locator('.form-actions-bar')
/** The price field of a bill's first line, in the column of that name. */
async function linePrice(page: Page) {
  const heads = await page.locator('.line-table thead th').allInnerTexts()
  const at = heads.findIndex(h => h.trim() === 'Единична цена')
  expect(at).toBeGreaterThan(0)
  return page.locator('.line-table tbody tr').first().locator('td').nth(at).locator('input[type="number"]')
}
const snackbar = (page: Page) => page.locator('.v-snackbar .v-snackbar__content')

test.describe('a receipt with no supplier (FR-22.31a)', () => {
  test('through „Входяща фактура" and the supplier question to a received bill: stock unchanged, linked both ways', async ({ page }) => {
    const w = await world('nosup')
    const r = await receipt(w, 7, { supplier: false })
    const stock = await stockOf(w)
    const movements = await movementsOf(w)
    expect(stock).toBe(7)

    await signInForUx(page)
    const billRequests: string[] = []
    page.on('request', (r) => {
      if (r.method() === 'POST' && r.url().endsWith('/invoicing/bills/from-receipt')) billRequests.push(r.postData() || '')
    })
    await page.goto(`/inventory/movements/${r.id}`, { waitUntil: 'networkidle' })
    await expect(page.getByTestId('receipt-not-billable')).toHaveCount(0)
    await actions(page).getByRole('button', { name: 'Входяща фактура' }).click()

    // The question comes first, and nothing is made until it is answered.
    const dialog = page.getByTestId('bill-supplier-dialog')
    await expect(dialog).toBeVisible()
    await expect(dialog).toContainText('не посочва доставчик')
    await expect(dialog.getByTestId('bill-supplier-confirm')).toBeDisabled()
    expect(billRequests, 'nothing is asked of the server until the question is answered').toEqual([])

    await openSelect(dialog, /Доставчик/)
    await page.getByRole('option').filter({ hasText: w.supplier.companyName }).first().click()
    await dialog.getByTestId('bill-supplier-confirm').click()

    await page.waitForURL(/\/invoicing\/bills\/[0-9a-f]{24}\/edit/)
    const billId = page.url().match(/\/bills\/([0-9a-f]{24})\/edit/)![1]
    expect(billRequests).toHaveLength(1)
    const banner = page.getByTestId('bill-receipts')
    await expect(banner).toContainText(r.number)

    await page.getByLabel('Покупна фактура №').fill(`NS-${w.stamp}`)
    await actions(page).getByRole('button', { name: 'Запази и получи' }).click()
    await expect(snackbar(page)).toContainText('стоката е заприходена с разписката')

    const bill = await billOf(w, billId)
    expect(bill.status).toBe('received')
    expect(bill.contactId?._id ?? bill.contactId).toBe(w.supplier._id)
    expect(bill.lines.map((l: any) => [l.productId, l.quantity, l.unitPrice])).toEqual([[w.article._id, 7, 2.5]])
    expect(await stockOf(w)).toBe(stock)
    expect(await movementsOf(w)).toBe(movements)

    // Links both ways, and the receipt names the supplier now.
    const after = await movementOf(w, r.id)
    expect(after.contactId).toBe(w.supplier._id)
    expect(after.bill.id).toBe(billId)
    await page.goto(`/inventory/movements/${r.id}`, { waitUntil: 'networkidle' })
    await expect(page.getByTestId('receipt-bill-link')).toHaveText(bill.invoiceNumber)
    await expect(actions(page).getByRole('button', { name: 'Входяща фактура' })).toHaveCount(0)
  })

  test('„Свържи с доставка" lists it after the supplier\'s own, marked, and linking gives it the bill\'s supplier', async ({ page }) => {
    const w = await world('list')
    const own = await receipt(w, 2)
    const anonymous = await receipt(w, 3, { supplier: false })
    const { invoice } = await w.api.post('/invoices', {
      type: 'invoice', direction: 'incoming', contactId: w.supplier._id, issueDate: today(), dueDate: today(), currency: 'EUR',
      lines: [], subtotal: 0, total: 0,
    })
    const billId = invoice.id || invoice._id

    await signInForUx(page)
    await page.goto(`/invoicing/bills/${billId}/edit`, { waitUntil: 'networkidle' })
    await page.getByTestId('link-delivery-btn').click()
    const dialog = page.getByTestId('link-delivery-dialog')
    const row = (number: string) => dialog.locator('.v-list-item').filter({ hasText: number })
    await expect(row(own.number)).toBeVisible()
    await expect(row(anonymous.number).getByTestId('receipt-no-supplier')).toHaveText('без доставчик')
    await expect(row(own.number).getByTestId('receipt-no-supplier')).toHaveCount(0)

    const numbers = await dialog.locator('.v-list-item-title').allInnerTexts()
    const at = (n: string) => numbers.findIndex(t => t.includes(n))
    expect(at(own.number)).toBeLessThan(at(anonymous.number))

    await row(anonymous.number).locator('input[type="checkbox"]').check()
    await page.getByTestId('link-delivery-confirm').click()
    await expect(page.getByTestId('bill-receipts')).toContainText(anonymous.number)
    // No prices were typed on this bill, so there are none to read again.
    await expect(snackbar(page)).toContainText('свързана с доставката')
    await expect(snackbar(page)).not.toContainText('Прегледайте цените')
    expect((await movementOf(w, anonymous.id)).contactId).toBe(w.supplier._id)
  })

  test('a day\'s aggregate or a correction says why too, and offers no bill', async ({ page }) => {
    const w = await world('aggregate')
    const r = await receipt(w, 4, { supplier: false, notes: deliveryNote(today(), movementMarker('store_operations', today())) })

    await signInForUx(page)
    await page.goto(`/inventory/movements/${r.id}`, { waitUntil: 'networkidle' })
    await expect(page.getByTestId('receipt-not-billable')).toContainText('сбор за деня')
    await expect(actions(page).getByRole('button', { name: 'Входяща фактура' })).toHaveCount(0)
  })

  test('„Свържи с доставка": the one naming the supplier is ticked beside any that name nobody, whose notes show', async ({ page }) => {
    const w = await world('tick')
    await ownSupplier(w)
    const own = await receipt(w, 2)
    const stray = await receipt(w, 3, { supplier: false, notes: deliveryNote(today(), movementMarker('goods_receipt', w.stamp), `ДРУГ ОБЕКТ ${w.stamp}`) })
    const { invoice } = await w.api.post('/invoices', {
      type: 'invoice', direction: 'incoming', contactId: w.supplier._id, issueDate: today(), dueDate: today(), currency: 'EUR', lines: [], subtotal: 0, total: 0,
    })

    await signInForUx(page)
    await page.goto(`/invoicing/bills/${invoice.id || invoice._id}/edit`, { waitUntil: 'networkidle' })
    await page.getByTestId('link-delivery-btn').click()
    const dialog = page.getByTestId('link-delivery-dialog')
    const row = (number: string) => dialog.locator('.v-list-item').filter({ hasText: number })
    await expect(row(own.number).locator('input[type="checkbox"]')).toBeChecked()
    await expect(row(stray.number).locator('input[type="checkbox"]')).not.toBeChecked()
    await expect(row(stray.number).getByTestId('receipt-notes')).toContainText(`ДРУГ ОБЕКТ ${w.stamp}`)
    await expect(row(own.number).getByTestId('receipt-notes')).toHaveCount(0)
    await expect(page.getByTestId('link-delivery-confirm')).toBeEnabled()
  })

  test('„Свържи с доставка": one that names nobody is never ticked for the person, even alone', async ({ page }) => {
    const w = await world('alone')
    await ownSupplier(w)
    const stray = await receipt(w, 3, { supplier: false })
    const { invoice } = await w.api.post('/invoices', {
      type: 'invoice', direction: 'incoming', contactId: w.supplier._id, issueDate: today(), dueDate: today(), currency: 'EUR', lines: [], subtotal: 0, total: 0,
    })

    await signInForUx(page)
    await page.goto(`/invoicing/bills/${invoice.id || invoice._id}/edit`, { waitUntil: 'networkidle' })
    await page.getByTestId('link-delivery-btn').click()
    const dialog = page.getByTestId('link-delivery-dialog')
    const row = dialog.locator('.v-list-item').filter({ hasText: stray.number })
    await expect(row.locator('input[type="checkbox"]')).not.toBeChecked()
    await expect(page.getByTestId('link-delivery-confirm')).toBeDisabled()
  })

  test('a receipt that cannot be billed says why', async ({ page }) => {
    const w = await world('why')
    const bill = await typedBill(w, 2, `WHY-${w.stamp}`)
    await w.api.post(`/invoices/${bill.id}/receive`)
    const { stockMovements } = await w.api.get(`/warehouse/movement?productId=${w.article._id}&type=receipt&size=5`)
    const own = stockMovements[0]
    await w.api.post(`/invoices/${bill.id}/void`)
    const voided = await billOf(w, bill.id)

    await signInForUx(page)
    await page.goto(`/inventory/movements/${own._id}`, { waitUntil: 'networkidle' })
    await expect(page.getByTestId('receipt-not-billable')).toContainText(voided.invoiceNumber)
    await expect(page.getByTestId('receipt-not-billable')).toContainText('не се фактурира')
    await expect(actions(page).getByRole('button', { name: 'Входяща фактура' })).toHaveCount(0)
  })
})

test.describe('a typed bill takes a delivery (FR-22.32a)', () => {
  test('it says the lines go, keeps the bill\'s own number and dates, and then moves no stock', async ({ page }) => {
    const w = await world('typed')
    const r = await receipt(w, 5)
    const bill = await typedBill(w, 5, `T-${w.stamp}`)
    const before = await billOf(w, bill.id)
    const stock = await stockOf(w)
    const movements = await movementsOf(w)

    await signInForUx(page)
    await page.goto(`/invoicing/bills/${bill.id}/edit`, { waitUntil: 'networkidle' })
    await page.getByTestId('link-delivery-btn').click()
    const dialog = page.getByTestId('link-delivery-dialog')
    await expect(dialog.getByTestId('replace-lines-warning')).toContainText('ще бъдат заменени с редовете на доставката')
    await expect(dialog.getByTestId('replace-lines-warning')).toContainText('цената му')
    await expect(dialog.getByTestId('replace-lines-warning')).toContainText('на цените от разписката')
    await expect(dialog.getByTestId('replace-lines-warning')).toContainText('Номерът, датите и начинът на плащане остават')
    await expect(page.getByTestId('link-delivery-confirm')).toHaveText(/Замени редовете и свържи/)
    // However long the list runs, what linking does stays in view beside its button.
    await expect(dialog.getByTestId('replace-lines-warning')).toBeInViewport()
    await expect(page.getByTestId('link-delivery-confirm')).toBeInViewport()
    await dialog.locator('.v-list-item').filter({ hasText: r.number }).locator('input[type="checkbox"]').check()
    await page.getByTestId('link-delivery-confirm').click()

    await expect(page.getByTestId('bill-receipts')).toContainText(r.number)
    await expect(snackbar(page)).toContainText('Прегледайте цените')
    const linked = await billOf(w, bill.id)
    expect(linked.lines.map((l: any) => [l.quantity, l.unitPrice])).toEqual([[5, 2.5]])
    expect([linked.invoiceNumber, linked.reference, linked.issueDate, linked.dueDate]).toEqual([before.invoiceNumber, before.reference, before.issueDate, before.dueDate])
    expect(linked.status).toBe('draft')

    await actions(page).getByRole('button', { name: 'Запази и получи' }).click()
    await expect(snackbar(page)).toContainText('стоката е заприходена с разписката')
    expect((await billOf(w, bill.id)).status).toBe('received')
    expect(await stockOf(w)).toBe(stock)
    expect(await movementsOf(w)).toBe(movements)
  })
})

test.describe('linking from a form with unsaved edits (FR-22.32a)', () => {
  test('saves what the bill says about itself, and leaves the product master alone', async ({ page }) => {
    const w = await world('dirty')
    const r = await receipt(w, 5)
    const bill = await typedBill(w, 5, `D-${w.stamp}`)
    const article = async () => (await w.api.get(`/warehouse/product/${w.article._id}`)).product
    const before = await article()

    await signInForUx(page)
    const puts: any[] = []
    page.on('request', (q) => {
      if (q.method() === 'PUT' && q.url().endsWith(`/invoices/${bill.id}`)) puts.push(q.postDataJSON())
    })
    await page.goto(`/invoicing/bills/${bill.id}/edit`, { waitUntil: 'networkidle' })
    // A price typed on the line: the switch is on, so it stages the article's new purchase price.
    const price = await linePrice(page)
    await price.fill('9.75')
    await price.blur()
    await page.getByLabel('Покупна фактура №').fill(`D2-${w.stamp}`)

    await page.getByTestId('link-delivery-btn').click()
    const dialog = page.getByTestId('link-delivery-dialog')
    await dialog.locator('.v-list-item').filter({ hasText: r.number }).locator('input[type="checkbox"]').check()
    await page.getByTestId('link-delivery-confirm').click()
    await expect(page.getByTestId('bill-receipts')).toContainText(r.number)

    // The save happened, and carried the form's header, and nothing for the product.
    expect(puts).toHaveLength(1)
    expect(puts[0].productUpdates).toBeUndefined()
    expect((await billOf(w, bill.id)).reference).toBe(`D2-${w.stamp}`)
    const after = await article()
    expect(after.purchasePrice).toBe(before.purchasePrice)
    expect(after.priceTiers).toEqual(before.priceTiers)
  })
})

test.describe('a bill in another currency (FR-22.32a)', () => {
  test('is not linked: the form says why in Bulgarian, and the bill keeps its lines', async ({ page }) => {
    const w = await world('usd')
    const r = await receipt(w, 2)
    const { invoice } = await w.api.post('/invoices', {
      type: 'invoice', direction: 'incoming', contactId: w.supplier._id, issueDate: today(), dueDate: today(), currency: 'USD', exchangeRate: 0.9, reference: `U-${w.stamp}`,
      lines: [{ productId: w.article._id, warehouseId: w.warehouse._id, description: w.article.name, quantity: 2, unit: 'pcs', unitPrice: 3, taxRate: 20 }],
      subtotal: 6, total: 7.2,
    })
    const id = String(invoice.id || invoice._id)

    await signInForUx(page)
    await page.goto(`/invoicing/bills/${id}/edit`, { waitUntil: 'networkidle' })
    await page.getByTestId('link-delivery-btn').click()
    const dialog = page.getByTestId('link-delivery-dialog')
    await dialog.locator('.v-list-item').filter({ hasText: r.number }).locator('input[type="checkbox"]').check()
    await page.getByTestId('link-delivery-confirm').click()

    await expect(snackbar(page)).toContainText('фактура в друга валута не се свързва')
    const bill = await billOf(w, id)
    expect(bill.lines.map((l: any) => l.unitPrice)).toEqual([3])
    expect(bill.stockSource?.marker).toBeFalsy()
    expect((await movementOf(w, r.id)).billable).toBe(true)
  })
})

test.describe('a bill the form cannot save (FR-22.32a)', () => {
  test('linking stops, and the dialog does not cover why', async ({ page }) => {
    const w = await world('invalid')
    const r = await receipt(w, 2)
    const bill = await typedBill(w, 2, `I-${w.stamp}`)

    await signInForUx(page)
    await page.goto(`/invoicing/bills/${bill.id}/edit`, { waitUntil: 'networkidle' })
    await page.getByLabel('Покупна фактура №').fill('')
    await page.getByTestId('link-delivery-btn').click()
    const dialog = page.getByTestId('link-delivery-dialog')
    await dialog.locator('.v-list-item').filter({ hasText: r.number }).locator('input[type="checkbox"]').check()
    await page.getByTestId('link-delivery-confirm').click()

    await expect(dialog).toHaveCount(0)
    await expect(page.getByLabel('Покупна фактура №')).toBeVisible()
    expect((await movementOf(w, r.id)).billable).toBe(true)
    expect((await billOf(w, bill.id)).stockSource?.marker).toBeFalsy()
  })
})

test.describe('receiving warns before it double-books (FR-22.31c)', () => {
  test('from the form: „Запази и получи" shows the receipts, and links the bill to the delivery', async ({ page }) => {
    const w = await world('form')
    const r = await receipt(w, 4)
    const bill = await typedBill(w, 4, `F-${w.stamp}`)
    const stock = await stockOf(w)
    const movements = await movementsOf(w)

    await signInForUx(page)
    await page.goto(`/invoicing/bills/${bill.id}/edit`, { waitUntil: 'networkidle' })
    await actions(page).getByRole('button', { name: 'Запази и получи' }).click()

    const dialog = page.getByTestId('receipt-overlap-dialog')
    await expect(dialog).toContainText('Тази стока може вече да е в склада')
    await expect(dialog.getByTestId('receipt-overlap-row')).toContainText(r.number)
    await expect(dialog.getByTestId('replace-lines-warning')).toContainText('ще бъдат заменени')
    expect((await billOf(w, bill.id)).status).toBe('draft')
    expect(await stockOf(w)).toBe(stock)

    await dialog.getByTestId('receipt-overlap-link').click()
    await expect(dialog).toHaveCount(0)
    await expect(page.getByTestId('bill-receipts')).toContainText(r.number)
    await expect(snackbar(page)).toContainText('Прегледайте цените')
    expect((await billOf(w, bill.id)).status).toBe('draft')

    await actions(page).getByRole('button', { name: 'Запази и получи' }).click()
    await expect(snackbar(page)).toContainText('стоката е заприходена с разписката')
    expect(await stockOf(w)).toBe(stock)
    expect(await movementsOf(w)).toBe(movements)
    expect((await movementOf(w, r.id)).bill.id).toBe(bill.id)
  })

  test('from the form: „Получи въпреки това" books it, as the user said', async ({ page }) => {
    const w = await world('anyway')
    await receipt(w, 4)
    const bill = await typedBill(w, 4, `A-${w.stamp}`)
    const stock = await stockOf(w)

    await signInForUx(page)
    await page.goto(`/invoicing/bills/${bill.id}/edit`, { waitUntil: 'networkidle' })
    await actions(page).getByRole('button', { name: 'Запази и получи' }).click()
    const dialog = page.getByTestId('receipt-overlap-dialog')
    await dialog.getByTestId('receipt-overlap-receive').click()
    await expect(dialog).toHaveCount(0)
    await expect(snackbar(page)).toContainText('Фактурата е получена')
    await expect(page.locator('.doc-banner-meta .v-chip')).toHaveText('Получена')
    expect((await billOf(w, bill.id)).status).toBe('received')
    expect(await stockOf(w)).toBe(stock + 4)
  })

  test('from the list: the Receive icon shows the receipts, and linking opens the bill to review', async ({ page }) => {
    const w = await world('list-link')
    const r = await receipt(w, 6, { supplier: false })
    const bill = await typedBill(w, 6, `L-${w.stamp}`)
    const stock = await stockOf(w)

    await signInForUx(page)
    await page.goto(`/invoicing/bills?q=${encodeURIComponent(`L-${w.stamp}`)}`, { waitUntil: 'networkidle' })
    const row = rowOf(page, bill.number)
    await (await rowAction(row, 'receive')).click()

    const dialog = page.getByTestId('receipt-overlap-dialog')
    await expect(dialog.getByTestId('receipt-overlap-row')).toContainText(r.number)
    await expect(dialog.getByTestId('receipt-no-supplier')).toHaveText('без доставчик')
    expect((await billOf(w, bill.id)).status).toBe('draft')

    // Nothing is ticked for the person: it names nobody, so choosing it is theirs.
    await expect(dialog.getByTestId('receipt-overlap-link')).toBeDisabled()
    await dialog.getByTestId('receipt-overlap-row').locator('input[type="checkbox"]').check()
    await dialog.getByTestId('receipt-overlap-link').click()
    await page.waitForURL(new RegExp(`/invoicing/bills/${bill.id}/edit`))
    await expect(page.getByTestId('bill-receipts')).toContainText(r.number)
    expect((await movementOf(w, r.id)).contactId).toBe(w.supplier._id)
    expect(await stockOf(w)).toBe(stock)
  })

  test('from the list: „Получи въпреки това" books it and the row says so', async ({ page }) => {
    const w = await world('list-any')
    await receipt(w, 3)
    const bill = await typedBill(w, 3, `LA-${w.stamp}`)
    const stock = await stockOf(w)

    await signInForUx(page)
    await page.goto(`/invoicing/bills?q=${encodeURIComponent(`LA-${w.stamp}`)}`, { waitUntil: 'networkidle' })
    await (await rowAction(rowOf(page, bill.number), 'receive')).click()
    const dialog = page.getByTestId('receipt-overlap-dialog')
    await dialog.getByTestId('receipt-overlap-receive').click()
    await expect(dialog).toHaveCount(0)
    await expect(snackbar(page)).toContainText('Фактурата е получена')
    await expect.poll(async () => (await billOf(w, bill.id)).status).toBe('received')
    expect(await stockOf(w)).toBe(stock + 3)
  })

  test('the question ticks the one naming the supplier beside any that name nobody, whose notes show', async ({ page }) => {
    const w = await world('q-tick')
    const own = await receipt(w, 5)
    const stray = await receipt(w, 5, { supplier: false, notes: deliveryNote(today(), movementMarker('goods_receipt', w.stamp), `ДРУГ ОБЕКТ ${w.stamp}`) })
    const bill = await typedBill(w, 5, `QT-${w.stamp}`)

    await signInForUx(page)
    await page.goto(`/invoicing/bills/${bill.id}/edit`, { waitUntil: 'networkidle' })
    await actions(page).getByRole('button', { name: 'Запази и получи' }).click()
    const dialog = page.getByTestId('receipt-overlap-dialog')
    const row = (number: string) => dialog.getByTestId('receipt-overlap-row').filter({ hasText: number })
    await expect(row(own.number).locator('input[type="checkbox"]')).toBeChecked()
    await expect(row(stray.number).locator('input[type="checkbox"]')).not.toBeChecked()
    await expect(row(stray.number).getByTestId('receipt-notes')).toContainText(`ДРУГ ОБЕКТ ${w.stamp}`)
    await expect(row(own.number).getByTestId('receipt-notes')).toHaveCount(0)
  })

  /** Hold every Receive of this bill until told, and count them. */
  async function holdReceives(page: Page, billId: string) {
    const posts: unknown[] = []
    let release = () => {}
    const released = new Promise<void>((resolve) => { release = resolve })
    await page.route(`**/invoices/${billId}/receive`, async (route) => {
      posts.push(route.request().postDataJSON())
      await released
      await route.continue()
    })
    return { posts, release }
  }

  test('Enter pressed twice on „Запази и получи" receives once', async ({ page }) => {
    const w = await world('enter')
    const bill = await typedBill(w, 2, `EN-${w.stamp}`)

    await signInForUx(page)
    await page.goto(`/invoicing/bills/${bill.id}/edit`, { waitUntil: 'networkidle' })
    const held = await holdReceives(page, bill.id)
    const button = actions(page).getByRole('button', { name: 'Запази и получи' })
    await button.focus()
    await page.keyboard.press('Enter')
    await page.keyboard.press('Enter')
    await expect.poll(() => held.posts.length).toBeGreaterThan(0)
    await page.waitForTimeout(500)
    expect(held.posts).toHaveLength(1)

    held.release()
    await expect(snackbar(page)).toContainText('Фактурата е получена')
    expect(await stockOf(w)).toBe(2)
  })

  test('the menu of a list row reopened while Receive is on its way does not send it again', async ({ page }) => {
    const w = await world('reopen')
    const bill = await typedBill(w, 2, `RO-${w.stamp}`)

    await signInForUx(page)
    await page.goto(`/invoicing/bills?q=${encodeURIComponent(`RO-${w.stamp}`)}`, { waitUntil: 'networkidle' })
    const held = await holdReceives(page, bill.id)
    const row = rowOf(page, bill.number)
    await (await rowAction(row, 'receive')).click()
    await expect.poll(() => held.posts.length).toBe(1)
    await (await rowAction(row, 'receive')).click()
    await page.waitForTimeout(300)
    expect(held.posts).toHaveLength(1)

    held.release()
    await expect(snackbar(page)).toContainText('Фактурата е получена')
    await expect(snackbar(page)).not.toContainText('чернова')
    expect(await stockOf(w)).toBe(2)
  })

  test('Enter pressed twice on „Получи въпреки това" receives once', async ({ page }) => {
    const w = await world('enter-any')
    await receipt(w, 3)
    const bill = await typedBill(w, 3, `EA-${w.stamp}`)
    const stock = await stockOf(w)

    await signInForUx(page)
    await page.goto(`/invoicing/bills/${bill.id}/edit`, { waitUntil: 'networkidle' })
    await actions(page).getByRole('button', { name: 'Запази и получи' }).click()
    const dialog = page.getByTestId('receipt-overlap-dialog')
    await expect(dialog).toBeVisible()

    const held = await holdReceives(page, bill.id)
    await dialog.getByTestId('receipt-overlap-receive').focus()
    await page.keyboard.press('Enter')
    await expect.poll(() => held.posts.length).toBe(1)
    await page.keyboard.press('Enter')
    await page.keyboard.press('Enter')
    await page.waitForTimeout(300)
    expect(held.posts).toEqual([{ acknowledgeOverlap: true }])

    held.release()
    await expect(snackbar(page)).toContainText('Фактурата е получена')
    expect(await stockOf(w)).toBe(stock + 3)
  })

  test('a bill with nothing to overlap receives without a question', async ({ page }) => {
    const w = await world('quiet')
    const bill = await typedBill(w, 2, `Q-${w.stamp}`)

    await signInForUx(page)
    await page.goto(`/invoicing/bills/${bill.id}/edit`, { waitUntil: 'networkidle' })
    await actions(page).getByRole('button', { name: 'Запази и получи' }).click()
    await expect(snackbar(page)).toContainText('Фактурата е получена')
    await expect(page.getByTestId('receipt-overlap-dialog')).toHaveCount(0)
    expect(await stockOf(w)).toBe(2)
  })
})

test.describe('a bill that cannot book its goods stays a draft', () => {
  test('„Склад" cleared on the form: refused in Bulgarian, no number drawn, and it receives once one is chosen', async ({ page }) => {
    const w = await world('nowh')
    const bill = await typedBill(w, 2, `NW-${w.stamp}`)

    await signInForUx(page)
    await page.goto(`/invoicing/bills/${bill.id}/edit`, { waitUntil: 'networkidle' })
    const field = page.locator('.v-autocomplete').filter({ hasText: 'Склад' }).first()
    await field.locator('.v-field').hover()
    await field.locator('.v-field__clearable .v-icon').click()
    await actions(page).getByRole('button', { name: 'Запази и получи' }).click()

    await expect(snackbar(page)).toContainText('не посочват склад')
    const refused = await billOf(w, bill.id)
    expect([refused.status, refused.invoiceNumber]).toEqual(['draft', bill.number])
    expect(await stockOf(w)).toBe(0)
    await expect(page.locator('.doc-banner-meta .v-chip')).toHaveText('Чернова')

    await field.locator('input').click()
    await page.getByRole('option', { name: w.warehouse.name, exact: true }).click()
    await actions(page).getByRole('button', { name: 'Запази и получи' }).click()
    await expect(snackbar(page)).toContainText('Фактурата е получена')
    expect(await stockOf(w)).toBe(2)
  })

  test('from the list: refused in Bulgarian, and the row is still a draft', async ({ page }) => {
    const w = await world('nowh-list')
    const { invoice } = await w.api.post('/invoices', {
      type: 'invoice', direction: 'incoming', contactId: w.supplier._id, issueDate: today(), dueDate: today(), currency: 'EUR', reference: `NL-${w.stamp}`,
      lines: [{ productId: w.article._id, description: w.article.name, quantity: 2, unit: 'pcs', unitPrice: 2.75, taxRate: 20 }],
      subtotal: 5.5, total: 6.6,
    })

    await signInForUx(page)
    await page.goto(`/invoicing/bills?q=${encodeURIComponent(`NL-${w.stamp}`)}`, { waitUntil: 'networkidle' })
    await (await rowAction(rowOf(page, invoice.invoiceNumber), 'receive')).click()
    await expect(snackbar(page)).toContainText('не посочват склад')
    expect((await billOf(w, String(invoice.id || invoice._id))).status).toBe('draft')
  })
})

test.describe('a movement\'s warehouses fit its type (#168)', () => {
  const fromField = (page: Page) => page.getByTestId('from-warehouse')
  const toField = (page: Page) => page.getByTestId('to-warehouse')
  const pickType = async (page: Page, name: string) => {
    await openSelect(page, /^Тип/)
    await page.getByRole('option', { name, exact: true }).click()
  }

  test('a new dispatch cannot keep the receipt\'s To warehouse, and takes stock out', async ({ page }) => {
    const w = await world('disp')
    await receipt(w, 10)

    await signInForUx(page)
    await page.goto('/inventory/movements/new', { waitUntil: 'networkidle' })
    // A receipt starts with the org's warehouse as To, and offers no From.
    await expect(toField(page)).toBeVisible()
    await expect(toField(page)).toContainText(w.warehouse.name)
    await expect(fromField(page)).toHaveCount(0)

    await pickType(page, 'Експедиция')
    await expect(toField(page)).toHaveCount(0)
    await expect(fromField(page)).toBeVisible()
    await expect(fromField(page).locator('.v-select__selection')).toHaveCount(0)

    await openSelect(page, /От склад/)
    await page.getByRole('option', { name: w.warehouse.name, exact: true }).click()

    const line = page.locator('tbody tr').first()
    await line.getByPlaceholder('Търсете продукти...').pressSequentially(w.article.sku, { delay: 10 })
    await page.locator('.v-overlay--active .v-list-item').filter({ hasText: w.article.sku }).first().click()
    const quantity = line.locator('input[type="number"]').first()
    await expect.poll(async () => Number(await quantity.inputValue())).toBeGreaterThan(0)
    await quantity.fill('3')

    const saved = page.waitForResponse(r => r.request().method() === 'POST' && r.url().includes('/confirm'))
    await actions(page).getByRole('button', { name: 'Запази и потвърди' }).click()
    expect((await saved).status()).toBe(200)
    await expect(snackbar(page)).toBeVisible()
    await expect.poll(() => stockOf(w)).toBe(7)
  })

  /** The article on the first line, the quantity typed over what picking it prefills. */
  const fillLine = async (page: Page, w: World, quantity: number, prefilled: boolean) => {
    const line = page.locator('tbody tr').first()
    await line.getByPlaceholder('Търсете продукти...').pressSequentially(w.article.sku, { delay: 10 })
    await page.locator('.v-overlay--active .v-list-item').filter({ hasText: w.article.sku }).first().click()
    const field = line.locator('input[type="number"]').first()
    if (prefilled) await expect.poll(async () => Number(await field.inputValue())).toBeGreaterThan(0)
    await field.fill(String(quantity))
  }
  const choose = async (page: Page, label: RegExp, name: string) => {
    await openSelect(page, label)
    await page.getByRole('option', { name, exact: true }).click()
  }
  const otherWarehouse = async (w: World) => (await w.api.get('/warehouse/warehouse?size=100')).warehouses.find((x: any) => x._id !== w.warehouse._id)
  const stockIn = async (w: World, warehouseId: string) => {
    const { stockLevels } = await w.api.get(`/warehouse/stock-level?productId=${w.article._id}&warehouseId=${warehouseId}&size=5`)
    return stockLevels?.[0]?.quantity ?? 0
  }

  test('a write-off typed in the form takes goods out, and its count says so', async ({ page }) => {
    const w = await world('writeoff')
    await receipt(w, 10)

    await signInForUx(page)
    await page.goto('/inventory/movements/new', { waitUntil: 'networkidle' })
    await expect(toField(page)).toContainText(w.warehouse.name)

    await pickType(page, 'Корекция')
    // The form's guess went with the receipt: nothing here adds stock unless the person says so.
    await expect(toField(page).locator('.v-select__selection')).toHaveCount(0)
    await expect(fromField(page).locator('.v-select__selection')).toHaveCount(0)

    await choose(page, /От склад/, w.warehouse.name)
    await fillLine(page, w, 4, true)
    const confirmed = page.waitForResponse(r => r.request().method() === 'POST' && r.url().includes('/confirm'))
    await actions(page).getByRole('button', { name: 'Запази и потвърди' }).click()
    expect((await confirmed).status()).toBe(200)
    await expect.poll(() => stockOf(w)).toBe(6)

    await page.waitForURL(/\/inventory\/movements\/[0-9a-f]{24}/)
    const movement = await movementOf(w, page.url().match(/movements\/([0-9a-f]{24})/)![1])
    expect([Boolean(movement.toWarehouseId), movement.fromWarehouseId]).toEqual([false, w.warehouse._id])
    const { inventoryCount } = await w.api.get(`/warehouse/inventory-count/${movement.inventoryCountId}`)
    expect(inventoryCount.lines.map((l: any) => l.variance)).toEqual([-4])
  })

  test('a transfer starts with neither warehouse, keeps both the person chooses, and moves the goods', async ({ page }) => {
    const w = await world('transfer')
    const other = await otherWarehouse(w)
    await receipt(w, 10)

    await signInForUx(page)
    await page.goto('/inventory/movements/new', { waitUntil: 'networkidle' })
    await pickType(page, 'Прехвърляне')
    await expect(toField(page).locator('.v-select__selection')).toHaveCount(0)
    await expect(fromField(page).locator('.v-select__selection')).toHaveCount(0)

    await choose(page, /От склад/, w.warehouse.name)
    await choose(page, /Към склад/, other.name)
    await expect(fromField(page)).toContainText(w.warehouse.name)
    await expect(toField(page)).toContainText(other.name)
    await fillLine(page, w, 3, true)
    const confirmed = page.waitForResponse(r => r.request().method() === 'POST' && r.url().includes('/confirm'))
    await actions(page).getByRole('button', { name: 'Запази и потвърди' }).click()
    expect((await confirmed).status()).toBe(200)
    await expect.poll(() => stockOf(w)).toBe(7)
    expect(await stockIn(w, other._id)).toBe(3)
  })

  test('back on a receipt it starts where a receipt starts, and a To the person chose stays through the types', async ({ page }) => {
    const w = await world('back')
    const other = await otherWarehouse(w)
    await signInForUx(page)
    await page.goto('/inventory/movements/new', { waitUntil: 'networkidle' })

    await pickType(page, 'Експедиция')
    await pickType(page, 'Заприходяване')
    await expect(toField(page)).toContainText(w.warehouse.name)
    await expect(fromField(page)).toHaveCount(0)
    await pickType(page, 'Прехвърляне')
    await pickType(page, 'Заприходяване')
    await expect(toField(page)).toContainText(w.warehouse.name)

    await choose(page, /Към склад/, other.name)
    await pickType(page, 'Прехвърляне')
    await expect(toField(page)).toContainText(other.name)
    await pickType(page, 'Корекция')
    await expect(toField(page)).toContainText(other.name)
  })

  test('a transfer naming only To and an adjustment naming both are refused in Bulgarian, with nothing moved', async ({ page }) => {
    const w = await world('misfit')
    const other = await otherWarehouse(w)
    await receipt(w, 10)

    await signInForUx(page)
    await page.goto('/inventory/movements/new', { waitUntil: 'networkidle' })
    await choose(page, /Към склад/, other.name)
    await pickType(page, 'Прехвърляне')
    await fillLine(page, w, 3, false)
    await actions(page).getByRole('button', { name: 'Запази и потвърди' }).click()
    await expect(snackbar(page)).toContainText('Прехвърлянето изважда стока от склад')
    expect(await stockIn(w, other._id)).toBe(0)

    await page.goto('/inventory/movements/new', { waitUntil: 'networkidle' })
    await pickType(page, 'Корекция')
    await choose(page, /От склад/, w.warehouse.name)
    await choose(page, /Към склад/, other.name)
    await fillLine(page, w, 3, true)
    await actions(page).getByRole('button', { name: 'Запази и потвърди' }).click()
    await expect(snackbar(page)).toContainText('Корекцията променя един склад')
    expect(await stockOf(w)).toBe(10)
    expect(await stockIn(w, other._id)).toBe(0)
  })

  test('the server refuses a dispatch naming To, and the screen says what to do in Bulgarian', async ({ page }) => {
    const w = await world('words')
    await receipt(w, 10)
    const body = {
      type: 'dispatch', date: today(), toWarehouseId: w.warehouse._id,
      lines: [{ productId: w.article._id, quantity: 4, unitCost: 2.5, totalCost: 10 }], totalAmount: 10,
    }
    const refused = await w.api.post('/warehouse/movement', body)
    expect(refused.code).toBe('dispatch_with_to_warehouse')
    expect(await stockOf(w)).toBe(10)

    // A draft the list could confirm, had it been saved before the rule. No door saves one now, so
    // the refusal is staged on the response the list reads.
    const { stockMovement } = await w.api.post('/warehouse/movement', { ...body, toWarehouseId: undefined, fromWarehouseId: w.warehouse._id })
    const id = stockMovement._id || stockMovement.id
    await signInForUx(page)
    await page.route(`**/warehouse/movement/${id}/confirm`, route => route.fulfill({
      status: 422, contentType: 'application/json',
      body: JSON.stringify({ code: 'dispatch_with_to_warehouse', message: refused.message }),
    }))
    await page.goto(`/inventory/movements/${id}`, { waitUntil: 'networkidle' })
    await actions(page).getByRole('button', { name: 'Запази и потвърди' }).click()
    await expect(snackbar(page)).toContainText('Експедицията изважда стока от склад')
    expect(await stockOf(w)).toBe(10)
  })

  test('a draft saved before the rule shows the wrong warehouse, and clearing it reaches the server', async ({ page }) => {
    const w = await world('repair')
    await receipt(w, 10)
    const { stockMovement } = await w.api.post('/warehouse/movement', {
      type: 'dispatch', date: today(), fromWarehouseId: w.warehouse._id,
      lines: [{ productId: w.article._id, quantity: 4, unitCost: 2.5, totalCost: 10 }], totalAmount: 10,
    })
    const id = stockMovement._id || stockMovement.id

    // What such a draft reads like. No door saves one any more, so the first read is staged.
    await signInForUx(page)
    let staged = false
    await page.route(`**/warehouse/movement/${id}`, async (route) => {
      if (staged || route.request().method() !== 'GET') return route.continue()
      staged = true
      const res = await route.fetch()
      const json = await res.json()
      json.stockMovement.toWarehouseId = w.warehouse._id
      await route.fulfill({ response: res, json })
    })
    await page.goto(`/inventory/movements/${id}`, { waitUntil: 'networkidle' })
    await expect(toField(page)).toContainText(w.warehouse.name)

    await toField(page).locator('.v-field').hover()
    await toField(page).locator('.v-field__clearable .v-icon').click()
    await expect(toField(page)).toHaveCount(0)

    const put = page.waitForRequest(r => r.method() === 'PUT' && r.url().endsWith(`/warehouse/movement/${id}`))
    await actions(page).getByRole('button', { name: 'Запази', exact: true }).click()
    const body = (await put).postDataJSON()
    expect(body.toWarehouseId).toBeNull()
    expect(body.fromWarehouseId).toBe(w.warehouse._id)
    await expect(snackbar(page)).toBeVisible()
  })

  test('a booked movement reads as it was booked, even with a warehouse its type no longer takes', async ({ page }) => {
    const w = await world('hist')
    await receipt(w, 10)
    const { stockMovement } = await w.api.post('/warehouse/movement', {
      type: 'dispatch', date: today(), fromWarehouseId: w.warehouse._id,
      lines: [{ productId: w.article._id, quantity: 1, unitCost: 2.5, totalCost: 2.5 }], totalAmount: 2.5,
    })
    const id = stockMovement._id || stockMovement.id
    await w.api.post(`/warehouse/movement/${id}/confirm`)

    // A booked dispatch naming To: nothing on the page may tidy that away while it loads.
    await signInForUx(page)
    await page.route(`**/warehouse/movement/${id}`, async (route) => {
      const res = await route.fetch()
      const json = await res.json()
      json.stockMovement.toWarehouseId = w.warehouse._id
      json.stockMovement.fromWarehouseId = null
      await route.fulfill({ response: res, json })
    })
    await page.goto(`/inventory/movements/${id}`, { waitUntil: 'networkidle' })
    await expect(toField(page)).toContainText(w.warehouse.name)
    await expect(toField(page).locator('input').first()).toBeDisabled()
  })
})
