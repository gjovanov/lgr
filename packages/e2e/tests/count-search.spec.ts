import { test, expect } from '@playwright/test'
import { loginForApp } from './helpers/login'
import { apiDelete, apiGet, apiLogin, apiPost } from './helpers/api'
import { openSelect } from './helpers/vuetify'

/**
 * FR-33.4 to .10 and .16 (#933, slice B-UI): the stock count finds and adds articles the way an invoice does.
 *
 * The count's entry line is the movement's pair, `ProductSearch` and Details: the hit row with the count warehouse's
 * stock and no price; a pick puts the article on a line with System read now and Counted equal to it, the cursor in
 * Counted and a fresh entry line; an article already on the count shows its line; Details adds several with one stock
 * request; the warehouse is locked while the count has lines; "Load products" on a count with lines adds what is
 * missing (D-1); Complete saves first; and the keyboard walks the Counted column, of a 25 000-line count too.
 * FR-33.11: a scanned code that names one article is added with no list, or shows its line; a scanned code that names
 * several leaves the list open; a text typed by hand is FR-33.12's first hit.
 *
 * The articles this spec makes carry a stamp of their own and no stock: they are "found goods" in every warehouse.
 * A count it makes is deleted, except the one it completes, which books only its own article.
 */

test.use({ viewport: { width: 1366, height: 1000 } })

const PREFIX = 'E2E-CNT'
const COUNT = 12

interface Fixture { stamp: string; ids: string[]; sku: (n: number) => string; name: (n: number) => string }

let made: Promise<Fixture> | undefined
/** Twelve articles, so "Show all N results" has more than ten to show. Made once per worker. */
function fixture(): Promise<Fixture> {
  made ??= (async () => {
    const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`
    const nn = (n: number) => String(n).padStart(2, '0')
    const session = await apiLogin()
    const ids: string[] = []
    for (let n = 1; n <= COUNT; n++) {
      const res = await apiPost(session, '/warehouse/product', {
        sku: `${PREFIX}-${stamp}-${nn(n)}`, name: `E2E Count ${stamp} ${nn(n)}`, category: 'Test', type: 'goods', unit: 'pcs',
        sellingPrice: 10, purchasePrice: 5, taxRate: 20,
      })
      expect(res.status, `a fixture article: ${res.status}`).toBeLessThan(300)
      ids.push((await res.json()).product._id)
    }
    return { stamp, ids, sku: (n) => `${PREFIX}-${stamp}-${nn(n)}`, name: (n) => `E2E Count ${stamp} ${nn(n)}` }
  })()
  return made
}

/** A warehouse that holds stock, and one of its levels. Never "the first option": other specs add empty ones. */
async function stockedWarehouse(session: Awaited<ReturnType<typeof apiLogin>>) {
  const { warehouses } = await apiGet(session, '/warehouse/warehouse?size=1000')
  for (const w of (warehouses || []).filter((x: any) => x.isActive !== false)) {
    const { stockLevels, total } = await apiGet(session, `/warehouse/stock-level?warehouseId=${w._id}&size=1`)
    if (stockLevels?.length && stockLevels[0].productSku) return { warehouse: w, level: stockLevels[0], levels: Number(total) || 0 }
  }
  throw new Error('the seed has a warehouse that holds stock')
}

async function chooseWarehouse(page: any, name: string) {
  // The select's list is virtualised: an option far down is not in the page until the list is scrolled to it.
  await openSelect(page.locator('form'), /warehouse/i)
  const option = page.getByRole('option', { name, exact: true })
  const list = page.locator('.v-overlay--active .v-list').last()
  await list.waitFor({ state: 'visible' })
  for (let i = 0; i < 40 && !(await option.count()); i++) {
    await list.evaluate((el: HTMLElement) => { el.scrollTop += el.clientHeight })
    await page.waitForTimeout(100)
  }
  await option.click()
}

const entry = (page: any) => page.getByTestId('count-entry')
const entryInput = (page: any) => entry(page).locator('[data-testid="product-field"] input')
const lineRows = (page: any) => page.locator('[data-testid="count-line"]')
const lineOf = (page: any, productId: string) => page.locator(`[data-testid="count-line"][data-product="${productId}"]`)
const qtyOf = (page: any, productId: string) => lineOf(page, productId).getByTestId('count-qty').locator('input')
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
/** The hit whose second line starts with this SKU: "SKU · unit · stock". */
const hit = (page: any, sku: string) => page.locator('.v-overlay--active .v-list-item').filter({ hasText: new RegExp(`${escape(sku)} ·`) }).first()

async function pick(page: any, text: string, sku: string) {
  await entryInput(page).click()
  await entryInput(page).pressSequentially(text, { delay: 20 })
  await expect(hit(page, sku)).toBeVisible({ timeout: 10000 })
  await hit(page, sku).click()
}

test('the search on a new count: the hit row, a pick, the cursor in Counted, a repeated article, found goods, the lock and the keys', async ({ page }) => {
  const fx = await fixture()
  const session = await apiLogin()
  const { warehouse, level } = await stockedWarehouse(session)

  await loginForApp(page)
  await page.goto('/inventory/inventory-counts/new')
  // FR-33.4: no warehouse, no search: System depends on it.
  await expect(entry(page).getByTestId('count-entry-hint')).toBeVisible()
  await expect(entryInput(page)).toBeDisabled()
  await chooseWarehouse(page, warehouse.name)
  await expect(entryInput(page)).toBeEnabled()

  // The hit: SKU · unit · the count warehouse's stock, and no price (a count prices nothing).
  await entryInput(page).click()
  await entryInput(page).pressSequentially(level.productSku, { delay: 20 })
  const row = hit(page, level.productSku)
  await expect(row).toBeVisible({ timeout: 10000 })
  await expect(row).toContainText(`${warehouse.name}:`, { timeout: 10000 })
  await expect(row).not.toContainText(/€|EUR|BGN|лв/)
  await row.click()

  // FR-33.6: a line with System read now and Counted equal to it, the cursor in Counted with the figure selected, and
  // a fresh entry line.
  const stocked = lineOf(page, level.productId)
  await expect(stocked).toBeVisible()
  await expect(stocked.getByTestId('count-line-no')).toHaveText('1')
  await expect(qtyOf(page, level.productId)).toBeFocused()
  await expect(qtyOf(page, level.productId)).toHaveValue(String(level.quantity))
  await expect(entryInput(page)).toHaveValue('')
  await page.keyboard.press('7')
  await expect(qtyOf(page, level.productId)).toHaveValue('7')

  // FR-33.7: the same article again shows its line; no second one.
  await pick(page, level.productSku, level.productSku)
  await expect(lineRows(page)).toHaveCount(1)
  await expect(entry(page).getByTestId('count-entry-note')).toHaveText('Already on the count: line 1')
  await expect(qtyOf(page, level.productId)).toBeFocused()
  await expect(qtyOf(page, level.productId)).toHaveValue('7')

  // Found goods: no level in this warehouse, System 0 and the hint.
  await pick(page, fx.sku(1), fx.sku(1))
  const found = lineOf(page, fx.ids[0])
  await expect(found).toBeVisible()
  await expect(found.getByTestId('count-not-stocked')).toHaveText('not stocked here')
  await expect(qtyOf(page, fx.ids[0])).toHaveValue('0')
  await expect(found.getByTestId('count-line-no')).toHaveText('2')

  // FR-33.8: Enter down the Counted column, past the last line to the entry line, Shift+Enter back.
  await qtyOf(page, level.productId).click()
  await page.keyboard.press('Enter')
  await expect(qtyOf(page, fx.ids[0])).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(entryInput(page)).toBeFocused()
  await page.keyboard.press('Shift+Enter')
  await expect(qtyOf(page, fx.ids[0])).toBeFocused()
  // "+ Add line" puts the cursor in the entry line.
  await page.getByTestId('count-add-line').click()
  await expect(entryInput(page)).toBeFocused()

  // FR-33.14: the warehouse is locked while the count has lines; removing every line unlocks it.
  const warehouseField = page.getByTestId('count-warehouse')
  await expect(warehouseField).toHaveClass(/v-input--disabled/)
  await lineOf(page, fx.ids[0]).getByTestId('count-remove').click()
  await expect(warehouseField).toHaveClass(/v-input--disabled/)
  await lineOf(page, level.productId).getByTestId('count-remove').click()
  await expect(lineRows(page)).toHaveCount(0)
  await expect(warehouseField).not.toHaveClass(/v-input--disabled/)
})

test('a scanner: a barcode is added with no list, scanned again it shows its line, and a typed text takes the first hit (FR-33.11)', async ({ page }) => {
  const fx = await fixture()
  const session = await apiLogin()
  const { warehouse } = await stockedWarehouse(session)
  const barcode = `2${String(Date.now()).slice(-9)}${String(Math.floor(Math.random() * 1000)).padStart(3, '0')}`
  const made = await apiPost(session, '/warehouse/product', {
    // No stamp in it: the typed and scanned searches for the fixture's stamp below must not find it.
    sku: `E2E-SCAN-${barcode}`, barcode, name: `E2E Scan ${barcode}`, category: 'Test', type: 'goods', unit: 'pcs',
    sellingPrice: 10, purchasePrice: 5, taxRate: 20,
  })
  expect(made.status, `the scanned article: ${made.status}`).toBeLessThan(300)
  const scanId: string = (await made.json()).product._id

  await loginForApp(page)
  await page.goto('/inventory/inventory-counts/new')
  await chooseWarehouse(page, warehouse.name)
  const lookups: string[] = []
  page.on('response', (r: any) => { if (r.url().includes('/warehouse/product/lookup')) lookups.push(new URL(r.url()).searchParams.get('code') || '') })
  const listRows = page.locator('.v-overlay--active .v-list-item')

  // A scanner types the code in a burst and presses Enter. A code that names several articles is never guessed: the
  // list stays open on it and nothing is added.
  await entryInput(page).click()
  await page.keyboard.type(`${PREFIX}-${fx.stamp}`)
  await page.keyboard.press('Enter')
  await expect.poll(() => lookups.length).toBe(1)
  await expect(listRows.first()).toContainText(fx.stamp, { timeout: 10000 })
  await expect(lineRows(page)).toHaveCount(0)
  await expect(entryInput(page)).toHaveValue(`${PREFIX}-${fx.stamp}`)
  await entryInput(page).fill('')

  // A scanned barcode names one article: it is added with no list, and what follows is a pick's (FR-33.6): System
  // (found goods: 0), Counted = System, the cursor in Counted, a fresh entry line.
  await page.keyboard.type(barcode)
  await page.keyboard.press('Enter')
  await expect(lineOf(page, scanId)).toBeVisible({ timeout: 10000 })
  expect(lookups).toEqual([`${PREFIX}-${fx.stamp}`, barcode])
  await expect(listRows).toHaveCount(0)
  await expect(qtyOf(page, scanId)).toBeFocused()
  await expect(qtyOf(page, scanId)).toHaveValue('0')
  await expect(lineOf(page, scanId).getByTestId('count-not-stocked')).toBeVisible()
  await expect(entryInput(page)).toHaveValue('')
  await page.keyboard.press('3')
  await expect(qtyOf(page, scanId)).toHaveValue('3')

  // The same barcode scanned again: no second line; its line is shown with the cursor in its Counted (FR-33.7, D-2).
  await entryInput(page).click()
  await page.keyboard.type(barcode)
  await page.keyboard.press('Enter')
  await expect(entry(page).getByTestId('count-entry-note')).toHaveText('Already on the count: line 1')
  await expect(lineRows(page)).toHaveCount(1)
  await expect(qtyOf(page, scanId)).toBeFocused()
  await expect(qtyOf(page, scanId)).toHaveValue('3')
  await expect(entryInput(page)).toHaveValue('')

  // Typed by hand, a text that names several articles is FR-33.12's Enter: the first hit of what the field holds.
  await entryInput(page).click()
  await entryInput(page).pressSequentially(`${PREFIX}-${fx.stamp}`, { delay: 120 })
  await expect(listRows.first()).toContainText(fx.stamp, { timeout: 10000 })
  const firstTitle = (await listRows.first().locator('.v-list-item-title').innerText()).trim()
  await page.keyboard.press('Enter')
  await expect(lineRows(page)).toHaveCount(2)
  await expect(lineRows(page).nth(1)).toContainText(firstTitle)
  await expect(entryInput(page)).toHaveValue('')
})

test('F4 and "Show all": three ticked articles become three lines with one stock request, and the count\'s articles are marked', async ({ page }) => {
  const fx = await fixture()
  const session = await apiLogin()
  const { warehouse } = await stockedWarehouse(session)

  await loginForApp(page)
  await page.goto('/inventory/inventory-counts/new')
  await chooseWarehouse(page, warehouse.name)

  await entryInput(page).click()
  await entryInput(page).pressSequentially(`${PREFIX}-${fx.stamp}`, { delay: 20 })
  const all = page.getByTestId('product-show-all')
  await expect(all).toContainText(`Show all ${COUNT} results`, { timeout: 10000 })
  await all.click()
  const dialog = page.getByTestId('product-picker')
  await expect(dialog).toBeVisible()
  await expect(dialog.locator('[data-testid="filter-search"] input')).toHaveValue(`${PREFIX}-${fx.stamp}`)
  const rows = dialog.locator('.picker-table tbody tr')
  await expect(rows).toHaveCount(COUNT, { timeout: 10000 })
  // Name order 01 … 12: tick 03, 01, 02.
  await rows.nth(2).click()
  await rows.nth(0).click()
  await rows.nth(1).click()
  await expect(page.getByTestId('product-picker-selected')).toContainText('3 selected')

  const stockCalls: string[] = []
  page.on('request', (r: any) => { if (r.url().includes('/warehouse/stock-level/by-products')) stockCalls.push(r.url()) })
  await page.getByTestId('product-picker-add').click()
  await expect(dialog).toBeHidden()
  await expect(lineRows(page)).toHaveCount(3)
  // In the order ticked.
  expect(await lineRows(page).evaluateAll((els: Element[]) => els.map((e) => e.getAttribute('data-product')))).toEqual([fx.ids[2], fx.ids[0], fx.ids[1]])
  await expect(entry(page).getByTestId('count-entry-note')).toHaveText('3 articles added')
  // The cursor goes to the first article added, as after one pick.
  await expect(qtyOf(page, fx.ids[2])).toBeFocused()
  const ours = stockCalls.filter((u) => fx.ids.slice(0, 3).some((id) => u.includes(id)))
  expect(ours, 'one stock request for the three').toHaveLength(1)
  for (const id of fx.ids.slice(0, 3)) expect(ours[0]).toContain(id)

  // F4 opens Details with what was typed, the articles on the count marked; one more ticked with one already there.
  await entryInput(page).click()
  await entryInput(page).pressSequentially(`${PREFIX}-${fx.stamp}`, { delay: 20 })
  await page.keyboard.press('F4')
  await expect(dialog).toBeVisible()
  await expect(dialog.locator('[data-testid="filter-search"] input')).toHaveValue(`${PREFIX}-${fx.stamp}`)
  await expect(rows).toHaveCount(COUNT, { timeout: 10000 })
  await expect(dialog.getByTestId('product-on-document')).toHaveCount(3)
  await rows.nth(0).click()
  await rows.nth(3).click()
  await page.getByTestId('product-picker-add').click()
  await expect(lineRows(page)).toHaveCount(4)
  await expect(entry(page).getByTestId('count-entry-note')).toHaveText('1 articles added; 1 were already on the count')
})

test('Details: the cursor reaches the first article added while the dialog is still leaving (#933)', async ({ page }) => {
  // Found in the field test on master 1a3b7da5: the click on "Add N articles" focuses that button, and the button keeps
  // the cursor while the dialog runs its leave transition. The pick read that as "the person moved on" and left the
  // cursor on <body>. Here the leave finishes in 125 ms, before the pick looks (200 ms after the stock answer), so the
  // test above never saw it: the dialog's leave is made to last 1.5 s, as it did in the field.
  const fx = await fixture()
  const session = await apiLogin()
  const { warehouse } = await stockedWarehouse(session)

  await loginForApp(page)
  await page.goto('/inventory/inventory-counts/new')
  await chooseWarehouse(page, warehouse.name)
  await page.addStyleTag({
    content: '.v-overlay__content.dialog-transition-leave-active { transition: transform 1500ms linear, opacity 1500ms linear !important }'
      + ' .v-overlay__content.dialog-transition-leave-to { opacity: 0 !important }',
  })

  const dialog = page.getByTestId('product-picker')
  const rows = dialog.locator('.picker-table tbody tr')
  async function openDetails() {
    await entryInput(page).click()
    await entryInput(page).pressSequentially(`${PREFIX}-${fx.stamp}`, { delay: 20 })
    await expect(page.getByTestId('product-show-all')).toContainText(`Show all ${COUNT} results`, { timeout: 10000 })
    await page.keyboard.press('F4')
    await expect(dialog).toBeVisible()
    await expect(rows).toHaveCount(COUNT, { timeout: 10000 })
  }

  // A click on "Add 2 articles": the cursor is in the first one's Counted while the dialog is still on its way out.
  await openDetails()
  await rows.nth(6).click()
  await rows.nth(7).click()
  await page.getByTestId('product-picker-add').click()
  await expect(qtyOf(page, fx.ids[6])).toBeFocused({ timeout: 1000 })
  expect(await dialog.count(), 'the dialog is still leaving').toBe(1)
  // And it stays there once the dialog, and the button that held the cursor, are gone.
  await expect(dialog).toHaveCount(0, { timeout: 5000 })
  await expect(qtyOf(page, fx.ids[6])).toBeFocused()
  await expect(lineRows(page)).toHaveCount(2)

  // Enter in Details' search adds the ticked articles: that field holds the cursor while the dialog leaves.
  await openDetails()
  await rows.nth(8).click()
  await dialog.locator('[data-testid="filter-search"] input').click()
  await page.keyboard.press('Enter')
  await expect(qtyOf(page, fx.ids[8])).toBeFocused({ timeout: 2000 })
  await expect(dialog).toHaveCount(0, { timeout: 5000 })
  await expect(qtyOf(page, fx.ids[8])).toBeFocused()

  // FR-28.27: a person who has gone on to the fresh entry field meanwhile keeps the cursor there.
  await openDetails()
  await rows.nth(9).click()
  await page.getByTestId('product-picker-add').click()
  await entryInput(page).focus()
  await expect(lineRows(page)).toHaveCount(4)
  await expect(dialog).toHaveCount(0, { timeout: 5000 })
  await expect(entryInput(page)).toBeFocused()
  await expect(qtyOf(page, fx.ids[9])).not.toBeFocused()
})

test('the edit page: a pick, "Load products" adds only what is missing and keeps what was typed, and Save sends the same payload', async ({ page }) => {
  const fx = await fixture()
  const session = await apiLogin()
  const { warehouse } = await stockedWarehouse(session)
  const res = await apiPost(session, '/warehouse/inventory-count', {
    warehouseId: warehouse._id, date: new Date().toISOString().slice(0, 10), type: 'partial', notes: '', itemCount: 1, varianceCount: 0,
    lines: [{ productId: fx.ids[4], systemQuantity: 0, countedQuantity: 0, variance: 0 }],
  })
  expect(res.status).toBeLessThan(300)
  const countId = (await res.json()).inventoryCount._id
  try {
    await loginForApp(page)
    await page.goto(`/inventory/inventory-counts/${countId}/edit`)
    await expect(lineOf(page, fx.ids[4])).toBeVisible({ timeout: 15000 })
    // FR-33.9: the unit is read for a saved count's lines too.
    await expect(lineOf(page, fx.ids[4])).toContainText('pcs')
    await expect(page.getByTestId('count-warehouse')).toHaveClass(/v-input--disabled/)

    await pick(page, fx.sku(6), fx.sku(6))
    await expect(lineRows(page)).toHaveCount(2)
    await expect(qtyOf(page, fx.ids[5])).toBeFocused()
    await page.keyboard.press('4')
    await qtyOf(page, fx.ids[4]).fill('5')

    // D-1: the levels not on the count yet, and the two lines keep what was typed.
    const [answer] = await Promise.all([
      page.waitForResponse((r: any) => r.url().includes('/warehouse/stock-level?') && r.request().method() === 'GET'),
      page.getByTestId('count-load').click(),
    ])
    expect(answer.status()).toBe(200)
    // The warehouse's levels as this answer has them: other specs receive goods into it meanwhile.
    const levels = ((await answer.json()).stockLevels as any[]).length
    await expect(page.getByTestId('count-shown')).toHaveText(`${levels + 2} / ${levels + 2}`, { timeout: 15000 })
    await page.getByTestId('count-search').locator('input').fill(`${PREFIX}-${fx.stamp}`)
    await expect(qtyOf(page, fx.ids[4])).toHaveValue('5')
    await expect(qtyOf(page, fx.ids[5])).toHaveValue('4')
    await page.getByTestId('count-search').locator('input').fill('')

    const [saved] = await Promise.all([
      page.waitForResponse((r: any) => new URL(r.url()).pathname.endsWith(`/warehouse/inventory-count/${countId}`) && r.request().method() === 'PUT'),
      page.getByRole('button', { name: /^save$/i }).filter({ visible: true }).first().click(),
    ])
    expect(saved.status()).toBe(200)
    const sent = saved.request().postDataJSON()
    expect(Object.keys(sent).sort()).toEqual(['date', 'itemCount', 'lines', 'notes', 'type', 'varianceCount', 'warehouseId'])
    expect(Object.keys(sent.lines[0]).sort()).toEqual(['countedQuantity', 'productId', 'systemQuantity', 'variance'])
    expect(sent.lines).toHaveLength(levels + 2)
    expect(sent.lines.slice(0, 2)).toEqual([
      { productId: fx.ids[4], systemQuantity: 0, countedQuantity: 5, variance: 5 },
      { productId: fx.ids[5], systemQuantity: 0, countedQuantity: 4, variance: 4 },
    ])
    expect(sent.varianceCount).toBe(2)
  } finally {
    await apiDelete(session, `/warehouse/inventory-count/${countId}`)
  }
})

test('Complete with unsaved edits saves them first, and books what the screen shows (FR-33.16)', async ({ page }) => {
  const fx = await fixture()
  const session = await apiLogin()
  const { warehouse } = await stockedWarehouse(session)
  const res = await apiPost(session, '/warehouse/inventory-count', {
    warehouseId: warehouse._id, date: new Date().toISOString().slice(0, 10), type: 'partial', notes: '', itemCount: 1, varianceCount: 0,
    lines: [{ productId: fx.ids[7], systemQuantity: 0, countedQuantity: 0, variance: 0 }],
  })
  expect(res.status).toBeLessThan(300)
  const countId = (await res.json()).inventoryCount._id

  await loginForApp(page)
  await page.goto(`/inventory/inventory-counts/${countId}/edit`)
  await expect(qtyOf(page, fx.ids[7])).toBeVisible({ timeout: 15000 })
  await qtyOf(page, fx.ids[7]).fill('3')

  const order: string[] = []
  page.on('request', (r: any) => {
    const path = new URL(r.url()).pathname
    if (path.endsWith(`/inventory-count/${countId}`) && r.method() === 'PUT') order.push('save')
    if (path.endsWith(`/inventory-count/${countId}/complete`)) order.push('complete')
  })
  const [completed] = await Promise.all([
    page.waitForResponse((r: any) => new URL(r.url()).pathname.endsWith(`/inventory-count/${countId}/complete`)),
    page.getByRole('button', { name: /complete count/i }).filter({ visible: true }).first().click(),
  ])
  expect(completed.status()).toBe(200)
  expect(order).toEqual(['save', 'complete'])
  const { inventoryCount } = await apiGet(session, `/warehouse/inventory-count/${countId}`)
  expect(inventoryCount.status).toBe('completed')
  expect(inventoryCount.lines.map((l: any) => [l.productId, l.countedQuantity])).toEqual([[fx.ids[7], 3]])
  // A completed count shows no entry line, no ×, no Load.
  await expect(entry(page)).toHaveCount(0)
  await expect(page.getByTestId('count-remove')).toHaveCount(0)
  await expect(page.getByTestId('count-load')).toHaveCount(0)
})

test('the keyboard over 25 000 lines: Enter walks down Counted past the rows not drawn yet (FR-33.8)', async ({ page }) => {
  test.setTimeout(180_000)
  const LEVELS = 25_000
  const hex = (n: number) => n.toString(16).padStart(24, '0')
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

  await loginForApp(page)
  await page.goto('/inventory/inventory-counts/new')
  await openSelect(page.locator('form'), /warehouse/i)
  await page.locator('.v-overlay--active .v-list-item').first().click()
  await page.getByTestId('count-load').click()
  await expect(page.getByTestId('count-shown')).toHaveText(`${LEVELS} / ${LEVELS}`, { timeout: 15_000 })

  const focusedLine = () => page.evaluate(() => (document.activeElement as HTMLElement | null)?.closest('[data-line-qty]')?.getAttribute('data-line-qty') ?? null)
  await qtyOf(page, hex(2_000_000)).click()
  // Sixty rows down: far past what 60vh of the virtual table draws.
  for (let i = 1; i <= 60; i++) {
    await page.keyboard.press('Enter')
    await expect.poll(focusedLine, { timeout: 5000 }).toBe(hex(2_000_000 + i))
  }
  await page.keyboard.press('9')
  await expect(qtyOf(page, hex(2_000_060))).toHaveValue('9')
  await page.keyboard.press('Shift+Enter')
  await expect.poll(focusedLine).toBe(hex(2_000_059))
  await page.keyboard.press('Tab')
  await expect.poll(focusedLine).toBe(hex(2_000_060))

  // The entry line stays in view under the rows of a long count (§2.5).
  await expect(entryInput(page)).toBeInViewport()
  // Past the last line shown, the cursor goes to the entry line.
  await page.getByTestId('count-search').locator('input').fill('Болт 24999 ')
  await expect(page.getByTestId('count-shown')).toHaveText(`1 / ${LEVELS}`)
  await qtyOf(page, hex(2_024_999)).click()
  await page.keyboard.press('Enter')
  await expect(entryInput(page)).toBeFocused()
})
