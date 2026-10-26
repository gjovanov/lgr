import { test, expect, type Page } from '@playwright/test'
import { loginForApp } from './helpers/login'

/**
 * FR-22 slice 4b — the client-order and supplier-order forms. A form nobody touched is never
 * „unsaved changes", however slowly it loads and whatever its reservations do meanwhile; a client
 * order opens its next line by itself and says which lines stock cannot cover; each hand-off lands
 * on the next document; and Cancel or Complete say what they release before they do it.
 */

const apiBase = process.env.BASE_URL || 'http://localhost:4001'

async function session() {
  const res = await fetch(`${apiBase}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ orgSlug: 'acme-corp', username: 'admin', password: 'test123' }),
  })
  const data = await res.json()
  const orgId = (data.org?.id || data.org?._id) as string
  const call = async (method: string, path: string, body?: any) => {
    const r = await fetch(`${apiBase}/api/org/${orgId}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${data.token}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    return r.json()
  }
  return { orgId, call }
}

type Api = Awaited<ReturnType<typeof session>>

/** A new article with `stock` units in the default warehouse, a client and a supplier. */
async function world(api: Api, stock = 0) {
  const ts = Date.now()
  const product = (await api.call('POST', '/warehouse/product', {
    sku: `E2E-ORD-${ts}`, name: `E2E Шайба ${ts}`, category: 'Test', type: 'goods', unit: 'pcs', sellingPrice: 3, purchasePrice: 1, taxRate: 20,
  })).product
  const productId = product.id || product._id
  const client = (await api.call('POST', '/invoicing/contact', { type: 'customer', companyName: `E2E Клиент ОФ ${ts}` })).contact
  const supplier = (await api.call('POST', '/invoicing/contact', { type: 'supplier', companyName: `E2E Доставчик ОФ ${ts}` })).contact
  const warehouses = (await api.call('GET', '/warehouse/warehouse?size=100')).warehouses || []
  const warehouse = warehouses.find((w: any) => w.isDefault) || warehouses[0]
  if (stock > 0) {
    const { stockMovement } = await api.call('POST', '/warehouse/movement', {
      type: 'receipt', date: new Date().toISOString(), toWarehouseId: warehouse._id,
      lines: [{ productId, quantity: stock, unitCost: 1, totalCost: stock }], totalAmount: stock,
    })
    await api.call('POST', `/warehouse/movement/${stockMovement._id || stockMovement.id}/confirm`, {})
  }
  return {
    ts, product, productId, warehouse,
    clientId: client.id || client._id, clientName: client.companyName,
    supplierId: supplier.id || supplier._id, supplierName: supplier.companyName,
  }
}

/** A confirmed client order for the article. */
async function clientOrder(api: Api, w: Awaited<ReturnType<typeof world>>, quantity: number) {
  const today = new Date().toISOString().slice(0, 10)
  const { internalOrder } = await api.call('POST', '/invoicing/internal-orders', {
    contactId: w.clientId, issueDate: today, requestedDeliveryDate: '2026-12-15',
    lines: [{ productId: w.productId, description: w.product.name, quantity, unit: 'pcs' }],
  })
  return (await api.call('POST', `/invoicing/internal-orders/${internalOrder._id}/confirm`)).internalOrder
}

/** Hold the first answer to `path` back by `ms`: a slow network, where the form's timer guesses wrong. */
async function slowFirst(page: Page, path: RegExp, ms: number) {
  let held = false
  await page.route(path, async (route) => {
    if (!held && route.request().method() === 'GET') {
      held = true
      await new Promise((r) => setTimeout(r, ms))
    }
    await route.continue()
  })
}

const leaveDialog = (page: Page) => page.locator('.v-overlay--active .v-card').filter({ hasText: 'You have unsaved changes' })

test.describe('An untouched order form is not „unsaved changes" (FR-22.13)', () => {
  test('a client order that loaded slowly and had reservations made on it', async ({ page }) => {
    const api = await session()
    const w = await world(api, 10)
    const ordi = await clientOrder(api, w, 3)

    await loginForApp(page)
    await slowFirst(page, new RegExp(`/invoicing/internal-orders/${ordi._id}$`), 1200)
    await page.goto(`/invoicing/internal-orders/${ordi._id}/edit`)
    await expect(page.locator('.form-paper-header').getByText(ordi.orderNumber)).toBeVisible({ timeout: 15000 })
    // A reservation action changes what the server derives for the line — not anything typed.
    await page.getByRole('button', { name: 'Reserve from stock' }).click()
    await expect(page.locator('tbody tr').filter({ hasText: w.product.name }).getByText('3/3')).toBeVisible()

    await page.getByTestId('form-back').click()
    await page.waitForURL(/\/invoicing\/internal-orders(\?|$)/)
    await expect(leaveDialog(page)).toHaveCount(0)
  })

  test('a supplier order that loaded slowly', async ({ page }) => {
    const api = await session()
    const w = await world(api)
    const { order } = await api.call('POST', '/invoicing/orders', {
      issueDate: new Date().toISOString().slice(0, 10), currency: 'EUR', tags: [],
      supplierGroups: [{ supplierId: w.supplierId, lines: [{ productId: w.productId, description: w.product.name, quantity: 4, unit: 'pcs', allocations: [{ warehouseId: w.warehouse._id, quantity: 4 }] }] }],
    })

    await loginForApp(page)
    await slowFirst(page, new RegExp(`/invoicing/orders/${order._id}$`), 1200)
    await page.goto(`/invoicing/orders/${order._id}/edit`)
    await expect(page.locator('.form-paper-header').getByText(order.orderNumber)).toBeVisible({ timeout: 15000 })
    // Opening a line's allocations is looking, not editing.
    await page.getByRole('button', { name: 'Allocations' }).first().click()

    await page.getByTestId('form-back').click()
    await page.waitForURL(/\/invoicing\/orders(\?|$)/)
    await expect(leaveDialog(page)).toHaveCount(0)
  })
})

test.describe('The client-order form (FR-22.43)', () => {
  test('an article on the last line opens the next one and leaves the cursor in its quantity', async ({ page }) => {
    const api = await session()
    const w = await world(api)
    await loginForApp(page)
    await page.goto('/invoicing/internal-orders/new', { waitUntil: 'networkidle' })
    const rows = page.locator('tbody tr').filter({ has: page.getByPlaceholder('Type to search products...') })
    await expect(rows).toHaveCount(1)
    await rows.first().getByPlaceholder('Type to search products...').pressSequentially(w.product.sku, { delay: 20 })
    await page.locator('.pld-overlay .pld-item').filter({ hasText: w.product.sku }).first().click()
    await expect(rows).toHaveCount(2)
    const quantity = rows.first().getByRole('spinbutton', { name: 'Qty' })
    await expect(quantity).toBeFocused()
    await expect(quantity).toHaveValue('1')
  })

  test('„Reserve from stock" names the lines stock cannot cover', async ({ page }) => {
    const api = await session()
    const w = await world(api, 2)
    const ordi = await clientOrder(api, w, 5)
    await loginForApp(page)
    await page.goto(`/invoicing/internal-orders/${ordi._id}/edit`, { waitUntil: 'networkidle' })
    await page.getByRole('button', { name: 'Reserve from stock' }).click()
    await expect(page.locator('.v-snackbar')).toContainText(`Reservations created: 1. Not enough free stock for: ${w.product.name} (3 short)`)
    // Nothing free any more: the line is still named, not „nothing to cover".
    await page.getByRole('button', { name: 'Reserve from stock' }).click()
    await expect(page.locator('.v-snackbar')).toContainText(`No free stock for: ${w.product.name} (3 short)`)
  })
})

test.describe('Generating a supplier order (FR-22.42)', () => {
  test('offers the supplier\'s draft, adds the line to it, and says where the goods go', async ({ page }) => {
    const api = await session()
    const w = await world(api)
    // The supplier already has a draft carrying the article: the cover dialog's supplier hint.
    const { order: draft } = await api.call('POST', '/invoicing/orders', {
      issueDate: new Date().toISOString().slice(0, 10), currency: 'EUR', tags: [],
      supplierGroups: [{ supplierId: w.supplierId, lines: [{ productId: w.productId, description: w.product.name, quantity: 2, unit: 'pcs', allocations: [] }] }],
    })
    const ordi = await clientOrder(api, w, 4)

    await loginForApp(page)
    await page.goto(`/invoicing/internal-orders/${ordi._id}/edit`, { waitUntil: 'networkidle' })
    await page.getByRole('button', { name: 'Generate outgoing order' }).click()
    const dialog = page.locator('.v-overlay--active .v-card').filter({ has: page.getByTestId('generate-target') })
    await expect(dialog).toBeVisible()
    const field = (name: string) => dialog.getByRole('combobox', { name }).locator('xpath=ancestor::div[contains(@class,"v-field")][1]')
    await expect(field('To warehouse')).toContainText(w.warehouse.name)
    await expect(dialog.getByTestId('generate-target')).toContainText(`Add to ${draft.orderNumber}`)
    await dialog.getByRole('button', { name: 'Add', exact: true }).click()
    await expect(page.locator('.v-snackbar')).toContainText(`Added to outgoing order ${draft.orderNumber}`)

    const after = (await api.call('GET', `/invoicing/orders/${draft._id}`)).order
    expect(after.supplierGroups[0].lines.map((l: any) => l.quantity)).toEqual([2, 4])
    expect(after.supplierGroups[0].lines[1].allocations.map((a: any) => [String(a.warehouseId), a.quantity])).toEqual([[String(w.warehouse._id), 4]])
  })
})

test.describe('A client order covered by a supplier order not sent yet (FR-22.44)', () => {
  test('reads „Ordered" on its header and its line, and „Reserved" once the supplier order goes out', async ({ page }) => {
    const api = await session()
    const w = await world(api)
    const ordi = await clientOrder(api, w, 4)
    const gen = await api.call('POST', `/invoicing/internal-orders/${ordi._id}/generate-external`, {
      lines: [{ internalOrderLineId: ordi.lines[0]._id, quantity: 4, supplierId: w.supplierId }],
    })
    expect(gen.order?.status).toBe('draft')

    await loginForApp(page)
    await page.goto(`/invoicing/internal-orders/${ordi._id}/edit`, { waitUntil: 'networkidle' })
    const header = page.locator('.form-paper-header .v-chip').last()
    await expect(header).toHaveText('Ordered')
    await expect(page.locator('tbody tr').filter({ hasText: w.product.name }).getByText('Ordered: 4/4')).toBeVisible()

    await api.call('POST', `/invoicing/orders/${gen.order._id}/send`)
    await page.reload({ waitUntil: 'networkidle' })
    await expect(header).toHaveText('Reserved')
    await expect(page.locator('tbody tr').filter({ hasText: w.product.name }).getByText('Reserved Qty: 4/4')).toBeVisible()
  })
})

test.describe('Each hand-off lands on the next document (FR-22.35)', () => {
  test('generating a supplier order opens it; converting the client order opens the new invoice', async ({ page }) => {
    const api = await session()
    const w = await world(api, 2)
    const ordi = await clientOrder(api, w, 5)
    await api.call('POST', `/invoicing/internal-orders/${ordi._id}/reserve-available`, {})

    await loginForApp(page)
    await page.goto(`/invoicing/internal-orders/${ordi._id}/edit`, { waitUntil: 'networkidle' })
    await page.getByRole('button', { name: 'Generate outgoing order' }).click()
    const dialog = page.locator('.v-overlay--active .v-card').filter({ has: page.getByTestId('generate-target') })
    // No supplier order ever carried the article: pick the supplier.
    const supplier = dialog.getByRole('combobox', { name: 'Supplier' })
    await supplier.locator('xpath=ancestor::div[contains(@class,"v-field")][1]').click()
    await supplier.pressSequentially(w.supplierName, { delay: 20 })
    await page.locator('.v-overlay--active .v-list-item').filter({ hasText: w.supplierName }).first().click()
    await dialog.getByRole('button', { name: 'Create', exact: true }).click()
    await page.waitForURL(/\/invoicing\/orders\/[0-9a-f]{24}\/edit$/)
    const ordo = (await api.call('GET', `/invoicing/orders/${page.url().match(/orders\/([0-9a-f]{24})/)![1]}`)).order
    await expect(page.locator('.form-paper-header .text-h6')).toHaveText(ordo.orderNumber)
    expect(ordo.supplierGroups[0].lines[0].quantity).toBe(3)

    await page.goto(`/invoicing/internal-orders/${ordi._id}/edit`, { waitUntil: 'networkidle' })
    await page.locator('.form-actions-bar').getByRole('button', { name: 'Convert to Invoice' }).click()
    await page.waitForURL(/\/invoicing\/invoices\/[0-9a-f]{24}\/edit$/)
    const invoice = (await api.call('GET', `/invoices/${page.url().match(/invoices\/([0-9a-f]{24})/)![1]}`)).invoice
    expect(invoice).toMatchObject({ status: 'draft', internalOrderId: ordi._id })
    // What waits on the supplier order is said, and stays reserved for a later invoice.
    await expect(page.locator('.v-snackbar')).toContainText(ordo.orderNumber)
  })
})

test.describe('Cancel and Complete say what they release first (FR-22.41)', () => {
  test('a supplier order names the client orders it lets down; „No" keeps it, a refusal says why', async ({ page }) => {
    const api = await session()
    const w = await world(api)
    const ordi = await clientOrder(api, w, 4)
    const gen = await api.call('POST', `/invoicing/internal-orders/${ordi._id}/generate-external`, {
      lines: [{ internalOrderLineId: ordi.lines[0]._id, quantity: 4, supplierId: w.supplierId }],
    })
    const ordoId = gen.order._id
    await api.call('POST', `/invoicing/orders/${ordoId}/send`)
    // A supplier invoice booked against it: the server refuses the cancel while it is there.
    const { invoice: bill } = await api.call('POST', '/invoices', {
      type: 'invoice', direction: 'incoming', contactId: w.supplierId, issueDate: new Date().toISOString().slice(0, 10), currency: 'EUR',
      orderId: ordoId, lines: [{ productId: w.productId, description: w.product.name, quantity: 1, unitPrice: 1, taxRate: 20 }], subtotal: 1, total: 1.2,
    })

    await loginForApp(page)
    await page.goto(`/invoicing/orders/${ordoId}/edit`, { waitUntil: 'networkidle' })
    const cancel = page.locator('.form-actions-bar').getByRole('button', { name: 'Cancel Order' })
    const dialog = page.getByTestId('order-cascade')
    await cancel.click()
    await expect(dialog).toContainText('Reservations it releases: 1 (4 in all)')
    await expect(dialog).toContainText('Clients who lose a reservation: 1')
    await expect(dialog.getByTestId('order-cascade-orders')).toHaveText(`Incoming orders affected: ${ordi.orderNumber}`)
    await dialog.getByRole('button', { name: 'No', exact: true }).click()
    await expect(dialog).toBeHidden()
    expect((await api.call('GET', `/invoicing/orders/${ordoId}`)).order.status).toBe('sent')

    await cancel.click()
    await dialog.getByRole('button', { name: 'Cancel Order' }).click()
    await expect(dialog.getByRole('alert')).toHaveText('The outgoing order has invoices: void or delete them before cancelling it.')

    await api.call('DELETE', `/invoices/${bill._id}`)
    await dialog.getByRole('button', { name: 'Cancel Order' }).click()
    await expect(dialog).toBeHidden()
    await expect(page.locator('.v-snackbar')).toContainText(`Order cancelled. Incoming orders that lost reservations: ${ordi.orderNumber}`)
    const after = await api.call('GET', `/invoicing/orders/${ordoId}`)
    expect(after.order.status).toBe('cancelled')
    expect(after.reservations.map((r: any) => [r.status, r.cancelReason])).toEqual([['cancelled', 'external_order_cancelled']])
  })

  test('a client order says what Complete and Cancel release: stock, and the supplier orders by number', async ({ page }) => {
    const api = await session()
    const w = await world(api, 2)
    const ordi = await clientOrder(api, w, 5)
    await api.call('POST', `/invoicing/internal-orders/${ordi._id}/reserve-available`, {})
    const gen = await api.call('POST', `/invoicing/internal-orders/${ordi._id}/generate-external`, {
      lines: [{ internalOrderLineId: ordi.lines[0]._id, quantity: 3, supplierId: w.supplierId }],
    })

    await loginForApp(page)
    await page.goto(`/invoicing/internal-orders/${ordi._id}/edit`, { waitUntil: 'networkidle' })
    const bar = page.locator('.form-actions-bar')
    const dialog = page.getByTestId('order-cascade')
    await bar.getByRole('button', { name: 'Complete', exact: true }).click()
    await expect(dialog).toContainText(`Complete incoming order ${ordi.orderNumber}?`)
    await expect(dialog).toContainText('Reservations it releases: 2 (5 in all)')
    await expect(dialog).toContainText('Of them, from stock: 1')
    await expect(dialog.getByTestId('order-cascade-orders')).toHaveText(`On outgoing orders: ${gen.order.orderNumber}`)
    await dialog.getByRole('button', { name: 'No', exact: true }).click()
    await expect(dialog).toBeHidden()
    expect((await api.call('GET', `/invoicing/internal-orders/${ordi._id}`)).internalOrder.status).toBe('confirmed')

    await bar.getByRole('button', { name: 'Cancel Order' }).click()
    await expect(dialog).toContainText(`Cancel incoming order ${ordi.orderNumber}?`)
    await dialog.getByRole('button', { name: 'Cancel Order' }).click()
    await expect(dialog).toBeHidden()
    await expect(page.locator('.v-snackbar')).toContainText('Order cancelled')
    const after = await api.call('GET', `/invoicing/internal-orders/${ordi._id}`)
    expect(after.internalOrder.status).toBe('cancelled')
    expect(after.reservations.map((r: any) => [r.source, r.status, r.cancelReason])).toEqual([
      ['stock', 'cancelled', 'internal_order_cancelled'],
      ['order', 'cancelled', 'internal_order_cancelled'],
    ])
  })

  test('a client order with nothing reserved completes without asking', async ({ page }) => {
    const api = await session()
    const w = await world(api)
    const ordi = await clientOrder(api, w, 2)
    await loginForApp(page)
    await page.goto(`/invoicing/internal-orders/${ordi._id}/edit`, { waitUntil: 'networkidle' })
    await page.locator('.form-actions-bar').getByRole('button', { name: 'Complete', exact: true }).click()
    await expect(page.locator('.v-snackbar')).toContainText('Order completed')
    await expect(page.getByTestId('order-cascade')).toHaveCount(0)
    expect((await api.call('GET', `/invoicing/internal-orders/${ordi._id}`)).internalOrder.status).toBe('completed')
  })
})
