import { test, expect } from '@playwright/test'
import { loginForApp } from './helpers/login'

/**
 * FR-22.37 — reservations get a screen: made on the Reservations list (from free stock or from a
 * supplier order, optionally for a client-order line), opened on their own page with every number
 * a link, released in part behind buttons that cannot be confused, and made again — in a dialog
 * that names the shortage when the old source has nothing left (FR-22 §5.7).
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

/** A new article, a client and the default warehouse; `stock` units received into it. */
async function world(api: Api, stock = 0) {
  const ts = Date.now()
  const product = (await api.call('POST', '/warehouse/product', {
    sku: `E2E-RSV-${ts}`, name: `E2E Анкер ${ts}`, category: 'Test', type: 'goods', unit: 'pcs', sellingPrice: 3, purchasePrice: 1, taxRate: 20,
  })).product
  const productId = product.id || product._id
  const client = (await api.call('POST', '/invoicing/contact', { type: 'customer', companyName: `E2E Клиент РС ${ts}` })).contact
  const warehouses = (await api.call('GET', '/warehouse/warehouse?size=100')).warehouses || []
  const warehouse = warehouses.find((w: any) => w.isDefault) || warehouses[0]
  if (stock > 0) {
    const { stockMovement } = await api.call('POST', '/warehouse/movement', {
      type: 'receipt', date: new Date().toISOString(), toWarehouseId: warehouse._id,
      lines: [{ productId, quantity: stock, unitCost: 1, totalCost: stock }], totalAmount: stock,
    })
    await api.call('POST', `/warehouse/movement/${stockMovement._id || stockMovement.id}/confirm`, {})
  }
  return { ts, product, productId, client, clientId: client.id || client._id, warehouse }
}

test.describe('Reservations get a screen (FR-22.37)', () => {
  test('made on the list from a supplier order, for a client-order line, and opened on its own page', async ({ page }) => {
    const api = await session()
    const w = await world(api)
    const supplier = (await api.call('POST', '/invoicing/contact', { type: 'supplier', companyName: `E2E Доставчик РС ${w.ts}` })).contact
    const today = new Date().toISOString().slice(0, 10)
    const { order } = await api.call('POST', '/invoicing/orders', {
      issueDate: today, expectedDate: '2026-12-01', currency: 'EUR', tags: [],
      supplierGroups: [{ supplierId: supplier.id || supplier._id, lines: [{ productId: w.productId, description: w.product.name, quantity: 6, unit: 'pcs', allocations: [{ warehouseId: w.warehouse._id, quantity: 6 }] }] }],
    })
    const sent = (await api.call('POST', `/invoicing/orders/${order._id}/send`)).order
    const { internalOrder } = await api.call('POST', '/invoicing/internal-orders', {
      contactId: w.clientId, issueDate: today, requestedDeliveryDate: '2026-12-15',
      lines: [{ productId: w.productId, description: w.product.name, quantity: 4, unit: 'pcs' }],
    })
    const ordi = (await api.call('POST', `/invoicing/internal-orders/${internalOrder._id}/confirm`)).internalOrder

    await loginForApp(page)
    await page.goto('/invoicing/reservations', { waitUntil: 'networkidle' })
    await page.getByRole('button', { name: 'New reservation' }).click()
    const dialog = page.getByTestId('reservation-create')
    await expect(dialog).toBeVisible()
    await dialog.getByRole('combobox', { name: 'Customer' }).pressSequentially(`E2E Клиент РС ${w.ts}`, { delay: 20 })
    await page.locator('.v-overlay--active .v-list-item').filter({ hasText: `E2E Клиент РС ${w.ts}` }).first().click()
    await dialog.getByRole('combobox', { name: 'Product' }).pressSequentially(w.product.sku, { delay: 20 })
    await page.locator('.v-overlay--active .v-list-item').filter({ hasText: w.product.sku }).first().click()
    await dialog.getByRole('spinbutton', { name: 'Qty' }).fill('3')
    // No stock: the supplier order is the one source, and it comes chosen.
    await expect(dialog.getByRole('radio', { name: new RegExp(sent.orderNumber) })).toBeChecked()
    await expect(dialog.getByRole('radio')).toHaveCount(1)
    // The client's open order line is offered, not chosen.
    const forOrder = dialog.getByRole('combobox', { name: /for a customer order/i })
    await forOrder.locator('xpath=ancestor::div[contains(@class,"v-field")][1]').click()
    await page.locator('.v-overlay--active .v-list-item').filter({ hasText: ordi.orderNumber }).click()
    await dialog.getByRole('button', { name: 'Reserve' }).click()

    await page.waitForURL(/\/invoicing\/reservations\/[0-9a-f]{24}$/)
    await expect(page.getByRole('link', { name: sent.orderNumber })).toBeVisible()
    await expect(page.getByRole('link', { name: ordi.orderNumber })).toBeVisible()
    await expect(page.getByTestId('reservation-history')).toContainText('Created')
    const id = page.url().match(/reservations\/([0-9a-f]{24})/)![1]
    const { reservation } = await api.call('GET', `/invoicing/reservations/${id}`)
    expect(reservation).toMatchObject({ source: 'order', quantity: 3, orderNumber: sent.orderNumber, internalOrderNumber: ordi.orderNumber })

    // The supplier order's link opens it; its reservation links back to this page.
    await page.getByRole('link', { name: sent.orderNumber }).click()
    await page.waitForURL(/\/orders\/[0-9a-f]{24}\/edit/)
    await page.getByRole('link', { name: reservation.reservationNumber }).first().click()
    await page.waitForURL(new RegExp(`/reservations/${id}$`))
  })

  test('part of it released, then the rest, and reserved again from its page', async ({ page }) => {
    const api = await session()
    const w = await world(api, 10)
    const { reservation } = await api.call('POST', '/invoicing/reservations', {
      source: 'stock', productId: w.productId, warehouseId: w.warehouse._id, contactId: w.clientId, quantity: 5,
    })

    await loginForApp(page)
    await page.goto(`/invoicing/reservations/${reservation._id}`, { waitUntil: 'networkidle' })
    await expect(page.getByTestId('reservation-number')).toHaveText(reservation.reservationNumber)
    await page.locator('.form-actions-bar').getByRole('button', { name: 'Release the reservation' }).click()
    const dialog = page.getByTestId('reservation-release')
    await expect(dialog).toBeVisible()
    // Two buttons that cannot be confused; it starts on all of it.
    await expect(dialog.getByRole('button')).toHaveText(['No', 'Release the reservation'])
    const amount = dialog.getByRole('spinbutton', { name: 'Quantity to release' })
    await expect(amount).toHaveValue('5')
    await expect(dialog).toContainText('Up to 5 can be released')
    await amount.fill('2')
    await expect(dialog).toContainText('3 stay reserved.')
    await dialog.getByRole('button', { name: 'Release the reservation' }).click()
    await expect(page.getByTestId('reservation-quantity')).toContainText('3')
    await expect(page.getByTestId('reservation-history')).toContainText('2 released')
    expect((await api.call('GET', `/invoicing/reservations/${reservation._id}`)).reservation).toMatchObject({ status: 'active', quantity: 3 })

    // „No" keeps it.
    await page.locator('.form-actions-bar').getByRole('button', { name: 'Release the reservation' }).click()
    await dialog.getByRole('button', { name: 'No' }).click()
    await expect(dialog).toBeHidden()
    expect((await api.call('GET', `/invoicing/reservations/${reservation._id}`)).reservation.status).toBe('active')

    // The rest: cancelled.
    await page.locator('.form-actions-bar').getByRole('button', { name: 'Release the reservation' }).click()
    await expect(dialog).toContainText('The reservation is cancelled')
    await dialog.getByRole('button', { name: 'Release the reservation' }).click()
    await expect(page.getByTestId('reservation-history')).toContainText('Cancelled')

    // Again, from its page: the new one opens, and says what it repeats.
    await page.locator('.form-actions-bar').getByRole('button', { name: 'Reserve again' }).click()
    await expect(page.getByTestId('reservation-number')).not.toHaveText(reservation.reservationNumber)
    await expect(page.getByTestId('reservation-link').filter({ hasText: 'Reserved again from' })).toContainText(reservation.reservationNumber)
    await expect(page.getByTestId('reservation-history')).toContainText(`Reserved again from ${reservation.reservationNumber}`)
  })

  test('a repeat whose warehouse has nothing free opens the dialog with the shortage named', async ({ page }) => {
    const api = await session()
    const w = await world(api, 4)
    const other = (await api.call('POST', '/invoicing/contact', { type: 'customer', companyName: `E2E Друг клиент ${w.ts}` })).contact
    const { reservation } = await api.call('POST', '/invoicing/reservations', {
      source: 'stock', productId: w.productId, warehouseId: w.warehouse._id, contactId: w.clientId, quantity: 4,
    })
    await api.call('POST', `/invoicing/reservations/${reservation._id}/cancel`, {})
    await api.call('POST', '/invoicing/reservations', {
      source: 'stock', productId: w.productId, warehouseId: w.warehouse._id, contactId: other.id || other._id, quantity: 4,
    })

    await loginForApp(page)
    await page.goto(`/invoicing/reservations?q=${encodeURIComponent(reservation.reservationNumber)}`, { waitUntil: 'networkidle' })
    const row = page.locator('.v-data-table tbody tr', { hasText: reservation.reservationNumber })
    await row.getByRole('button', { name: /reserve again/i }).click()
    const dialog = page.getByTestId('reservation-create')
    await expect(dialog).toBeVisible()
    await expect(dialog).toContainText(`Reserve ${reservation.reservationNumber} again`)
    await expect(dialog.getByTestId('reservation-create-error')).toHaveText('Not enough free stock: 0 free.')
    await expect(dialog.getByTestId('reservation-no-sources')).toBeVisible()
    await expect(dialog.getByRole('button', { name: 'Reserve' })).toBeDisabled()
    // Nothing was made.
    const { reservations } = await api.call('GET', `/invoicing/reservations?productId=${w.productId}&status=active&size=10`)
    expect(reservations.map((r: any) => r.contactId)).toEqual([String(other.id || other._id)])
  })

  test('„New" in the top bar opens the new-reservation dialog on the list', async ({ page }) => {
    await loginForApp(page)
    await page.goto('/invoicing/invoices', { waitUntil: 'networkidle' })
    await page.getByTestId('new-document-menu').click()
    await page.getByTestId('new-document-list').locator('.v-list-item').filter({ hasText: 'Reservation' }).click()
    await expect(page.getByTestId('reservation-create')).toBeVisible()
    await expect(page).toHaveURL(/\/invoicing\/reservations(\?(?!.*new=)|$)/)
  })
})

test.describe('The order lists keep a bare URL bare (FR-22.15)', () => {
  test('every status is the declared default of the reservations, client-orders and supplier-orders lists', async ({ page }) => {
    await loginForApp(page)
    for (const path of ['/invoicing/reservations', '/invoicing/internal-orders', '/invoicing/orders']) {
      await page.goto(path, { waitUntil: 'networkidle' })
      // The list writes its state after a 250 ms debounce; give it the chance to.
      await page.waitForTimeout(600)
      expect(new URL(page.url()).search, path).toBe('')
    }
    // A status chosen in the URL still filters.
    await page.goto('/invoicing/reservations?status=cancelled', { waitUntil: 'networkidle' })
    await page.waitForTimeout(600)
    expect(new URL(page.url()).searchParams.get('status')).toBe('cancelled')
  })
})
