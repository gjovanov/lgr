import { test, expect } from '@playwright/test'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { startWalk, signInForUx, uxApi } from '../helpers/ux-budget'

/**
 * P2 — Goods arrive before the supplier's invoice. Book a receipt into Main Warehouse from a
 * supplier, with product update: two existing articles (PRD-0013 ×10, PRD-0014 ×5), each with a
 * new purchase and selling price, plus one article that is not in the catalog yet (×7, with
 * purchase and selling price). Then book it so the stock actually changes.
 *
 * Products used: PRD-0013, PRD-0014 (this walk's share of the acme-corp seed) and one new article
 * per run, named with a timestamp.
 *
 * Two walks:
 *  - P2  — the job the way the receipt form offers it: the new article first (the form cannot
 *          create one), then the receipt WITH „С актуализация на продукт". Until FR-22 B-1 Save
 *          refused that (422) and the walk ended there; it now asserts the receipt saves and books.
 *  - P2b — the shortest route that works today, for a user who already knows the switch fails:
 *          the three articles' prices in Products first, then a plain receipt, then „Потвърди".
 *
 * Setup (uncounted): the acme-corp seed has NO product categories, and the API refuses an article
 * without one. Regal has categories, so the walks run against one created here ("UX Общи").
 *
 * The supplier is one the receipt form could NOT offer before FR-22.6 (B-8): the field loaded the
 * API's 10 newest contacts of every type and filtered only those, so three of the seed's eight
 * suppliers were out of reach. It now searches the server for suppliers, and both walks assert
 * that such a supplier is offered, picked and (when the receipt saves) stored.
 */

/** Preferred supplier: the one the walks measured as unreachable through the old field. */
const SUPPLIER = 'Luxor Imports'
const WAREHOUSE = 'Main Warehouse'
const CATEGORY = 'UX Общи'
const MOVEMENTS_MENU = 'Документи за движение на стоки'

type Api = Awaited<ReturnType<typeof uxApi>>

function stampNow(): string {
  return new Date().toISOString().replace(/\D/g, '').slice(2, 14)
}

function money(n: number): string {
  return String(Math.round(n * 100) / 100)
}

/** API state for the walk's articles — never counted. */
async function snapshot(api: Api, skus: string[], whId: string) {
  const out: Record<string, { id: string; name: string; purchasePrice: number; sellingPrice: number; taxRate: number; stock: number; tiers: any[]; category: string }> = {}
  for (const sku of skus) {
    const { products } = await api.get(`/warehouse/product?search=${encodeURIComponent(sku)}&size=5`)
    const p = (products || []).find((x: any) => x.sku === sku)
    if (!p) continue
    const { stockLevels } = await api.get(`/warehouse/stock-level?productId=${p._id}&warehouseId=${whId}&size=5`)
    out[sku] = {
      id: p._id,
      name: p.name,
      purchasePrice: p.purchasePrice,
      sellingPrice: p.sellingPrice,
      taxRate: p.taxRate,
      stock: stockLevels?.[0]?.quantity ?? 0,
      tiers: p.priceTiers || [],
      category: p.category,
    }
  }
  return out
}

/** Uncounted setup: one product category, so an article can be saved at all. */
async function ensureCategory(api: Api): Promise<string> {
  const { productCategories } = await api.get('/warehouse/product-category?size=0')
  if ((productCategories || []).some((c: any) => c.name === CATEGORY)) {
    return `Setup (uncounted): product category "${CATEGORY}" exists — made by an earlier run of these walks; the acme-corp seed has none.`
  }
  const others = (productCategories || []).length
  await api.post('/warehouse/product-category', { name: CATEGORY })
  return `Setup (uncounted): created product category "${CATEGORY}" — the org had ${others}.`
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

/** Pick an article on a receipt line through the line's search box. */
async function pickProduct(walk: any, page: any, row: number, query: string, label: string): Promise<void> {
  const search = lineTable(page).locator('tbody tr').nth(row).getByPlaceholder('Търсете продукти...')
  await walk.type(search, query, `line ${row + 1}: search ${label}`)
  const option = page.locator('.v-overlay--active .v-list-item').filter({ hasText: query }).first()
  await expect(option).toBeVisible()
  await walk.click(option, `line ${row + 1}: pick ${label}`)
}

/** New article through Products (the receipt form cannot create one). */
async function createArticle(walk: any, page: any, sku: string, name: string, prices?: { purchase: string; selling: string }): Promise<void> {
  await walk.menu('Продукти', 'Продукти')
  await page.waitForURL(/\/inventory\/products(\?.*)?$/)
  await walk.click(page.getByRole('link', { name: 'Създай' }), 'new article')
  await page.waitForURL(/\/products\/new\/edit/)
  await expect(page.getByLabel('SKU', { exact: true })).toBeVisible()
  await walk.shot('new-article-form')
  await walk.fill(page.getByLabel('SKU', { exact: true }), sku, 'SKU of the new article')
  await walk.fill(page.getByLabel('Име', { exact: true }), name, 'name of the new article')
  await walk.choose(page, /Категория/, CATEGORY, `Категория: ${CATEGORY} (the API refuses an article without one)`)
  if (prices) {
    await walk.click(page.getByRole('tab', { name: /^Цени$/ }), 'prices tab')
    await page.waitForURL(/\/products\/new\/pricing/)
    await walk.fill(page.getByLabel('Покупна цена', { exact: true }), prices.purchase, 'new article: purchase price')
    await walk.fill(page.getByLabel('Продажна цена', { exact: true }), prices.selling, 'new article: selling price')
  }
  await walk.click(page.getByRole('button', { name: 'Запази' }), 'save the article')
  await page.waitForURL(/\/products\/[0-9a-f]{24}\/(edit|pricing)/)
  await expect(page.locator('.v-snackbar').filter({ hasText: 'Успешно запазено' })).toBeVisible()
  await walk.shot('article-saved')
}

/** Set an existing article's purchase + selling price in Products. */
async function setPrices(walk: any, page: any, sku: string, name: string, current: number, prices: { purchase: string; selling: string }): Promise<void> {
  await walk.menu('Продукти', 'Продукти')
  await page.waitForURL(/\/inventory\/products(\?.*)?$/)
  const searchBox = page.getByRole('textbox', { name: /Търсене/ })
  let focused = false
  const remembered = await searchBox.inputValue()
  if (remembered) {
    // FR-05: the list restores its last query, so the previous article's SKU is still there.
    if (!walk.notes.some((n: string) => n.startsWith('Products list remembers'))) {
      walk.note(`Products list remembers its last search (FR-05, by design): back through the menu the box still reads "${remembered}", so every further article costs a click on the clear (×) icon before typing.`)
    }
    await walk.click(page.getByRole('button', { name: 'Изчисти Търсене' }), 'clear the remembered search')
    focused = await searchBox.evaluate((el: Element) => el === document.activeElement)
  }
  await walk.type(searchBox, sku, `search ${sku}`, { focused })
  const row = page.locator('tbody tr').filter({ hasText: sku })
  await expect(row).toBeVisible()
  await walk.click(row.getByRole('link', { name }), `open ${sku}`)
  await page.waitForURL(/\/products\/[0-9a-f]{24}\/edit/)
  await walk.click(page.getByRole('tab', { name: /^Цени$/ }), `${sku}: prices tab`)
  await page.waitForURL(/\/pricing$/)
  const purchase = page.getByLabel('Покупна цена', { exact: true })
  await expect(purchase).toHaveValue(String(current)) // the article has loaded
  await walk.fill(purchase, prices.purchase, `${sku}: purchase price`)
  await walk.fill(page.getByLabel('Продажна цена', { exact: true }), prices.selling, `${sku}: selling price`)
  await walk.click(page.getByRole('button', { name: 'Запази' }), `${sku}: save`)
  await expect(page.locator('.v-snackbar').filter({ hasText: 'Успешно запазено' })).toBeVisible()
}

interface SupplierChoice {
  id: string
  name: string
  /** It was out of the old field's reach: not among the API's 10 newest contacts. */
  wasUnreachable: boolean
  unreachableBefore: string[]
  supplierCount: number
}

/**
 * Uncounted: which supplier the walk receives from. Before FR-22.6 the receipt's partner field
 * loaded `GET /invoicing/contact` with no size — the API's 10 newest contacts of every type — and
 * filtered only those, so a supplier outside them could not be picked at all (B-8). The walk
 * takes SUPPLIER when it is such a one, else the first that is, so it proves the fix every run.
 */
async function pickSupplier(api: Api): Promise<SupplierChoice> {
  const all: any[] = (await api.get('/invoicing/contact?size=500')).contacts || []
  const oldField = new Set(((await api.get('/invoicing/contact')).contacts || []).map((c: any) => c._id))
  const suppliers = all.filter(c => c.type === 'supplier' || c.type === 'both')
  const unreachable = suppliers.filter(c => !oldField.has(c._id))
  const chosen = unreachable.find(c => c.companyName === SUPPLIER) || unreachable[0]
    || suppliers.find(c => c.companyName === SUPPLIER) || suppliers[0]
  expect(chosen, 'a supplier to receive from').toBeTruthy()
  return {
    id: chosen._id,
    name: chosen.companyName,
    wasUnreachable: !oldField.has(chosen._id),
    unreachableBefore: unreachable.map(c => c.companyName),
    supplierCount: suppliers.length,
  }
}

/** The receipt's „Доставчик" field (a v-autocomplete) and the box Vuetify paints around it. */
function supplierField(page: any) {
  const input = page.getByRole('combobox', { name: /^Доставчик/ })
  return { input, box: input.locator('xpath=ancestor::div[contains(@class,"v-field")][1]') }
}

/**
 * From any inventory page: the movements list, then a new movement. Checks, uncounted, what the
 * receipt's „Доставчик" field asks the server for (B-8: suppliers only, never a fixed page).
 */
async function openNewMovement(walk: any, page: any, choice: SupplierChoice): Promise<{ offered: string[]; note: string }> {
  const isSupplierList = (r: any) => r.request().method() === 'GET' && /\/invoicing\/contact\?/.test(r.url())
    && new URL(r.url()).searchParams.get('type') === 'supplier'
  await walk.menu('Склад', MOVEMENTS_MENU)
  await page.waitForURL(/\/inventory\/movements(\?.*)?$/)
  const formContacts = page.waitForResponse(isSupplierList)
  await walk.click(page.getByRole('link', { name: 'Създай' }), 'new movement')
  await page.waitForURL(/\/movements\/new/)
  const res = await formContacts
  const listed: any[] = (await res.json()).contacts || []
  const customers = listed.filter(c => c.type !== 'supplier' && c.type !== 'both').map(c => c.companyName)
  expect(customers, 'a receipt\'s „Доставчик" lists customers').toEqual([])
  await expect(supplierField(page).input).toBeVisible()
  const offered = listed.map(c => c.companyName)
  const size = new URL(res.url()).searchParams.get('size')
  const note = `„Доставчик" (FR-22.6): the field asks the server for suppliers (GET /invoicing/contact?type=supplier&size=${size}) and opens with ${offered.length} of the org's ${choice.supplierCount} supplier-capable contacts, no customers; typing searches the server. `
    + (choice.wasUnreachable
      ? `${choice.name} is picked: the old field could not reach it (it loaded the API's 10 newest contacts of every type; also out of reach then: ${choice.unreachableBefore.filter(n => n !== choice.name).join(', ') || 'none'}).`
      : `Every supplier of this org is among its 10 newest contacts, so the old field could reach ${choice.name} too.`)
  return { offered, note }
}

/** Pick the walk's supplier: from the list when it opens with it, else by typing its name. */
async function chooseSupplier(walk: any, page: any, choice: SupplierChoice, offered: string[]): Promise<void> {
  if (offered.includes(choice.name)) {
    await walk.choose(page, /^Доставчик/, choice.name, `Доставчик: ${choice.name}`)
  } else {
    const fragment = choice.name.split(' ')[0]
    await walk.type(supplierField(page).input, fragment, `Доставчик: search „${fragment}"`)
    const option = page.locator('.v-overlay--active .v-list-item').filter({ hasText: choice.name }).first()
    await expect(option).toBeVisible()
    await walk.click(option, `Доставчик: pick ${choice.name}`)
  }
  await expect(supplierField(page).box).toContainText(choice.name)
}

/** Uncounted, in its own browser context: can the receipt form create an article, and what does an article without a category get? */
async function probe(browser: any, baseURL: string, stamp: string, supplier: SupplierChoice): Promise<string[]> {
  const ctx = await browser.newContext({ baseURL, viewport: { width: 1366, height: 768 } })
  const p = await ctx.newPage()
  const notes: string[] = []
  try {
    await signInForUx(p)
    await p.goto('/inventory/movements/new', { waitUntil: 'networkidle' })

    // FR-22.6 (B-8): typing in „Доставчик" asks the server, suppliers only, and finds the supplier.
    const fragment = supplier.name.split(' ')[0].slice(0, 4)
    const asked = p.waitForResponse((r: any) => /\/invoicing\/contact\?/.test(r.url())
      && new URL(r.url()).searchParams.get('search') === fragment)
    const field = supplierField(p)
    await field.box.click()
    await field.input.pressSequentially(fragment, { delay: 20 })
    const res = await asked
    expect(new URL(res.url()).searchParams.get('type'), 'the supplier search is limited to suppliers').toBe('supplier')
    const found: string[] = ((await res.json()).contacts || []).map((c: any) => c.companyName)
    expect(found, `searching „${fragment}" finds ${supplier.name}`).toContain(supplier.name)
    await expect(p.locator('.v-overlay--active .v-list-item').filter({ hasText: supplier.name }).first()).toBeVisible()
    notes.push(`Verified: typing „${fragment}" in „Доставчик" searches the server (GET /invoicing/contact?search=${fragment}&type=supplier) and offers ${supplier.name}.`)
    await p.keyboard.press('Escape')

    const search = p.getByPlaceholder('Търсете продукти...').first()
    await search.click()
    await search.pressSequentially(`Brand new ${stamp}`, { delay: 20 })
    const menu = p.locator('.v-overlay--active').filter({ hasText: 'Няма намерени продукти' })
    await expect(menu).toBeVisible()
    const menuText = (await menu.innerText()).replace(/\s+/g, ' ').trim()
    await p.keyboard.press('Escape')
    await p.getByTitle('Разгледайте продукти').first().click()
    const dialog = p.locator('.v-dialog').filter({ hasText: 'Търсете продукти...' }).last()
    await expect(dialog).toBeVisible()
    const dialogButtons = (await dialog.getByRole('button').allInnerTexts()).map(s => s.trim()).filter(Boolean)
    const canCreate = /създа|нов /i.test(menuText) || dialogButtons.some(b => /създа|нов/i.test(b))
    notes.push(canCreate
      ? `Receipt form: an inline create option WAS found (menu "${menuText}", dialog buttons: ${dialogButtons.join(', ')}).`
      : `Verified: the receipt form cannot create an article — a line search for an unknown name shows only "${menuText}" and the browse dialog has no create button. Hence the detour through Products.`)

    // An article saved without a category (nothing is created: the API refuses it).
    await p.goto('/inventory/products/new/edit', { waitUntil: 'networkidle' })
    await p.getByLabel('SKU', { exact: true }).fill(`UX-PROBE-${stamp}`)
    await p.getByLabel('Име', { exact: true }).fill(`UX probe ${stamp}`)
    await p.getByRole('button', { name: 'Запази' }).click()
    const bar = p.locator('.v-snackbar .v-snackbar__content')
    await expect(bar).toBeVisible()
    const shown = (await bar.innerText()).replace(/\s+/g, ' ').trim()
    notes.push(`New article: Категория is required by the API but not marked on the form; Save without it shows the English "${shown}". The acme-corp seed ships no categories at all, so in that org no article can be created from the UI until one exists (detour Продукти → Категории → Създай, not counted) — the walks run against a setup category.`)
  } finally {
    await ctx.close()
  }
  return notes
}

/** Notes that need the API, written into the result after the walk (they are not user actions). */
function appendNotes(testInfo: any, id: string, result: any, extra: string[]): void {
  result.notes.push(...extra)
  writeFileSync(join(testInfo.project.outputDir, 'ux-budgets', id, 'result.json'), JSON.stringify(result, null, 2))
  console.log(extra.join('\n'))
}

test('P2 receive: goods before the invoice — receipt with product update, incl. a new article', async ({ page, browser }, testInfo) => {
  const api = await uxApi()
  const setupNote = await ensureCategory(api)
  const wh = (await api.get('/warehouse/warehouse?size=100')).warehouses.find((w: any) => w.name === WAREHOUSE)
  const stamp = stampNow()
  const newSku = `UX-P2-${stamp}`
  const newName = `UX P2 Article ${stamp}`
  const before = await snapshot(api, ['PRD-0013', 'PRD-0014'], wh._id)
  const target: Record<string, { qty: number; purchase: string; selling: string }> = {
    'PRD-0013': { qty: 10, purchase: money(before['PRD-0013'].purchasePrice + 1.25), selling: money(before['PRD-0013'].sellingPrice + 2.5) },
    'PRD-0014': { qty: 5, purchase: money(before['PRD-0014'].purchasePrice + 1.25), selling: money(before['PRD-0014'].sellingPrice + 2.5) },
    [newSku]: { qty: 7, purchase: '12.4', selling: '19.9' },
  }
  const supplier = await pickSupplier(api)
  const probeNotes = await probe(browser, testInfo.project.use.baseURL as string, stamp, supplier)
  const pageErrors: string[] = []
  page.on('pageerror', e => pageErrors.push(e.message))
  page.on('console', m => { if (m.type() === 'error') pageErrors.push(m.text()) })

  const walk = await startWalk(page, testInfo, {
    id: 'P2',
    title: 'Receive goods before the invoice — receipt WITH product update + a new article (as the form offers it)',
    start: '/inventory/movements',
  })
  walk.note(setupNote)
  for (const n of probeNotes) walk.note(n)
  await walk.shot('movements-list')

  // ── Detour: the new article has to exist before a receipt line can name it ──
  // Its prices are left to the receipt's product-update columns: the receipt line needs the
  // unit cost anyway, so that is the shorter route (and the one the switch exists for).
  await createArticle(walk, page, newSku, newName)
  // FR-22.11 (B-14): the message bar used to close with a hard-coded English „Close", and the
  // article's type read as the stored „goods".
  const closeLabel = (await page.locator('.v-snackbar .v-snackbar__actions').first().innerText()).trim()
  expect(closeLabel, 'the message bar closes in Bulgarian').toMatch(/^затвори$/i)
  const typeShown = (await page.locator('.v-select').filter({ hasText: 'Тип' }).first().locator('.v-select__selection').innerText()).trim()
  expect(typeShown, 'the new article\'s Тип').toBe('Стока')
  walk.note('New-article form: SKU is required and nothing suggests the next one.')

  // ── The receipt ──
  const { offered, note: supplierNote } = await openNewMovement(walk, page, supplier)
  walk.note(supplierNote)
  const toWhShown = (await page.getByRole('combobox', { name: /Към склад/ }).locator('xpath=ancestor::div[contains(@class,"v-field")][1]').innerText()).trim()
  if (!/Main Warehouse/.test(toWhShown)) walk.note('Receipt form: type defaults to Заприходяване, but „Към склад" starts empty — the org default warehouse is not preselected (the bill form does preselect it).')
  await walk.choose(page, /Към склад/, WAREHOUSE, 'Към склад: Main Warehouse')
  await chooseSupplier(walk, page, supplier, offered)

  const chipOff = page.locator('.v-chip').filter({ hasText: 'Без актуализация на продукт' })
  await expect(chipOff).toBeVisible()
  walk.note('„С актуализация на продукт" defaults OFF: one more click on every receipt that carries prices.')
  await walk.click(chipOff.locator('input[type="checkbox"]'), 'switch on „С актуализация на продукт"')
  await expect(page.locator('.v-chip').filter({ hasText: 'С актуализация на продукт' })).toBeVisible()
  await walk.shot('receipt-header')

  const qtyCol = await colIndex(page, 'Количество')
  const costCol = await colIndex(page, 'Единична цена')
  const purchaseCol = await colIndex(page, 'Доставна цена')
  const sellingCol = await colIndex(page, 'Продажна цена')

  const lines: Array<[string, string]> = [['PRD-0013', 'PRD-0013'], ['PRD-0014', 'PRD-0014'], [newSku, 'the new article']]
  for (let i = 0; i < lines.length; i++) {
    const [sku, label] = lines[i]
    const t = target[sku]
    if (i > 0) {
      if (i === 1 && (await lineTable(page).locator('tbody tr').count()) === 1) {
        walk.note('Picking an article does not add the next line: every further line costs a click on „Добави ред" (the bill form adds one by itself).')
      }
      await walk.click(page.getByRole('button', { name: 'Добави ред' }), 'add a line')
    }
    await pickProduct(walk, page, i, sku, label)
    // The form loads the article's current values after the pick; typing earlier is overwritten.
    await expect(cellInput(page, i, sellingCol)).not.toHaveValue('')
    await walk.fill(cellInput(page, i, qtyCol), String(t.qty), `line ${i + 1}: quantity ${t.qty}`)
    await walk.fill(cellInput(page, i, costCol), t.purchase, `line ${i + 1}: unit cost = new purchase price`)
    await expect(cellInput(page, i, purchaseCol)).toHaveValue(t.purchase)
    await walk.fill(cellInput(page, i, sellingCol), t.selling, `line ${i + 1}: new selling price`)
  }
  walk.note('Typing the unit cost also fills „Доставна цена", so a price change costs two fields per line, not three. A line has no VAT field: the new article keeps the form default (see the API check).')
  const overflow = await lineTable(page).evaluate((t: HTMLElement) => {
    const box = t.closest('.overflow-x-auto') as HTMLElement | null
    return box ? { scroll: box.scrollWidth, client: box.clientWidth } : null
  })
  if (overflow && overflow.scroll > overflow.client + 4) walk.note(`At 1366 px the line table is ${overflow.scroll} px wide in a ${overflow.client} px box: „Продукт" alone is min-width 50vw, so with the update columns on, the user scrolls sideways between an article and its prices (Цена 1–3 start off-screen).`)
  const stockShown = (await lineTable(page).locator('tbody tr').first().locator('td').nth(1).innerText()).trim()
  if (stockShown === '—') walk.note('„Наличност" shows — on every receipt line: it reads the „От склад" warehouse, which a receipt does not have, so the user never sees what Main Warehouse holds.')
  await walk.shot('receipt-filled')

  const updateSave = page.waitForResponse((r: any) => /\/warehouse\/movement\/with-update/.test(r.url()))
  await walk.click(page.getByRole('button', { name: 'Запази' }), 'save the receipt (with update)')
  const updateRes = await updateSave
  let movementId = ''
  if (updateRes.status() >= 400) {
    const body = await updateRes.json().catch(() => ({}))
    await expect(page.locator('.v-snackbar .v-snackbar__content')).toBeVisible()
    const shown = (await page.locator('.v-snackbar .v-snackbar__content').innerText()).replace(/\s+/g, ' ').trim()
    await walk.shot('save-refused')
    walk.note(`DEAD END at Save: HTTP ${updateRes.status()}, the user reads "${shown}" (English, names a product id). The form sends 13 price-tier slots per line (MAX_PRICE_TIERS = 13, as the Product model allows) whenever a slot holds a price; the server's sanitizeProductUpdates still caps priceTiers at 10. Every article with a selling price trips it, so the switch is unusable. Nothing was saved: no movement, no price change.`)
    walk.note('Instead: switch the update off, Save, „Потвърди", then set each article\'s prices in Products — or, shorter, the prices first and a plain receipt whose lines inherit the unit cost (measured as P2b). Had Save worked, the receipt would still be a draft needing „Потвърди".')
  } else {
    movementId = (await updateRes.json()).stockMovement?._id
    await page.waitForURL(/\/movements\/[0-9a-f]{24}$/)
    await walk.click(page.getByRole('button', { name: 'Потвърди' }), 'confirm (book the stock)')
    await expect(page.locator('.v-snackbar').filter({ hasText: 'Успешно завършено' })).toBeVisible()
    await walk.shot('receipt-completed')
  }

  const result = walk.finish()

  // ── Uncounted checks ──
  const after = await snapshot(api, ['PRD-0013', 'PRD-0014', newSku], wh._id)
  const extra: string[] = []
  const tierErr = pageErrors.find(e => /ensureTenTiers/.test(e))
  if (tierErr) extra.push(`New-article form throws on load ("${tierErr.split('\n')[0]}", ProductFormView calls a function that does not exist), so its price-tier table stays empty and the article is saved with no tier slots.`)
  extra.push(`API after the walk: PRD-0013 stock ${before['PRD-0013'].stock} → ${after['PRD-0013'].stock}, purchase ${before['PRD-0013'].purchasePrice} → ${after['PRD-0013'].purchasePrice}, selling ${before['PRD-0013'].sellingPrice} → ${after['PRD-0013'].sellingPrice}; PRD-0014 stock ${before['PRD-0014'].stock} → ${after['PRD-0014'].stock}; new article stock ${after[newSku]?.stock ?? 'n/a'}, purchase ${after[newSku]?.purchasePrice}, selling ${after[newSku]?.sellingPrice}, VAT ${after[newSku]?.taxRate} % (the org default is 18 %, PRD-0013 carries ${after['PRD-0013'].taxRate} %).`)
  if (movementId) {
    const mv = await api.get(`/warehouse/movement/${movementId}`)
    extra.push(`Movement ${mv?.stockMovement?.movementNumber}: status ${mv?.stockMovement?.status}, supplier ${supplier.name}.`)
    expect(mv?.stockMovement?.contactId, 'the receipt stores the supplier picked in „Доставчик"').toBe(supplier.id)
  }
  appendNotes(testInfo, 'P2', result, extra)
  expect(result.clicks).toBeGreaterThan(0)

  // FR-22 slice 1 guards: the receipt saves and books (B-1), the new-article form loads cleanly
  // (B-2), and the new article starts at the org's default VAT rate (B-3).
  expect(updateRes.status(), 'B-1: a receipt with product update saves').toBeLessThan(400)
  expect(after['PRD-0013'].stock - before['PRD-0013'].stock, 'B-1: the receipt booked PRD-0013 ×10').toBe(10)
  expect(tierErr, 'B-2: the new-article form loads without a ReferenceError').toBeUndefined()
  const orgDoc = await api.get('')
  const defaultVat = (orgDoc?.org?.settings || orgDoc?.settings)?.taxConfig?.defaultVatRate
  expect(after[newSku]?.taxRate, 'B-3: a new article starts at the org default VAT').toBe(defaultVat)
})

test('P2b receive: the shortest route that works today — prices in Products first, then a plain receipt', async ({ page, browser }, testInfo) => {
  const api = await uxApi()
  const setupNote = await ensureCategory(api)
  const wh = (await api.get('/warehouse/warehouse?size=100')).warehouses.find((w: any) => w.name === WAREHOUSE)
  const stamp = stampNow()
  const newSku = `UX-P2B-${stamp}`
  const newName = `UX P2b Article ${stamp}`
  const before = await snapshot(api, ['PRD-0013', 'PRD-0014'], wh._id)
  const target: Record<string, { qty: number; purchase: string; selling: string }> = {
    'PRD-0013': { qty: 10, purchase: money(before['PRD-0013'].purchasePrice + 1.25), selling: money(before['PRD-0013'].sellingPrice + 2.5) },
    'PRD-0014': { qty: 5, purchase: money(before['PRD-0014'].purchasePrice + 1.25), selling: money(before['PRD-0014'].sellingPrice + 2.5) },
    [newSku]: { qty: 7, purchase: '12.4', selling: '19.9' },
  }
  const supplier = await pickSupplier(api)
  const pageErrors: string[] = []
  page.on('pageerror', e => pageErrors.push(e.message))
  page.on('console', m => { if (m.type() === 'error') pageErrors.push(m.text()) })

  const walk = await startWalk(page, testInfo, {
    id: 'P2b',
    title: 'Receive goods before the invoice — shortest working route today (prices in Products, plain receipt, confirm)',
    start: '/inventory/movements',
  })
  walk.note(setupNote)
  walk.note('Route: the switch „С актуализация на продукт" fails (see P2), so prices go through Products first; the receipt lines then inherit the new purchase price as their unit cost.')
  await walk.shot('movements-list')

  // ── Prices first, article by article ──
  await setPrices(walk, page, 'PRD-0013', before['PRD-0013'].name, before['PRD-0013'].purchasePrice, target['PRD-0013'])
  await walk.shot('prd-0013-priced')
  await setPrices(walk, page, 'PRD-0014', before['PRD-0014'].name, before['PRD-0014'].purchasePrice, target['PRD-0014'])
  await createArticle(walk, page, newSku, newName, target[newSku])

  // ── The receipt ──
  const { offered, note: supplierNote } = await openNewMovement(walk, page, supplier)
  walk.note(supplierNote)
  await walk.choose(page, /Към склад/, WAREHOUSE, 'Към склад: Main Warehouse')
  await chooseSupplier(walk, page, supplier, offered)

  const qtyCol = await colIndex(page, 'Количество')
  const costCol = await colIndex(page, 'Единична цена')
  const lines: Array<[string, string]> = [['PRD-0013', 'PRD-0013'], ['PRD-0014', 'PRD-0014'], [newSku, 'the new article']]
  for (let i = 0; i < lines.length; i++) {
    const [sku, label] = lines[i]
    const t = target[sku]
    if (i > 0) await walk.click(page.getByRole('button', { name: 'Добави ред' }), 'add a line')
    await pickProduct(walk, page, i, sku, label)
    await walk.fill(cellInput(page, i, qtyCol), String(t.qty), `line ${i + 1}: quantity ${t.qty}`)
    const cost = cellInput(page, i, costCol)
    try {
      await expect(cost).toHaveValue(t.purchase, { timeout: 3000 })
    } catch {
      walk.note(`Line ${i + 1}: the unit cost did not come prefilled with the article's new purchase price (${t.purchase}); typed.`)
      await walk.fill(cost, t.purchase, `line ${i + 1}: unit cost`)
    }
  }
  await walk.shot('receipt-filled')

  const plainSave = page.waitForResponse((r: any) => /\/warehouse\/movement$/.test(r.url()) && r.request().method() === 'POST')
  await walk.click(page.getByRole('button', { name: 'Запази' }), 'save the receipt')
  const saved = await plainSave
  expect(saved.status(), `receipt save: ${await saved.text()}`).toBeLessThan(400)
  const movementId = (await saved.json()).stockMovement?._id
  await page.waitForURL(/\/movements\/[0-9a-f]{24}$/)
  await expect(page.getByRole('button', { name: 'Потвърди' })).toBeVisible()
  const mid = await snapshot(api, ['PRD-0013'], wh._id)
  if (mid['PRD-0013'].stock === before['PRD-0013'].stock) walk.note('Save leaves a DRAFT — the stock has not moved; a separate „Потвърди" books it (no prompt either way).')
  const header = (await page.locator('.form-header-bar').innerText()).replace(/\s+/g, ' ').trim()
  if (!/SM-\d{4}-\d+/.test(header)) walk.note(`After Save the receipt page never shows its number: the header reads "${header}" (the SM-… number is only on the list), so the user has nothing to match the supplier's invoice against later.`)
  await walk.shot('draft-saved')
  await walk.click(page.getByRole('button', { name: 'Потвърди' }), 'confirm (book the stock)')
  await expect(page.locator('.v-snackbar').filter({ hasText: 'Успешно завършено' })).toBeVisible()
  // FR-22.11 (B-14): the pipeline read „draft → confirmed → completed" in every language.
  const chips = (await page.locator('.form-actions-bar .v-chip').allInnerTexts()).map(s => s.trim()).filter(Boolean)
  expect(chips, 'the movement\'s status pipeline').toEqual(['Чернова', 'Потвърдена', 'Завършена'])
  await walk.shot('receipt-completed')

  const result = walk.finish()

  // ── Uncounted checks ──
  const after = await snapshot(api, ['PRD-0013', 'PRD-0014', newSku], wh._id)
  const mv = await api.get(`/warehouse/movement/${movementId}`)
  const extra: string[] = []
  const tierErr = pageErrors.find(e => /ensureTenTiers/.test(e))
  if (tierErr) extra.push(`New-article form throws on load ("${tierErr.split('\n')[0]}", ProductFormView calls a function that does not exist), so its price-tier table stays empty: the new article is saved with ${after[newSku]?.tiers.length ?? '?'} tier slots.`)
  extra.push(`Stock (API): PRD-0013 ${before['PRD-0013'].stock} → ${after['PRD-0013'].stock} (+${after['PRD-0013'].stock - before['PRD-0013'].stock}), PRD-0014 ${before['PRD-0014'].stock} → ${after['PRD-0014'].stock} (+${after['PRD-0014'].stock - before['PRD-0014'].stock}), new article ${after[newSku]?.stock}. Movement ${mv?.stockMovement?.movementNumber}: ${mv?.stockMovement?.status}, supplier ${supplier.name}.`)
  extra.push(`Prices (API): PRD-0013 purchase ${before['PRD-0013'].purchasePrice} → ${after['PRD-0013'].purchasePrice}, selling ${before['PRD-0013'].sellingPrice} → ${after['PRD-0013'].sellingPrice}; new article purchase ${after[newSku]?.purchasePrice}, selling ${after[newSku]?.sellingPrice}, VAT ${after[newSku]?.taxRate} % (org default 18 %; the form's VAT field defaults to 0).`)
  const t13 = after['PRD-0013'].tiers
  const atCost = t13.filter((x: any) => Number(x.finalPrice) === Number(after['PRD-0013'].purchasePrice))
  if (atCost.length) {
    const { options } = await api.get(`/pricing/options?productId=${after['PRD-0013'].id}&all=true`)
    const offeredAtCost = (options || []).filter((o: any) => o.type === 'tier' && /^Цена \d+$/.test(o.name) && Number(o.price) === Number(after['PRD-0013'].purchasePrice)).length
    extra.push(`Side effect of the prices tab: PRD-0013 now holds ${t13.length} price-tier slots (the seed had none), ${atCost.length} of them at the new PURCHASE price ${after['PRD-0013'].purchasePrice} — sell tiers „Цена 0"…„Цена 10" included — because typing a purchase price cascades into every 0 % slot. A sales line's price picker (/pricing/options) now offers ${offeredAtCost} „Цена N" prices at cost.`)
  }
  appendNotes(testInfo, 'P2b', result, extra)

  expect(after['PRD-0013'].stock - before['PRD-0013'].stock).toBe(10)
  // B-8: the supplier the old field could not offer is the one the receipt stores.
  expect(mv?.stockMovement?.contactId, 'the receipt stores the supplier picked in „Доставчик"').toBe(supplier.id)
})
