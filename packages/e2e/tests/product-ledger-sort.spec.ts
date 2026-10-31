import { test, expect } from '@playwright/test'
import { loginForApp } from './helpers/login'
import { columnValues } from './helpers/table'

/**
 * An article's ledger (`/inventory/products/:id/ledger`) sorts by any column — the header asks
 * the server, which sorts every row that passes the filters before it cuts the page — and a row's
 * start and end quantity stay the stock on either side of it, whatever the order or the period.
 *
 * Article used: one this spec creates per worker, with three movements of its own.
 */

const apiBase = process.env.BASE_URL || 'http://localhost:4001'
let productId = ''

test.beforeAll(async () => {
  const login = await (await fetch(`${apiBase}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ orgSlug: 'acme-corp', username: 'admin', password: 'test123' }),
  })).json()
  const orgId = login.org?.id || login.org?._id
  const call = async (method: string, path: string, body?: unknown) => (await fetch(`${apiBase}/api/org/${orgId}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${login.token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  })).json()

  const ts = Date.now()
  const { product } = await call('POST', '/warehouse/product', {
    sku: `E2E-LEDGER-${ts}`, name: `E2E Ledger ${ts}`, category: 'Test', type: 'goods', unit: 'pcs', sellingPrice: 3, purchasePrice: 1, taxRate: 20,
  })
  productId = product.id || product._id
  const warehouses = (await call('GET', '/warehouse/warehouse?size=100')).warehouses || []
  const warehouse = (warehouses.find((w: any) => w.isDefault) || warehouses[0])._id
  // +5 on the 10th, +10 on the 20th, −3 on the 30th: stock 5 → 15 → 12.
  for (const [type, date, quantity] of [['receipt', '2026-01-10', 5], ['receipt', '2026-01-20', 10], ['dispatch', '2026-01-30', 3]] as const) {
    const side = type === 'receipt' ? { toWarehouseId: warehouse } : { fromWarehouseId: warehouse }
    const { stockMovement } = await call('POST', '/warehouse/movement', {
      type, date: `${date}T00:00:00.000Z`, ...side, lines: [{ productId, quantity, unitCost: 1, totalCost: quantity }], totalAmount: quantity,
    })
    await call('POST', `/warehouse/movement/${stockMovement._id || stockMovement.id}/confirm`, {})
  }
})

test('a header sorts the ledger both ways, each row keeping its balance', async ({ page }) => {
  await loginForApp(page)
  await page.goto(`/inventory/products/${productId}/ledger`)
  const table = page.locator('.v-window-item--active .v-data-table')
  await expect(table.locator('tbody tr')).toHaveCount(3, { timeout: 15000 })
  expect(await columnValues(table, 'Qty Change')).toEqual(['+5', '+10', '-3'])

  const header = table.locator('thead th').filter({ hasText: /^Qty Change$/ })
  await header.click()
  await expect.poll(() => columnValues(table, 'Qty Change')).toEqual(['-3', '+5', '+10'])
  expect(await columnValues(table, 'Start Qty')).toEqual(['15', '0', '5'])
  expect(await columnValues(table, 'End Qty')).toEqual(['12', '5', '15'])

  await header.click()
  await expect.poll(() => columnValues(table, 'Qty Change')).toEqual(['+10', '+5', '-3'])
})

test('sorting works inside a period, and the period keeps the stock held before it', async ({ page }) => {
  await loginForApp(page)
  await page.goto(`/inventory/products/${productId}/ledger`)
  const table = page.locator('.v-window-item--active .v-data-table')
  await expect(table.locator('tbody tr')).toHaveCount(3, { timeout: 15000 })

  await page.locator('.v-window-item--active').getByLabel('Date From').fill('2026-01-15')
  await expect(table.locator('tbody tr')).toHaveCount(2)
  await table.locator('thead th').filter({ hasText: /^Qty Change$/ }).click()
  await expect.poll(() => columnValues(table, 'Qty Change')).toEqual(['-3', '+10'])
  // The +10 started from the 5 received before the period, not from zero.
  expect(await columnValues(table, 'Start Qty')).toEqual(['15', '5'])
  expect(await columnValues(table, 'End Qty')).toEqual(['12', '15'])
})
