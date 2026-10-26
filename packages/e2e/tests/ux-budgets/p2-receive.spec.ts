import { test, expect } from '@playwright/test'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { startWalk, uxApi } from '../helpers/ux-budget'

/**
 * P2 — Goods arrive before the supplier's invoice. Book a receipt into Main Warehouse from a
 * supplier, with product update: two existing articles (PRD-0013 ×10, PRD-0014 ×5), each with a
 * new purchase and selling price, plus one article that is not in the catalog yet (×7, with
 * purchase and selling price). Then book it so the stock actually changes.
 *
 * Products used: PRD-0013, PRD-0014 (this walk's share of the acme-corp seed) and one new article
 * per run, named with a timestamp.
 *
 * The route since FR-22 slice 3 (FR-22.28–.30), all on the receipt form:
 *  - „Към склад" comes preselected (the user's pinned warehouse, else the org's default);
 *  - picking an article adds the next line and puts the caret in its quantity;
 *  - the article the catalog does not have is created from its line („+ Нов продукт „…""), in a
 *    compact dialog, so there is no detour through Products — P2b, which measured that detour
 *    (43 clicks), is retired;
 *  - „Запази и потвърди" saves and books in one action, and the page then shows the SM- number.
 *
 * The switch „С актуализация на продукт" is clicked on, as on a user's first receipt, and the walk
 * checks afterwards (uncounted) that the next receipt remembers it.
 *
 * The acme-corp seed has no product categories. The new article lands in „Общи", which the first
 * article created from a line makes when the org has none (FR-22.30).
 *
 * The supplier is one the receipt form could NOT offer before FR-22.6 (B-8): the field loaded the
 * API's 10 newest contacts of every type and filtered only those. It now searches the server.
 */

/** Preferred supplier: the one the walks measured as unreachable through the old field. */
const SUPPLIER = 'Luxor Imports'
const WAREHOUSE = 'Main Warehouse'

/** FR-22 §3: P2 ≤ 20 clicks · ≤ 13 typed · 0 page loads. */
const BUDGET = { clicks: 20, typed: 13, hops: 0 }

type Api = Awaited<ReturnType<typeof uxApi>>

function stampNow(): string {
  return new Date().toISOString().replace(/\D/g, '').slice(2, 14)
}

function money(n: number): string {
  return String(Math.round(n * 100) / 100)
}

/** API state for the walk's articles — never counted. */
async function snapshot(api: Api, skusOrNames: string[], whId: string) {
  const out: Record<string, { id: string; sku: string; name: string; purchasePrice: number; sellingPrice: number; taxRate: number; stock: number; available: number; tiers: any[]; category: string }> = {}
  for (const key of skusOrNames) {
    const { products } = await api.get(`/warehouse/product?search=${encodeURIComponent(key)}&size=5`)
    const p = (products || []).find((x: any) => x.sku === key || x.name === key)
    if (!p) continue
    const { stockLevels } = await api.get(`/warehouse/stock-level?productId=${p._id}&warehouseId=${whId}&size=5`)
    out[key] = {
      id: p._id,
      sku: p.sku,
      name: p.name,
      purchasePrice: p.purchasePrice,
      sellingPrice: p.sellingPrice,
      taxRate: p.taxRate,
      stock: stockLevels?.[0]?.quantity ?? 0,
      available: stockLevels?.[0]?.availableQuantity ?? stockLevels?.[0]?.quantity ?? 0,
      tiers: p.priceTiers || [],
      category: p.category,
    }
  }
  return out
}

/** The receipt form's line table, and a cell by its header text. */
function lineTable(page: any) {
  return page.locator('table').filter({ has: page.locator('th', { hasText: 'Единична цена' }) })
}
async function colIndex(page: any, header: string): Promise<number> {
  const heads: string[] = await lineTable(page).locator('thead th').allInnerTexts()
  const i = heads.findIndex(h => h.trim() === header)
  if (i < 0) throw new Error(`no column "${header}" in: ${heads.join(' | ')}`)
  return i
}
function cellInput(page: any, row: number, col: number) {
  return lineTable(page).locator('tbody tr').nth(row).locator('td').nth(col).locator('input').first()
}
const isFocused = (locator: any) => locator.evaluate((el: Element) => el === document.activeElement)

/** Search an article on a receipt line; the caller picks from what it offers. */
async function searchLine(walk: any, page: any, row: number, query: string, label: string): Promise<void> {
  const search = lineTable(page).locator('tbody tr').nth(row).getByPlaceholder('Търсете продукти...')
  await walk.type(search, query, `line ${row + 1}: search ${label}`)
}

interface SupplierChoice {
  id: string
  name: string
  /** It was out of the old field's reach: not among the API's 10 newest contacts. */
  wasUnreachable: boolean
  supplierCount: number
}

/** Uncounted: which supplier the walk receives from (see the header, B-8). */
async function pickSupplier(api: Api): Promise<SupplierChoice> {
  const all: any[] = (await api.get('/invoicing/contact?size=500')).contacts || []
  const oldField = new Set(((await api.get('/invoicing/contact')).contacts || []).map((c: any) => c._id))
  const suppliers = all.filter(c => c.type === 'supplier' || c.type === 'both')
  const unreachable = suppliers.filter(c => !oldField.has(c._id))
  const chosen = unreachable.find(c => c.companyName === SUPPLIER) || unreachable[0]
    || suppliers.find(c => c.companyName === SUPPLIER) || suppliers[0]
  expect(chosen, 'a supplier to receive from').toBeTruthy()
  return { id: chosen._id, name: chosen.companyName, wasUnreachable: !oldField.has(chosen._id), supplierCount: suppliers.length }
}

/** The receipt's „Доставчик" field (a v-autocomplete) and the box Vuetify paints around it. */
function supplierField(page: any) {
  const input = page.getByRole('combobox', { name: /^Доставчик/ })
  return { input, box: input.locator('xpath=ancestor::div[contains(@class,"v-field")][1]') }
}

test('P2 receive: goods before the invoice — receipt with product update, incl. a new article', async ({ page }, testInfo) => {
  const api = await uxApi()
  const wh = (await api.get('/warehouse/warehouse?size=100')).warehouses.find((w: any) => w.name === WAREHOUSE)
  const stamp = stampNow()
  const newName = `UX P2 Article ${stamp}`
  const before = await snapshot(api, ['PRD-0013', 'PRD-0014'], wh._id)
  const target: Record<string, { qty: number; purchase: string; selling: string }> = {
    'PRD-0013': { qty: 10, purchase: money(before['PRD-0013'].purchasePrice + 1.25), selling: money(before['PRD-0013'].sellingPrice + 2.5) },
    'PRD-0014': { qty: 5, purchase: money(before['PRD-0014'].purchasePrice + 1.25), selling: money(before['PRD-0014'].sellingPrice + 2.5) },
    [newName]: { qty: 7, purchase: '12.4', selling: '19.9' },
  }
  const supplier = await pickSupplier(api)
  const orgDoc = await api.get('')
  const defaultVat = (orgDoc?.org?.settings || orgDoc?.settings)?.taxConfig?.defaultVatRate
  const pageErrors: string[] = []
  page.on('pageerror', e => pageErrors.push(e.message))

  const walk = await startWalk(page, testInfo, {
    id: 'P2',
    title: 'Receive goods before the invoice — receipt WITH product update + a new article, booked in one action',
    start: '/inventory/movements',
  })
  await walk.shot('movements-list')

  // ── The receipt ──
  const isSupplierList = (r: any) => r.request().method() === 'GET' && /\/invoicing\/contact\?/.test(r.url())
    && new URL(r.url()).searchParams.get('type') === 'supplier'
  const formContacts = page.waitForResponse(isSupplierList)
  await walk.click(page.getByRole('link', { name: 'Създай' }), 'new movement')
  await page.waitForURL(/\/movements\/new/)
  const offered: string[] = ((await (await formContacts).json()).contacts || []).map((c: any) => c.companyName)
  await expect(supplierField(page).input).toBeVisible()

  // FR-22.28: „Към склад" is preselected — the org's default warehouse, the user having pinned none.
  const toWh = page.getByRole('combobox', { name: /Към склад/ }).locator('xpath=ancestor::div[contains(@class,"v-field")][1]')
  await expect(toWh).toContainText(WAREHOUSE)
  walk.note(`„Към склад" opens as ${WAREHOUSE} (the org default; a pinned document warehouse would win) — no click.`)

  if (offered.includes(supplier.name)) {
    await walk.choose(page, /^Доставчик/, supplier.name, `Доставчик: ${supplier.name}`)
  } else {
    const fragment = supplier.name.split(' ')[0]
    await walk.type(supplierField(page).input, fragment, `Доставчик: search „${fragment}"`)
    const option = page.locator('.v-overlay--active .v-list-item').filter({ hasText: supplier.name }).first()
    await expect(option).toBeVisible()
    await walk.click(option, `Доставчик: pick ${supplier.name}`)
  }
  await expect(supplierField(page).box).toContainText(supplier.name)
  walk.note(`„Доставчик" asks the server for suppliers and offers ${offered.length} of the org's ${supplier.supplierCount}; ${supplier.name}${supplier.wasUnreachable ? ' was out of the old field\'s reach (B-8)' : ''}.`)

  // A user's first receipt: the switch is off until they turn it on once — then it is remembered.
  const chipOff = page.locator('.v-chip').filter({ hasText: 'Без актуализация на продукт' })
  await expect(chipOff).toBeVisible()
  await walk.click(chipOff.locator('input[type="checkbox"]'), 'switch on „С актуализация на продукт" (first receipt; remembered after)')
  await expect(page.locator('.v-chip').filter({ hasText: 'С актуализация на продукт' })).toBeVisible()
  await walk.shot('receipt-header')

  const qtyCol = await colIndex(page, 'Количество')
  const costCol = await colIndex(page, 'Единична цена')
  const purchaseCol = await colIndex(page, 'Доставна цена')
  const sellingCol = await colIndex(page, 'Продажна цена')

  // ── Two articles the catalog has ──
  for (const [i, sku] of ['PRD-0013', 'PRD-0014'].entries()) {
    const t = target[sku]
    expect(await lineTable(page).locator('tbody tr').count(), `line ${i + 1} is there without „Добави ред"`).toBeGreaterThan(i)
    await searchLine(walk, page, i, sku, sku)
    const option = page.locator('.v-overlay--active .v-list-item').filter({ hasText: sku }).filter({ hasNotText: 'Нов продукт' }).first()
    await expect(option).toBeVisible()
    await walk.click(option, `line ${i + 1}: pick ${sku}`)
    // The form loads the article's current values after the pick; typing earlier is overwritten.
    await expect(cellInput(page, i, sellingCol)).not.toHaveValue('')
    const qty = cellInput(page, i, qtyCol)
    await expect.poll(() => isFocused(qty), { timeout: 3000 }).toBe(true)
    await walk.fill(qty, String(t.qty), `line ${i + 1}: quantity ${t.qty}`, { focused: await isFocused(qty) })
    await walk.fill(cellInput(page, i, costCol), t.purchase, `line ${i + 1}: unit cost = new purchase price`)
    await expect(cellInput(page, i, purchaseCol)).toHaveValue(t.purchase)
    await walk.fill(cellInput(page, i, sellingCol), t.selling, `line ${i + 1}: new selling price`)
  }
  // FR-22.28: „Наличност" on a receipt reads the warehouse the goods go INTO (what is free there).
  const stockShown = (await lineTable(page).locator('tbody tr').first().locator('td').nth(1).innerText()).trim()
  expect(stockShown, '„Наличност" shows what Main Warehouse holds of PRD-0013').toBe(String(before['PRD-0013'].available))

  // ── The article the catalog does not have: created from its line ──
  expect(await lineTable(page).locator('tbody tr').count(), 'line 3 is there without „Добави ред"').toBe(3)
  await searchLine(walk, page, 2, newName, 'the new article')
  const create = page.locator('.v-overlay--active .v-list-item').filter({ hasText: `Нов продукт „${newName}“` }).first()
  await expect(create).toBeVisible()
  await walk.click(create, `line 3: „+ Нов продукт „${newName}"`)
  const dialog = page.getByTestId('quick-product-dialog')
  await expect(dialog).toBeVisible()
  walk.dialog('new article (name, unit, category „Общи", VAT and prices preset)')
  await expect(dialog.getByTestId('quick-product-name').locator('input')).toHaveValue(newName)
  const purchaseIn = dialog.getByTestId('quick-product-purchase').locator('input')
  await expect.poll(() => isFocused(purchaseIn), { timeout: 3000 }).toBe(true)
  await walk.shot('new-article-dialog')
  await walk.fill(purchaseIn, target[newName].purchase, 'new article: purchase price', { focused: await isFocused(purchaseIn) })
  await walk.fill(dialog.getByTestId('quick-product-selling').locator('input'), target[newName].selling, 'new article: selling price')
  await walk.click(dialog.getByTestId('quick-product-create'), 'create the article')
  await expect(dialog).toBeHidden()
  await expect(cellInput(page, 2, costCol)).toHaveValue(target[newName].purchase)
  await expect(cellInput(page, 2, sellingCol)).toHaveValue(target[newName].selling)
  const qty3 = cellInput(page, 2, qtyCol)
  await expect.poll(() => isFocused(qty3), { timeout: 3000 }).toBe(true)
  await walk.fill(qty3, String(target[newName].qty), `line 3: quantity ${target[newName].qty}`, { focused: await isFocused(qty3) })

  // FR-22.28: the line table fits a 1366 px screen, product-update columns included.
  const overflow = await lineTable(page).evaluate((t: HTMLElement) => {
    const box = t.closest('.overflow-x-auto') as HTMLElement | null
    return box ? { scroll: box.scrollWidth, client: box.clientWidth } : null
  })
  walk.note(`Line table at 1366 px: ${overflow?.scroll} px of content in a ${overflow?.client} px box.`)
  expect(overflow!.scroll, 'the line table needs no sideways scroll at 1366 px').toBeLessThanOrEqual(overflow!.client + 4)
  await walk.shot('receipt-filled')

  // ── Book it: one action ──
  const created = page.waitForResponse((r: any) => /\/warehouse\/movement\/with-update$/.test(r.url()) && r.request().method() === 'POST')
  const confirmed = page.waitForResponse((r: any) => /\/warehouse\/movement\/[0-9a-f]{24}\/confirm$/.test(r.url()))
  await walk.click(page.locator('.form-actions-bar').getByRole('button', { name: 'Запази и потвърди' }), 'save and confirm (book the stock)')
  const createRes = await created
  expect(createRes.status(), `save: ${await createRes.text()}`).toBeLessThan(400)
  expect((await confirmed).status()).toBeLessThan(400)
  const movementId = (await createRes.json()).stockMovement?._id
  await page.waitForURL(/\/movements\/[0-9a-f]{24}$/)
  await expect(page.locator('.v-snackbar').filter({ hasText: 'Успешно завършено' })).toBeVisible()
  // FR-22.29: the page names the receipt by its number, and its pipeline reads in Bulgarian.
  await expect(page.locator('.form-header-bar')).toContainText(/SM-\d{4}-\d+/)
  const chips = (await page.locator('.form-actions-bar .v-chip').allInnerTexts()).map(s => s.trim()).filter(Boolean)
  expect(chips, 'the movement\'s status pipeline').toEqual(['Чернова', 'Потвърдена', 'Завършена'])
  await walk.shot('receipt-completed')

  const result = walk.finish()

  // ── Uncounted checks ──
  const after = await snapshot(api, ['PRD-0013', 'PRD-0014', newName], wh._id)
  const mv = await api.get(`/warehouse/movement/${movementId}`)
  const extra: string[] = []
  extra.push(`Receipt ${mv?.stockMovement?.movementNumber}: ${mv?.stockMovement?.status}, supplier ${supplier.name}.`)
  extra.push(`Stock (API): PRD-0013 ${before['PRD-0013'].stock} → ${after['PRD-0013'].stock}, PRD-0014 ${before['PRD-0014'].stock} → ${after['PRD-0014'].stock}, new article ${after[newName]?.stock}.`)
  extra.push(`Prices (API): PRD-0013 purchase ${before['PRD-0013'].purchasePrice} → ${after['PRD-0013'].purchasePrice}, selling ${before['PRD-0013'].sellingPrice} → ${after['PRD-0013'].sellingPrice}; new article ${after[newName]?.sku}: purchase ${after[newName]?.purchasePrice}, selling ${after[newName]?.sellingPrice}, VAT ${after[newName]?.taxRate} % (org default ${defaultVat} %), category ${after[newName]?.category}, ${after[newName]?.tiers.length} price-tier slots.`)

  // The next receipt starts with the switch on: it was remembered (FR-22.28).
  await page.goto('/inventory/movements/new', { waitUntil: 'networkidle' })
  const remembered = await page.locator('.v-chip').filter({ hasText: 'С актуализация на продукт' }).isVisible()
  extra.push(`Next receipt: „С актуализация на продукт" opens ${remembered ? 'ON — remembered, so a daily user does not pay the switch\'s click' : 'OFF'}.`)

  result.notes.push(...extra)
  writeFileSync(join(testInfo.project.outputDir, 'ux-budgets', 'P2', 'result.json'), JSON.stringify(result, null, 2))
  console.log(extra.join('\n'))

  // FR-22 §3 budget, and what the route must have done.
  expect(result.clicks, 'P2 clicks').toBeLessThanOrEqual(BUDGET.clicks)
  expect(result.typed, 'P2 typed').toBeLessThanOrEqual(BUDGET.typed)
  expect(result.hops, 'P2 page loads').toBeLessThanOrEqual(BUDGET.hops)
  expect(mv?.stockMovement?.status).toBe('completed')
  expect(mv?.stockMovement?.contactId, 'the receipt stores the supplier picked in „Доставчик"').toBe(supplier.id)
  expect(after['PRD-0013'].stock - before['PRD-0013'].stock).toBe(10)
  expect(after['PRD-0014'].stock - before['PRD-0014'].stock).toBe(5)
  expect(after[newName]?.stock).toBe(7)
  expect(String(after['PRD-0013'].purchasePrice)).toBe(target['PRD-0013'].purchase)
  expect(String(after['PRD-0013'].sellingPrice)).toBe(target['PRD-0013'].selling)
  expect([String(after[newName]?.purchasePrice), String(after[newName]?.sellingPrice)]).toEqual([target[newName].purchase, target[newName].selling])
  expect(after[newName]?.taxRate, 'a new article starts at the org default VAT').toBe(defaultVat)
  expect(after[newName]?.category).toBe('Общи')
  expect(remembered, 'the product-update switch is remembered').toBe(true)
  expect(pageErrors, 'no page errors').toEqual([])
})
