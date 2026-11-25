import { test, expect } from '@playwright/test'
import { loginForApp } from './helpers/login'
import { openSelect } from './helpers/vuetify'

/**
 * FR-33.1 / FR-33.2 (#933, slice A; FR-30.17 of #795, first built in #848): the stock count form at 25 000 levels.
 *
 * At 23 040 levels the plain table showed its rows after 190 s, held 438 104 DOM nodes and took 7.3 s to paint a
 * keystroke. Now: the first rows within 3 s of "Load products", at most 10 000 DOM nodes, a keystroke painted within
 * 100 ms; a line filter by name, SKU or barcode that reads Latin and Cyrillic look-alikes as one letter, "Not counted
 * yet" and "With a difference"; a typed quantity stays with its article through a filter; and what Save sends is what
 * the plain table sent.
 *
 * The warehouse's levels are the browser's: the stock-level answer is replaced by 25 000 made-up levels (the form only
 * shows them), and the save is answered here, after its payload is read. Nothing is written.
 */
const LEVELS = 25_000
const hex = (n: number) => n.toString(16).padStart(24, '0')

test('a count of 25 000 levels can be filled in: filter, type, toggle, save', async ({ page }) => {
  test.setTimeout(180_000)
  await page.route('**/warehouse/stock-level?*', async (route) => {
    const url = new URL(route.request().url())
    if (url.searchParams.get('fields') !== 'count') return route.continue()
    const stockLevels = Array.from({ length: LEVELS }, (_, i) => ({
      _id: hex(1_000_000 + i), productId: hex(2_000_000 + i), warehouseId: url.searchParams.get('warehouseId'),
      quantity: i % 9, avgCost: 1.5, productName: `Болт ${i} DIN 933`, productSku: `SKU-${i}`, productUnit: 'бр.',
      productBarcode: String(2_000_000_000_000 + i), warehouseName: 'W',
    }))
    await route.fulfill({ json: { stockLevels, total: LEVELS, page: 0, size: LEVELS, totalPages: 1 } })
  })
  let sent: any = null
  await page.route('**/warehouse/inventory-count', async (route) => {
    if (route.request().method() !== 'POST') return route.continue()
    sent = route.request().postDataJSON()
    await route.fulfill({ status: 500, json: { message: 'not saved: the e2e read the payload' } })
  })

  await loginForApp(page)
  await page.goto('/inventory/inventory-counts/new')
  await openSelect(page.locator('form'), /warehouse/i)
  await page.locator('.v-overlay--active .v-list-item').first().click()

  // First rows within 3 s.
  const started = Date.now()
  await page.getByRole('button', { name: /load products/i }).click()
  // A virtual table's first and last rows are spacers: the articles' rows are the ones that name a SKU.
  const rows = page.locator('[data-testid="count-lines"] tbody tr').filter({ hasText: /SKU-/ })
  await expect(rows.first()).toContainText('Болт 0', { timeout: 15_000 })
  const firstRowsMs = Date.now() - started
  await expect(page.getByTestId('count-shown')).toHaveText(`${LEVELS} / ${LEVELS}`)

  // At most 10 000 DOM nodes.
  const nodes = await page.evaluate(() => document.getElementsByTagName('*').length)

  // A keystroke painted within 100 ms (the median of five).
  const qty = rows.first().getByTestId('count-qty').locator('input')
  await qty.click()
  await qty.fill('')
  const paints: number[] = []
  for (const key of ['1', '2', '3', '4', '5']) {
    const t0 = Date.now()
    await page.keyboard.press(key)
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))
    paints.push(Date.now() - t0)
  }
  paints.sort((a, b) => a - b)
  test.info().annotations.push({ type: 'budgets', description: `first rows ${firstRowsMs} ms, ${nodes} DOM nodes, keystroke ${paints[2]} ms` })
  console.log(`FR-33.1: first rows ${firstRowsMs} ms, ${nodes} DOM nodes, keystroke ${paints[2]} ms (median of 5)`)
  expect(firstRowsMs).toBeLessThan(3_000)
  expect(nodes).toBeLessThan(10_000)
  expect(paints[2]!).toBeLessThan(100)
  await expect(qty).toHaveValue('12345')

  // The line filter by name, then by SKU: a quantity typed into a found row stays with its article.
  const search = page.getByTestId('count-search').locator('input')
  await search.fill('Болт 24999 ')
  await expect(page.getByTestId('count-shown')).toHaveText(`1 / ${LEVELS}`)
  const found = rows.first()
  await expect(found).toContainText('SKU-24999')
  await found.getByTestId('count-qty').locator('input').fill('77')
  await search.fill('sku-1234')
  await expect(page.getByTestId('count-shown')).toHaveText(`11 / ${LEVELS}`)
  // FR-33.2: a Cyrillic name typed with a Latin look-alike („Бoлт", a Latin o), and a barcode.
  await search.fill('Бoлт 24998')
  await expect(page.getByTestId('count-shown')).toHaveText(`1 / ${LEVELS}`)
  await expect(rows.first()).toContainText('SKU-24998')
  await search.fill(String(2_000_000_000_000 + 4321))
  await expect(page.getByTestId('count-shown')).toHaveText(`1 / ${LEVELS}`)
  await expect(rows.first()).toContainText('SKU-4321')
  await search.fill('')

  // "With a difference": the two typed lines (24999's system quantity is 24999 % 9 = 6; line 0's is 0).
  await page.getByTestId('count-filter').getByRole('button', { name: /with a difference/i }).click()
  await expect(page.getByTestId('count-shown')).toHaveText(`2 / ${LEVELS}`)
  await expect(rows.filter({ hasText: 'SKU-24999' }).getByTestId('count-qty').locator('input')).toHaveValue('77')
  // "Not counted yet": every line but the two.
  await page.getByTestId('count-filter').getByRole('button', { name: /not counted yet/i }).click()
  await expect(page.getByTestId('count-shown')).toHaveText(`${LEVELS - 2} / ${LEVELS}`)
  await page.getByTestId('count-filter').getByRole('button', { name: /^all$/i }).click()

  // Save sends what the plain table sent: every line, in the same shape.
  await page.getByRole('button', { name: /^save$/i }).filter({ visible: true }).first().click()
  await expect.poll(() => sent, { timeout: 15_000 }).not.toBeNull()
  expect(Object.keys(sent).sort()).toEqual(['date', 'itemCount', 'lines', 'notes', 'type', 'varianceCount', 'warehouseId'])
  expect(sent.lines).toHaveLength(LEVELS)
  expect(Object.keys(sent.lines[0]).sort()).toEqual(['countedQuantity', 'productId', 'systemQuantity', 'variance'])
  expect(sent.itemCount).toBe(LEVELS)
  expect(sent.varianceCount).toBe(2)
  expect(sent.lines[0]).toEqual({ productId: hex(2_000_000), systemQuantity: 0, countedQuantity: 12345, variance: 12345 })
  expect(sent.lines[24_999]).toEqual({ productId: hex(2_024_999), systemQuantity: 6, countedQuantity: 77, variance: 71 })
})
