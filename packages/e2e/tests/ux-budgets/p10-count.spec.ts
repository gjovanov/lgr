import { test, expect } from '@playwright/test'
import { startWalk, uxApi } from '../helpers/ux-budget'

/**
 * P10 — A partial stock count of four articles (FR-33.20, #933).
 *
 * The job: the storekeeper counts four articles of one warehouse. They start a new count, choose the warehouse and
 * „Частична", find two articles by the search, tick the other two in „Details", type what they counted for three of
 * them (the fourth is as the system says), and save. The path: the warehouse (open, choose) · the type (open, choose) ·
 * the entry line, the first SKU, Enter takes the hit · its count, Enter goes back to the entry line · the second SKU,
 * Enter · its count, Enter · the common part of the four SKUs, F4 · tick two · „Add 2 articles" · the count of the
 * first one added (the cursor is there) · Save.
 *
 * Today's number, measured on the build before FR-33 slice B-UI: not possible. The count form had no product search
 * and no Details: „Load products" put every level of the warehouse on the count, a line could not be added, and an
 * article the warehouse keeps no level of could not be counted at all (FR-33 §1.1).
 *
 * The four articles are the walk's own, stocked in a warehouse of its own (5, 8, 12 and 20), so System is not 0 and
 * the fourth line's „left at System" says something. Its name sorts first, so the select shows it without a scroll.
 * The count is saved and never completed (FR-33 §8: a completion books an adjustment movement); the walk deletes it.
 *
 * Starts on a new count (reaching it is setup and is not counted).
 */

type Api = Awaited<ReturnType<typeof uxApi>>

/** FR-33.20: P10 ≤ 10 clicks · 6 typed fields · 1 dialog. */
const BUDGET = { clicks: 10, typed: 6, dialogs: 1 }

const stamp = Date.now().toString(36)
const SKU_PREFIX = `UX-P10-${stamp}`
const WAREHOUSE = `0 UX P10 ${stamp}`
/** The four articles, their stock in the walk's warehouse, and what is counted (null: left at System). */
const ARTICLES = [
  { n: 1, stock: 5, counted: 4 as number | null },
  { n: 2, stock: 8, counted: 9 as number | null },
  { n: 3, stock: 12, counted: 11 as number | null },
  { n: 4, stock: 20, counted: null as number | null },
]
const skuOf = (n: number) => `${SKU_PREFIX}-${n}`
const nameOf = (n: number) => `UX P10 count ${stamp} ${n}`

const made: { products: string[]; warehouse?: string; counts: string[] } = { products: [], counts: [] }
let api: Api

test.beforeAll(async () => {
  api = await uxApi()
  const { warehouse } = await api.post('/warehouse/warehouse', { code: `UXP10-${stamp}`, name: WAREHOUSE, type: 'warehouse' })
  made.warehouse = warehouse._id || warehouse.id
  for (const a of ARTICLES) {
    const { product } = await api.post('/warehouse/product', {
      sku: skuOf(a.n), name: nameOf(a.n), category: 'General', type: 'goods', unit: 'pcs', purchasePrice: 2, sellingPrice: 4, taxRate: 20,
    })
    const id = product._id || product.id
    made.products.push(id)
    const { stockMovement } = await api.post('/warehouse/movement', {
      type: 'receipt', date: new Date().toISOString(), toWarehouseId: made.warehouse,
      lines: [{ productId: id, quantity: a.stock, unitCost: 2, totalCost: a.stock * 2 }], totalAmount: a.stock * 2,
    })
    const confirmed = await api.post(`/warehouse/movement/${stockMovement._id || stockMovement.id}/confirm`)
    expect(confirmed.stockMovement?.status, 'the walk\'s stock is booked').toBe('completed')
  }
})

// Everything the walk made, undone: the count (never completed) is deleted, the articles and the warehouse are
// deactivated, so no other spec finds the warehouse among those that hold stock.
test.afterAll(async () => {
  for (const id of made.counts) await api.del(`/warehouse/inventory-count/${id}`).catch(() => null)
  for (const id of made.products) await api.del(`/warehouse/product/${id}`).catch(() => null)
  if (made.warehouse) await api.del(`/warehouse/warehouse/${made.warehouse}`).catch(() => null)
})

test('P10 count: a new partial count of four articles, two by the search and two through Details, three counted, saved', async ({ page }, testInfo) => {
  const walk = await startWalk(page, testInfo, {
    id: 'P10',
    title: 'Stock count — four articles, two by the search, two through „Details", three counted, saved',
    start: '/inventory/inventory-counts/new',
  })
  const ids = made.products
  const entryInput = page.getByTestId('count-entry').locator('[data-testid="product-field"] input')
  const lineRows = page.locator('[data-testid="count-line"]')
  const qtyOf = (productId: string) => page.locator(`[data-testid="count-line"][data-product="${productId}"]`).getByTestId('count-qty').locator('input')
  const hit = (sku: string) => page.locator('.v-overlay--active .v-list-item').filter({ hasText: `${sku} ·` }).first()
  await expect(entryInput).toBeDisabled()

  // ── 1. The warehouse and the type ──
  await walk.choose(page.locator('form'), /^Склад/, WAREHOUSE, `Склад: ${WAREHOUSE}`)
  await expect(entryInput).toBeEnabled()
  await walk.choose(page.locator('form'), /^Тип/, 'Частична','Тип: „Частична"')

  // ── 2. Two articles by the search: the SKU, Enter takes the hit, the cursor is in Counted ──
  for (const [i, a] of ARTICLES.slice(0, 2).entries()) {
    await walk.type(entryInput, skuOf(a.n), `the SKU of article ${a.n} in the entry line`, { focused: i > 0 })
    await expect(hit(skuOf(a.n))).toBeVisible({ timeout: 10000 })
    await walk.press(page, 'Enter', `take the hit ${skuOf(a.n)}`)
    await expect(qtyOf(ids[i])).toBeFocused()
    await expect(qtyOf(ids[i])).toHaveValue(String(a.stock))
    await walk.fill(qtyOf(ids[i]), String(a.counted), `counted ${a.counted} for article ${a.n}`, { focused: true })
    await walk.press(page, 'Enter', 'past the last line, back to the entry line')
    await expect(entryInput).toBeFocused()
  }
  await expect(lineRows).toHaveCount(2)
  await walk.shot('two-by-search')

  // ── 3. Two more through Details: F4 with the common part of the SKUs, the two on the count marked ──
  await walk.type(entryInput, SKU_PREFIX, 'the common part of the four SKUs', { focused: true })
  await expect(hit(skuOf(4))).toBeVisible({ timeout: 10000 })
  await walk.press(page, 'F4', 'open „Details" with what was typed')
  walk.dialog('the product dialog')
  const dialog = page.getByTestId('product-picker')
  const rows = dialog.locator('.picker-table tbody tr')
  await expect(rows).toHaveCount(4, { timeout: 10000 })
  await expect(dialog.getByTestId('product-on-document')).toHaveCount(2)
  for (const a of ARTICLES.slice(2)) await walk.click(rows.filter({ hasText: nameOf(a.n) }), `tick article ${a.n}`)
  await expect(page.getByTestId('product-picker-selected')).toContainText('2')
  await walk.shot('details-ticked')
  await walk.click(page.getByTestId('product-picker-add'), 'press „Add 2 articles"')
  await expect(dialog).toBeHidden()
  await expect(lineRows).toHaveCount(4)

  // ── 4. The third count: the cursor is on the first article added ──
  await expect(qtyOf(ids[2])).toBeFocused()
  await walk.fill(qtyOf(ids[2]), String(ARTICLES[2].counted), `counted ${ARTICLES[2].counted} for article 3`, { focused: true })
  await expect(qtyOf(ids[3])).toHaveValue(String(ARTICLES[3].stock))
  await walk.shot('four-lines')

  // ── 5. Save: the new count opens as its edit page ──
  const [saved] = await Promise.all([
    page.waitForResponse((r) => /\/warehouse\/inventory-count$/.test(new URL(r.url()).pathname) && r.request().method() === 'POST'),
    walk.click(page.getByRole('button', { name: /^Запази$/ }).filter({ visible: true }).first(), 'press „Запази"'),
  ])
  expect(saved.status()).toBeLessThan(300)
  await page.waitForURL(/\/inventory-counts\/[0-9a-f]{24}\/edit$/, { timeout: 15000 })
  const countId = page.url().match(/inventory-counts\/([0-9a-f]{24})\/edit/)![1]
  made.counts.push(countId)

  const result = walk.finish()

  // ── What the walk proves: four lines, one per article, three counted, the fourth at System, nothing completed ──
  const expected = ARTICLES.map((a, i) => ({ productId: ids[i], systemQuantity: a.stock, countedQuantity: a.counted ?? a.stock }))
  const { inventoryCount } = await api.get(`/warehouse/inventory-count/${countId}`)
  expect(inventoryCount.status).not.toBe('completed')
  expect(inventoryCount.type).toBe('partial')
  expect(inventoryCount.warehouseId).toBe(made.warehouse)
  expect(inventoryCount.lines.map((l: any) => ({ productId: l.productId, systemQuantity: l.systemQuantity, countedQuantity: l.countedQuantity }))).toEqual(expected)
  expect(new Set(inventoryCount.lines.map((l: any) => l.productId)).size, 'no article twice').toBe(4)

  // Opened again, the count shows the same: four lines, the three counts, the fourth at its System.
  await page.goto(`/inventory/inventory-counts/${countId}/edit`, { waitUntil: 'networkidle' })
  await expect(lineRows).toHaveCount(4, { timeout: 15000 })
  for (const e of expected) await expect(qtyOf(e.productId)).toHaveValue(String(e.countedQuantity))
  walk.note(`Saved ${inventoryCount.countNumber}: ${expected.map((e) => `${e.systemQuantity}→${e.countedQuantity}`).join(', ')}. Not completed.`)

  // ── FR-33.20 budget for P10 ──
  expect(result.clicks).toBeLessThanOrEqual(BUDGET.clicks)
  expect(result.typed).toBeLessThanOrEqual(BUDGET.typed)
  expect(result.dialogs).toBeLessThanOrEqual(BUDGET.dialogs)
  expect(result.hops).toBe(0)
})
