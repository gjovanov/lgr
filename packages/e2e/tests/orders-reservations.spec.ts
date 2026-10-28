import { test, expect } from '@playwright/test'
import { loginForApp } from './helpers/login'

/**
 * #203 — client reservations where the order is: reserved in the outgoing-order form, saved with
 * it, changed and cancelled there; reserved again from the Reservations list; and visible on the
 * product's „Наличност" tab.
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

/** A product, a supplier, a client, and a sent supplier order of 6 for one warehouse. */
async function seedOrder(token: string, orgId: string) {
  const ts = Date.now()
  const product = (await apiCall('POST', `/org/${orgId}/warehouse/product`, token, {
    sku: `E2E-RES-${ts}`, name: `E2E Винт ${ts}`, category: 'Test', type: 'goods', unit: 'pcs', sellingPrice: 2, taxRate: 20,
  })).product
  const supplier = (await apiCall('POST', `/org/${orgId}/invoicing/contact`, token, { type: 'supplier', companyName: `E2E Доставчик ${ts}` })).contact
  const client = (await apiCall('POST', `/org/${orgId}/invoicing/contact`, token, { type: 'customer', companyName: `E2E Клиент ${ts}` })).contact
  const warehouses = (await apiCall('GET', `/org/${orgId}/warehouse/warehouse?size=1000`, token)).warehouses || []
  const warehouse = warehouses.find((w: any) => w.isDefault) || warehouses[0]
  const created = await apiCall('POST', `/org/${orgId}/invoicing/orders`, token, {
    issueDate: new Date().toISOString().slice(0, 10), expectedDate: '2026-12-01', currency: 'EUR', tags: [],
    supplierGroups: [{
      supplierId: supplier.id || supplier._id,
      lines: [{ productId: product.id || product._id, description: product.name, quantity: 6, unit: 'pcs', allocations: [{ warehouseId: warehouse._id, quantity: 6 }] }],
    }],
  })
  const orderId = created.order._id
  await apiCall('POST', `/org/${orgId}/invoicing/orders/${orderId}/send`, token)
  return { orderId, product, productId: product.id || product._id, client, clientId: client.id || client._id, ts }
}

const reservationsOf = async (token: string, orgId: string, orderId: string) =>
  (await apiCall('GET', `/org/${orgId}/invoicing/orders/${orderId}`, token)).reservations as any[]

test.describe('Client reservations in the supplier order (#203)', () => {
  test('reserve for a client in the form, save, change it, cancel it — all with the order', async ({ page }) => {
    const { token, orgId } = await getAuthToken()
    const s = await seedOrder(token, orgId)

    await loginForApp(page)
    await page.goto(`/invoicing/orders/${s.orderId}/edit`)
    await expect(page.getByRole('heading', { name: /edit supplier order/i }).first()).toBeVisible({ timeout: 15000 })

    // The line's client-reservations grid is folded while the line holds none; reserving is per
    // allocation inside it.
    const grid = page.getByRole('button', { name: /client reservations/i }).first()
    await expect(grid).toHaveAttribute('aria-expanded', 'false')
    await grid.click()
    await page.getByRole('button', { name: /reserve for client/i }).first().click()
    const dialog = page.locator('.v-dialog').filter({ hasText: /reserve for client/i })
    await expect(dialog).toBeVisible()
    const client = dialog.getByRole('combobox', { name: /customer/i })
    await client.locator('xpath=ancestor::div[contains(@class,"v-field")][1]').click()
    await client.pressSequentially(`E2E Клиент ${s.ts}`, { delay: 30 })
    await page.getByRole('option', { name: new RegExp(`E2E Клиент ${s.ts}`) }).click()
    await dialog.getByLabel(/qty/i).fill('4')
    await dialog.getByRole('button', { name: /^reserve$/i }).click()

    // Staged under its allocation, nothing posted yet.
    await expect(page.getByText(`E2E Клиент ${s.ts}`).first()).toBeVisible()
    await expect(page.getByText('unsaved changes')).toBeVisible()
    expect(await reservationsOf(token, orgId, s.orderId)).toHaveLength(0)

    await page.getByRole('button', { name: /^save$/i }).first().click()
    await expect.poll(async () => (await reservationsOf(token, orgId, s.orderId)).map(r => [r.quantity, r.status])).toEqual([[4, 'active']])
    // The staged row is replaced by the saved one when the order reloads — not before.
    await expect(page.getByText('unsaved changes')).toBeHidden()
    const number = (await reservationsOf(token, orgId, s.orderId))[0].reservationNumber

    // The grid stays as the user left it across the save's reload, and folds and unfolds on demand.
    const qtyField = page.getByRole('spinbutton', { name: new RegExp(number) })
    await expect(qtyField).toBeVisible()
    await grid.click()
    await expect(qtyField).toBeHidden()
    await grid.click()
    await expect(qtyField).toBeVisible()
    // Opened fresh, a line that holds a reservation shows its grid without a click.
    await page.reload()
    await expect(qtyField).toBeVisible({ timeout: 15000 })
    await expect(grid).toHaveAttribute('aria-expanded', 'true')

    // Change it in place, then cancel it — each a save of the order.
    await page.getByRole('spinbutton', { name: new RegExp(number) }).fill('3')
    await expect(page.getByText('unsaved changes')).toBeVisible()
    await page.getByRole('button', { name: /^save$/i }).first().click()
    await expect.poll(async () => (await reservationsOf(token, orgId, s.orderId))[0].quantity).toBe(3)
    await expect(page.getByText('unsaved changes')).toBeHidden()

    await page.getByRole('button', { name: /cancel reservation/i }).first().click()
    await expect(page.getByText('cancelled on save').first()).toBeVisible()
    await page.getByRole('button', { name: /^save$/i }).first().click()
    await expect.poll(async () => (await reservationsOf(token, orgId, s.orderId))[0].status).toBe('cancelled')
  })

  test('the Reservations list names both orders and reserves a cancelled one again', async ({ page }) => {
    const { token, orgId } = await getAuthToken()
    const s = await seedOrder(token, orgId)
    const order = (await apiCall('GET', `/org/${orgId}/invoicing/orders/${s.orderId}`, token)).order
    const line = order.supplierGroups[0].lines[0]
    const res = (await apiCall('POST', `/org/${orgId}/invoicing/reservations`, token, {
      source: 'order', productId: s.productId, quantity: 2, contactId: s.clientId,
      orderId: s.orderId, groupId: order.supplierGroups[0]._id, lineId: line._id, allocationId: line.allocations[0]._id,
    })).reservation
    await apiCall('POST', `/org/${orgId}/invoicing/reservations/${res._id}/cancel`, token, {})

    await loginForApp(page)
    await page.goto(`/invoicing/reservations?q=${encodeURIComponent(res.reservationNumber)}`)
    const row = page.locator('.v-data-table tbody tr', { hasText: res.reservationNumber })
    await expect(row).toBeVisible({ timeout: 15000 })
    // Its source is the supplier order, by number and linked.
    await expect(row.getByRole('link', { name: order.orderNumber })).toBeVisible()
    await expect(row.getByText(/supplier order/i)).toBeVisible()

    await row.getByRole('button', { name: /reserve again/i }).click()
    await expect.poll(async () =>
      (await reservationsOf(token, orgId, s.orderId)).filter((r: any) => r.status === 'active').map((r: any) => [r.quantity, String(r.repeatOf)]),
    ).toEqual([[2, String(res._id)]])
  })

  test('the product\'s stock tab shows what is expected and how much of it is reserved', async ({ page }) => {
    const { token, orgId } = await getAuthToken()
    const s = await seedOrder(token, orgId)
    const order = (await apiCall('GET', `/org/${orgId}/invoicing/orders/${s.orderId}`, token)).order
    const line = order.supplierGroups[0].lines[0]
    await apiCall('POST', `/org/${orgId}/invoicing/reservations`, token, {
      source: 'order', productId: s.productId, quantity: 5, contactId: s.clientId,
      orderId: s.orderId, groupId: order.supplierGroups[0]._id, lineId: line._id, allocationId: line.allocations[0]._id,
    })

    await loginForApp(page)
    await page.goto(`/inventory/products/${s.productId}/stock`)
    await expect(page.getByText('Expected deliveries')).toBeVisible({ timeout: 15000 })
    // The order number is in both tables: the delivery row starts with it, the reservation row names
    // it as its source.
    const delivery = page.getByRole('row', { name: new RegExp(`^${order.orderNumber}`) })
    await expect(delivery).toContainText('6')
    await expect(delivery.locator('.v-chip', { hasText: `E2E Клиент ${s.ts}: 5` })).toBeVisible()
    const reservation = page.getByRole('row', { name: /^RES-/ })
    await expect(reservation.getByRole('link', { name: order.orderNumber })).toBeVisible()
  })
})
