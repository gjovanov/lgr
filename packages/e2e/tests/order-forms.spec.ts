import { test, expect, type Page } from '@playwright/test'
import { loginForApp } from './helpers/login'

/**
 * FR-22 slice 4b — the client-order and supplier-order forms: a form nobody touched is never
 * „unsaved changes", however slowly it loads and whatever its reservations do meanwhile.
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
