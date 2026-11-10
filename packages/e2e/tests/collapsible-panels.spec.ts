import { test, expect } from '@playwright/test'
import { loginForApp } from './helpers/login'

/**
 * FR-28.43 — the order forms' cards fold away.
 *
 * Each supplier's card, the Reservations card and the Invoices card of a supplier order, and the
 * lines card and the Reservations card of a customer order are collapsible panels. A folded panel
 * says what it holds in one line; its state is kept per user, screen and organization, so it is
 * still folded after a reload and not folded on another screen; a thing that needs attention keeps
 * a flag on the header whether the panel is open or not; and the buttons that act on the whole
 * order stay on a folded header.
 *
 * (The flat Reservations cards start CLOSED, on both orders, since the tree of FR-28.40 and FR-28.44 shows the
 * reservations under the line they serve: FR-28 D-6. Everything else starts open.)
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
  return { call }
}

type Api = Awaited<ReturnType<typeof session>>

/** An article with stock in the default warehouse, a client and a supplier. */
async function world(api: Api) {
  const ts = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
  const { product } = await api.call('POST', '/warehouse/product', {
    sku: `E2E-PNL-${ts}`, name: `E2E panel article ${ts}`, category: 'Test', type: 'goods', unit: 'pcs', sellingPrice: 3, purchasePrice: 1, taxRate: 20,
  })
  const productId = product.id || product._id
  const { contact: client } = await api.call('POST', '/invoicing/contact', { type: 'customer', companyName: `E2E panel client ${ts}` })
  const { contact: supplier } = await api.call('POST', '/invoicing/contact', { type: 'supplier', companyName: `E2E panel supplier ${ts}` })
  const warehouses = (await api.call('GET', '/warehouse/warehouse?size=100')).warehouses || []
  const warehouse = warehouses.find((w: any) => w.isDefault) || warehouses[0]
  return { product, productId, warehouse, clientId: client.id || client._id, supplierId: supplier.id || supplier._id }
}

async function supplierOrder(api: Api, w: Awaited<ReturnType<typeof world>>) {
  const { order } = await api.call('POST', '/invoicing/orders', {
    issueDate: new Date().toISOString().slice(0, 10), currency: 'EUR', tags: [],
    supplierGroups: [{ supplierId: w.supplierId, lines: [{ productId: w.productId, description: w.product.name, quantity: 4, unit: 'pcs', allocations: [{ warehouseId: w.warehouse._id, quantity: 4 }] }] }],
  })
  return order
}

async function customerOrder(api: Api, w: Awaited<ReturnType<typeof world>>) {
  const { internalOrder } = await api.call('POST', '/invoicing/internal-orders', {
    contactId: w.clientId, issueDate: new Date().toISOString().slice(0, 10), requestedDeliveryDate: '2026-12-15',
    lines: [{ productId: w.productId, description: w.product.name, quantity: 3, unit: 'pcs' }],
  })
  return (await api.call('POST', `/invoicing/internal-orders/${internalOrder._id}/confirm`)).internalOrder
}

/** What the browser kept for a screen's panels. */
async function keptPanels(page: any, screen: string): Promise<Record<string, boolean>> {
  return page.evaluate((s: string) => {
    for (const [k, v] of Object.entries(localStorage)) {
      if (new RegExp(`^lgr:ui:panels:[^:]+:[^:]+:${s.replace('.', '\\.')}$`).test(k)) return JSON.parse(v as string)
    }
    return {}
  }, screen)
}

test.describe('Supplier order — the cards fold away', () => {
  test('a supplier\'s card folds, says what it holds, and stays folded after a reload', async ({ page }) => {
    const api = await session()
    const w = await world(api)
    const order = await supplierOrder(api, w)

    await loginForApp(page)
    await page.goto(`/invoicing/orders/${order._id}/edit`)
    await expect(page.locator('.form-paper-header').getByText(order.orderNumber)).toBeVisible({ timeout: 15000 })

    const group = page.getByTestId('order-group').first()
    const toggle = group.getByTestId('panel-toggle')
    const body = group.getByTestId('panel-body')
    // Open to begin with, and nothing to summarise while it is.
    await expect(toggle).toHaveAttribute('aria-expanded', 'true')
    await expect(body).toBeVisible()
    await expect(group.getByTestId('panel-summary')).toHaveCount(0)

    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-expanded', 'false')
    await expect(body).toBeHidden()
    // The folded card still says how much it holds: lines, ordered, reserved.
    await expect(group.getByTestId('panel-summary')).toHaveText('1 line · 4 ordered · 0 reserved')

    // Kept for this user, this organization and this screen.
    const kept = await keptPanels(page, 'orders.edit')
    expect(Object.values(kept), 'the folded card is remembered').toContain(false)

    await page.reload()
    await expect(page.locator('.form-paper-header').getByText(order.orderNumber)).toBeVisible({ timeout: 15000 })
    await expect(page.getByTestId('order-group').first().getByTestId('panel-toggle')).toHaveAttribute('aria-expanded', 'false')
    await expect(page.getByTestId('order-group').first().getByTestId('panel-body')).toBeHidden()

    // And open again, which is remembered as well.
    await page.getByTestId('order-group').first().getByTestId('panel-toggle').click()
    await page.reload()
    await expect(page.locator('.form-paper-header').getByText(order.orderNumber)).toBeVisible({ timeout: 15000 })
    await expect(page.getByTestId('order-group').first().getByTestId('panel-toggle')).toHaveAttribute('aria-expanded', 'true')
  })

  test('the cards fold on their own: closing one leaves the others open', async ({ page }) => {
    const api = await session()
    const w = await world(api)
    const order = await supplierOrder(api, w)

    await loginForApp(page)
    await page.goto(`/invoicing/orders/${order._id}/edit`)
    await expect(page.locator('.form-paper-header').getByText(order.orderNumber)).toBeVisible({ timeout: 15000 })

    // The flat Reservations card starts closed: the tree shows the reservations under their warehouse (FR-28 D-6).
    const reservations = page.getByTestId('order-reservations')
    await expect(reservations.getByTestId('panel-toggle')).toHaveAttribute('aria-expanded', 'false')
    await expect(reservations.getByTestId('panel-summary')).toHaveText('0 reservations · 0 clients')
    await reservations.getByTestId('panel-toggle').click()
    await expect(reservations.getByTestId('panel-toggle')).toHaveAttribute('aria-expanded', 'true')
    await expect(reservations.getByTestId('panel-body')).toBeVisible()

    // The supplier's card is its own panel.
    await expect(page.getByTestId('order-group').first().getByTestId('panel-toggle')).toHaveAttribute('aria-expanded', 'true')
    // Putting the card back leaves nothing of the opened state behind on the screen.
    await reservations.getByTestId('panel-toggle').click()
    await expect(reservations.getByTestId('panel-body')).toBeHidden()
  })

  test('a supplier card with no supplier keeps its warning while it is folded', async ({ page }) => {
    await loginForApp(page)
    await page.goto('/invoicing/orders/new')
    const group = page.getByTestId('order-group').first()
    await expect(group).toBeVisible({ timeout: 15000 })
    // A new order starts with one empty supplier card: a save would refuse it, and folding it must not hide why.
    await expect(group.getByTestId('panel-flag')).toHaveText('Supplier missing')
    await group.getByTestId('panel-toggle').click()
    await expect(group.getByTestId('panel-body')).toBeHidden()
    await expect(group.getByTestId('panel-flag')).toHaveText('Supplier missing')
  })
})

test.describe('Customer order — the cards fold away', () => {
  test('the lines card folds with a summary, and the order-wide buttons stay on a folded Reservations card', async ({ page }) => {
    const api = await session()
    const w = await world(api)
    const ordi = await customerOrder(api, w)

    await loginForApp(page)
    await page.goto(`/invoicing/internal-orders/${ordi._id}/edit`)
    await expect(page.locator('.form-paper-header').getByText(ordi.orderNumber)).toBeVisible({ timeout: 15000 })

    const lines = page.getByTestId('internal-order-lines')
    await expect(lines.getByTestId('panel-toggle')).toHaveAttribute('aria-expanded', 'true')
    await lines.getByTestId('panel-toggle').click()
    await expect(lines.getByTestId('panel-body')).toBeHidden()
    await expect(lines.getByTestId('panel-summary')).toHaveText('1 line · 3 needed · 0 reserved')

    // The flat Reservations card starts closed: the tree shows the reservations under their line (FR-28 D-6). Its buttons act
    // on the whole order, so they are on its header, folded or not.
    const reservations = page.getByTestId('internal-order-reservations')
    await expect(reservations.getByTestId('panel-toggle')).toHaveAttribute('aria-expanded', 'false')
    await expect(reservations.getByTestId('panel-body')).toBeHidden()
    await expect(reservations.getByRole('button', { name: 'Reserve from stock' })).toBeVisible()
    await expect(reservations.getByRole('button', { name: 'Cover shortages' })).toBeVisible()
    await reservations.getByTestId('panel-toggle').click()
    await expect(reservations.getByTestId('panel-body')).toBeVisible()
    await reservations.getByTestId('panel-toggle').click()
    await expect(reservations.getByTestId('panel-body')).toBeHidden()

    // This screen's state is not the supplier order's: the keys are per screen.
    expect(Object.keys(await keptPanels(page, 'internal-orders.edit')).sort()).toEqual(['lines', 'reservations'])
    expect(await keptPanels(page, 'orders.edit')).toEqual({})

    await page.reload()
    await expect(page.locator('.form-paper-header').getByText(ordi.orderNumber)).toBeVisible({ timeout: 15000 })
    await expect(page.getByTestId('internal-order-lines').getByTestId('panel-toggle')).toHaveAttribute('aria-expanded', 'false')
    await expect(page.getByTestId('internal-order-reservations').getByTestId('panel-toggle')).toHaveAttribute('aria-expanded', 'false')
  })
})

test.describe('The panel is a control', () => {
  test('its toggle is a named button that says whether it is open', async ({ page }) => {
    const api = await session()
    const w = await world(api)
    const order = await supplierOrder(api, w)

    await loginForApp(page)
    await page.goto(`/invoicing/orders/${order._id}/edit`)
    await expect(page.locator('.form-paper-header').getByText(order.orderNumber)).toBeVisible({ timeout: 15000 })

    const toggle = page.getByTestId('order-group').first().getByTestId('panel-toggle')
    await expect(toggle).toHaveAttribute('aria-controls', /.+/)
    // Named by what pressing it does.
    await expect(toggle).toHaveAttribute('aria-label', /collapse/i)
    await toggle.focus()
    await page.keyboard.press('Enter')
    await expect(toggle).toHaveAttribute('aria-expanded', 'false')
    await expect(toggle).toHaveAttribute('aria-label', /expand/i)
  })
})
