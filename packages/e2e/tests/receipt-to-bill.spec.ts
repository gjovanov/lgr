import { test, expect, type Page } from '@playwright/test'
import { signInForUx, uxApi } from './helpers/ux-budget'
import { chooseOption, openSelect } from './helpers/vuetify'
import { rowAction, rowOf } from './helpers/row-actions'

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

/** A completed receipt into the warehouse. `supplier: false` leaves it naming nobody. */
async function receipt(w: World, quantity: number, opts: { supplier?: boolean } = {}) {
  const { stockMovement } = await w.api.post('/warehouse/movement', {
    type: 'receipt', date: today(), toWarehouseId: w.warehouse._id,
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
    expect((await movementOf(w, anonymous.id)).contactId).toBe(w.supplier._id)
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
    await expect(dialog.getByTestId('replace-lines-warning')).toContainText('ще бъде заменен с редовете на доставката')
    await expect(dialog.getByTestId('replace-lines-warning')).toContainText('Номерът, датите и начинът на плащане остават')
    await expect(page.getByTestId('link-delivery-confirm')).toHaveText(/Замени редовете и свържи/)
    // However long the list runs, what linking does stays in view beside its button.
    await expect(dialog.getByTestId('replace-lines-warning')).toBeInViewport()
    await expect(page.getByTestId('link-delivery-confirm')).toBeInViewport()
    await dialog.locator('.v-list-item').filter({ hasText: r.number }).locator('input[type="checkbox"]').check()
    await page.getByTestId('link-delivery-confirm').click()

    await expect(page.getByTestId('bill-receipts')).toContainText(r.number)
    await expect(snackbar(page)).toContainText('свързана с доставката')
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
    await expect(dialog.getByTestId('replace-lines-warning')).toContainText('ще бъде заменен')
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

  test('back on a receipt it starts where a receipt starts, and a transfer keeps both fields', async ({ page }) => {
    const w = await world('back')
    await signInForUx(page)
    await page.goto('/inventory/movements/new', { waitUntil: 'networkidle' })

    await pickType(page, 'Експедиция')
    await pickType(page, 'Заприходяване')
    await expect(toField(page)).toContainText(w.warehouse.name)
    await expect(fromField(page)).toHaveCount(0)

    await pickType(page, 'Прехвърляне')
    await expect(fromField(page)).toBeVisible()
    await expect(toField(page)).toContainText(w.warehouse.name)
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
