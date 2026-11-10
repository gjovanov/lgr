import { test, expect } from '@playwright/test'
import { startWalk, uxApi } from '../helpers/ux-budget'

/**
 * P9 — Reorder from the list: what is short, in one order (FR-28.13 to .19).
 *
 * The job: the buyer opens Products, narrows it to what is below its minimum, takes all of it, makes a supplier
 * order and says whom it goes to. The path: „Below minimum" · tick the page · „Select all N that match the filter" ·
 * „Create supplier order" · the supplier of all rows (open, choose) · „Create". The new draft opens.
 *
 * Today's number, measured on the build before FR-28 slice 4: not possible. The Products list had no filter for what
 * is short, nothing to select and no order action; an order came only from the order form's own product search. By
 * hand that is four or more clicks PER ARTICLE: open the search, type the name, pick it, set its quantity, set its
 * supplier, add the next line — and the form has no way to take "everything below the minimum" at all. For the
 * twelve articles of this walk, 50 or more clicks and 24 typed fields.
 *
 * Twelve articles of the walk's own are below their minimum (a page holds ten, so "all that match" has something to
 * select), and the walk's supplier is the newest, so it is among the first the dialog offers. The seed's own articles
 * may be below their minimum too: the figures do not depend on how many.
 *
 * Starts on the Products list (reaching it is setup and is not counted).
 */

type Api = Awaited<ReturnType<typeof uxApi>>

/** FR-28 §6: P9 ≤ 8 clicks · 0 typed. One dialog: the order's. */
const BUDGET = { clicks: 8, typed: 0, dialogs: 1 }

const stamp = Date.now().toString(36)
const created: { products: string[]; supplier?: string; orders: string[] } = { products: [], orders: [] }
let api: Api

test.beforeAll(async () => {
  api = await uxApi()
  const { contact } = await api.post('/invoicing/contact', { type: 'supplier', companyName: `UX P9 Supplier ${stamp}` })
  created.supplier = contact._id || contact.id
  for (let i = 1; i <= 12; i++) {
    const { product } = await api.post('/warehouse/product', {
      sku: `UX-P9-${stamp}-${String(i).padStart(2, '0')}`, name: `UX reorder ${String(i).padStart(2, '0')} ${stamp}`, category: 'General', type: 'goods', unit: 'pcs',
      purchasePrice: 2.5, sellingPrice: 4, taxRate: 20, minStockLevel: 10, maxStockLevel: 30,
    })
    created.products.push(product._id || product.id)
  }
})

// Everything the walk made, undone: the draft order is deleted, the articles and the supplier are deactivated.
test.afterAll(async () => {
  for (const id of created.orders) await api.del(`/invoicing/orders/${id}`).catch(() => null)
  for (const id of created.products) await api.del(`/warehouse/product/${id}`).catch(() => null)
  if (created.supplier) await api.del(`/invoicing/contact/${created.supplier}`).catch(() => null)
})

test('P9 reorder: below minimum, select all that match, create a supplier order, set the supplier', async ({ page }, testInfo) => {
  const walk = await startWalk(page, testInfo, {
    id: 'P9',
    title: 'Products — reorder what is below the minimum in one supplier order',
    start: '/inventory/products',
  })
  const table = page.locator('.v-data-table').first()
  await expect(table.locator('tbody tr').first()).toBeVisible({ timeout: 15000 })

  // ── 1. Narrow the list to what is short ──
  await walk.click(page.getByTestId('filter-below-min'), 'press „Below minimum"')
  await expect(page).toHaveURL(/belowMin=true/)
  await expect(table.locator('tbody tr')).toHaveCount(10, { timeout: 15000 })

  // ── 2. Take all of it: the page, then everything that matches ──
  await walk.click(table.locator('thead .v-selection-control').first(), 'tick the page')
  await expect(page.getByTestId('select-all-banner')).toBeVisible()
  await walk.click(page.getByTestId('select-all-matching'), 'press „Select all N that match the filter"')
  await expect(page.getByTestId('all-matching-banner')).toBeVisible()
  await walk.shot('selected')

  // ── 3. Make the order ──
  await walk.click(page.getByTestId('create-supplier-order'), 'press „Create supplier order"')
  walk.dialog('the order dialog')
  const dialog = page.getByTestId('order-dialog')
  await expect(dialog.getByTestId('order-row').first()).toBeVisible({ timeout: 15000 })
  const rows = await dialog.getByTestId('order-row').count()
  expect(rows, 'the walk\'s twelve articles are among those below the minimum').toBeGreaterThanOrEqual(12)
  walk.note(`The dialog lists ${rows} articles.`)
  await walk.shot('dialog-open')

  // ── 4. Say whom it goes to: one supplier for every row (two clicks: open, choose) ──
  await walk.click(dialog.getByTestId('order-supplier-all').locator('.v-field'), 'open the supplier of all rows')
  await walk.click(page.locator('.v-overlay--active .v-list-item').filter({ hasText: `UX P9 Supplier ${stamp}` }).first(), 'choose the supplier')
  await expect(dialog.getByTestId('order-missing')).toHaveCount(0)
  await expect(dialog.getByTestId('order-create')).toBeEnabled()

  // ── 5. Create: the new draft opens ──
  await walk.click(dialog.getByTestId('order-create'), 'press „Create supplier order"')
  await page.waitForURL(/\/invoicing\/orders\/[0-9a-f]{24}\/edit$/, { timeout: 15000 })
  const id = page.url().match(/orders\/([0-9a-f]{24})\/edit/)![1]
  created.orders.push(id)

  const result = walk.finish()

  // One draft supplier order with one group for the supplier and a line per article below the minimum.
  const { order } = await api.get(`/invoicing/orders/${id}`)
  expect(order.status).toBe('draft')
  expect(order.supplierGroups).toHaveLength(1)
  expect(order.supplierGroups[0].lines.length).toBe(rows)

  // ── FR-28 §6 budget for P9 ──
  expect(result.clicks).toBeLessThanOrEqual(BUDGET.clicks)
  expect(result.typed).toBeLessThanOrEqual(BUDGET.typed)
  expect(result.dialogs).toBeLessThanOrEqual(BUDGET.dialogs)
  expect(result.hops).toBe(0)
})
