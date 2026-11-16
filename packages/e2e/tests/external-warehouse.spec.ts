import { test, expect, type Locator, type Page } from '@playwright/test'
import { signInForUx, uxApi } from './helpers/ux-budget'
import { openSelect } from './helpers/vuetify'

/**
 * An external warehouse in the Bulgarian UI: another site's warehouse, named here so that a transfer can say where
 * the goods went or came from. It keeps no stock in this organization.
 *
 * The first test is the owner's walk: mark a new warehouse external in its form, send goods to it with a transfer,
 * and print the movement for the people there. The transfer takes the goods out of our own warehouse and books
 * nothing on the external one. The others hold what the screens promise around it: goods arriving from one, and
 * which movement may name one.
 *
 * Every test makes an article and external warehouses of its own, and moves stock of that article only, in the
 * seed's default warehouse. ⚠ The warehouses stay behind (a warehouse is switched off, never removed). They are
 * external from their first save, so no other spec's warehouse list answers them.
 */

type Api = Awaited<ReturnType<typeof uxApi>>

interface World {
  api: Api
  /** The seed's default warehouse: our own, the one whose stock moves. */
  warehouse: any
  article: any
  stamp: string
}

const today = () => new Date().toISOString().split('T')[0]

async function world(tag: string): Promise<World> {
  const api = await uxApi()
  const stamp = `${tag}-${Date.now().toString(36)}`
  const warehouses = (await api.get('/warehouse/warehouse?size=100')).warehouses
  const warehouse = warehouses.find((w: any) => w.isDefault) || warehouses[0]
  const { product } = await api.post('/warehouse/product', {
    sku: `E2E-XW-${stamp}`, name: `E2E външен ${stamp}`, category: 'General', type: 'goods', unit: 'pcs',
    purchasePrice: 2.5, sellingPrice: 4, taxRate: 20,
  })
  return { api, warehouse, article: product, stamp }
}

/**
 * A warehouse name that sorts after every other one (a small Cyrillic letter is past the Latin letters and the
 * Cyrillic capitals). ⚠ These warehouses stay in the database, and a transfer's warehouse picker lists them, by
 * name, in a virtual list that holds only the rows in view. Sorted first they would, run after run, move the
 * seed's warehouses down that list, away from the rows it has rendered for the specs that choose one by name.
 */
const lastName = (tag: string) => `я обект ${tag} ${Date.now().toString(36)}`

/** An external warehouse, made through the API. */
async function externalWarehouse(w: World, tag: string) {
  const name = lastName(tag)
  const { warehouse } = await w.api.post('/warehouse/warehouse', { code: `XW-${tag}-${w.stamp}`, name, type: 'warehouse', isExternal: true })
  expect(warehouse?.isExternal, 'the API made an external warehouse').toBe(true)
  return { id: String(warehouse._id || warehouse.id), name, label: `${name} (външен)` }
}

/** A completed receipt of the article into our own warehouse. */
async function receipt(w: World, quantity: number) {
  const { stockMovement } = await w.api.post('/warehouse/movement', {
    type: 'receipt', date: today(), toWarehouseId: w.warehouse._id,
    lines: [{ productId: w.article._id, quantity, unitCost: 2.5, totalCost: quantity * 2.5 }], totalAmount: quantity * 2.5,
  })
  const confirmed = await w.api.post(`/warehouse/movement/${stockMovement._id || stockMovement.id}/confirm`)
  expect(confirmed.stockMovement?.status).toBe('completed')
}

/** The article's level rows in a warehouse: none where nothing was ever booked. */
const levelsIn = async (w: World, warehouseId: string): Promise<any[]> =>
  (await w.api.get(`/warehouse/stock-level?productId=${w.article._id}&warehouseId=${warehouseId}&size=5`)).stockLevels || []
const stockOf = async (w: World) => (await levelsIn(w, w.warehouse._id))[0]?.quantity ?? 0
const movementOf = async (w: World, id: string) => (await w.api.get(`/warehouse/movement/${id}`)).stockMovement

const actions = (page: Page) => page.locator('.form-actions-bar')
const snackbar = (page: Page) => page.locator('.v-snackbar .v-snackbar__content')
const fromField = (page: Page) => page.getByTestId('from-warehouse')
const toField = (page: Page) => page.getByTestId('to-warehouse')
const note = (page: Page) => page.getByTestId('external-transfer-note')

async function pickType(page: Page, name: string) {
  await openSelect(page, /^Тип/)
  await page.getByRole('option', { name, exact: true }).click()
}

/**
 * A warehouse, chosen in the select named `label`. The option is found inside that select's own list: the list of
 * the select chosen just before is still in the page while it closes, and it names the same warehouses.
 *
 * ⚠ The list is virtual: it holds only the rows in view. A warehouse far down the names (`lastName`) is not in the
 * page until the list is scrolled to it, so it is scrolled, as a person would.
 */
async function choose(page: Page, label: RegExp, name: string) {
  await openSelect(page, label)
  const list = page.getByRole('listbox', { name: label })
  const option = list.getByRole('option', { name, exact: true })
  await list.hover()
  await expect(async () => {
    if (await option.count()) return
    await page.mouse.wheel(0, 240)
    throw new Error(`„${name}" is not among the rendered options yet`)
  }).toPass({ timeout: 15000, intervals: [100] })
  await option.click()
}

/** Every option of an open list, read while it is scrolled to its end: a virtual list holds only the rows in view. */
async function optionsOf(page: Page, list: Locator): Promise<string[]> {
  const seen = new Set<string>()
  await list.hover()
  for (let unchanged = 0; unchanged < 3;) {
    const before = seen.size
    for (const text of await list.getByRole('option').allInnerTexts()) seen.add(text.trim())
    unchanged = seen.size === before ? unchanged + 1 : 0
    await page.mouse.wheel(0, 240)
    await page.waitForTimeout(80)
  }
  return [...seen]
}

/** The article on the first line. The quantity field is returned as picking the article left it. */
async function pickArticle(page: Page, w: World) {
  const line = page.locator('tbody tr').first()
  await line.getByPlaceholder('Търсете продукти...').pressSequentially(w.article.sku, { delay: 10 })
  await page.locator('.v-overlay--active .v-list-item').filter({ hasText: w.article.sku }).first().click()
  return line.locator('input[type="number"]').first()
}

/** „Печат" answers the movement as a PDF named after its number, asked for in the page's language. */
async function expectPrints(page: Page, click: () => Promise<void>, id: string, number: string) {
  const answered = page.waitForResponse(r => r.url().includes(`/warehouse/movement/${id}/export`))
  const download = page.waitForEvent('download')
  await click()
  const response = await answered
  expect(response.status()).toBe(200)
  expect(response.url()).toContain('locale=bg')
  expect(response.headers()['content-type']).toContain('application/pdf')
  expect((await response.body()).subarray(0, 5).toString()).toBe('%PDF-')
  expect((await download).suggestedFilename()).toBe(`${number}.pdf`)
}

test.describe('an external warehouse', () => {
  test('marked external in its form, it takes a transfer: our stock drops, none is booked there, and the movement prints', async ({ page }) => {
    const w = await world('walk')
    await receipt(w, 10)
    const name = lastName('walk')
    const label = `${name} (външен)`

    // ── the warehouse, marked external in its form ──
    await signInForUx(page)
    await page.goto('/inventory/warehouses/new', { waitUntil: 'networkidle' })
    await page.getByLabel(/^Код$/).fill(`XW-${w.stamp}`)
    await page.getByLabel(/^Име$/).fill(name)
    await page.getByLabel('Външен склад').check()
    // The default warehouse is where documents book stock, and an external one books none.
    await expect(page.getByTestId('warehouse-default').locator('input')).toBeDisabled()
    await expect(page.getByTestId('warehouse-external')).toContainText('Тук не се води наличност за него')
    await actions(page).getByRole('button', { name: 'Запази', exact: true }).click()
    await page.waitForURL(/\/inventory\/warehouses\/[0-9a-f]{24}\/edit/)
    const externalId = page.url().match(/warehouses\/([0-9a-f]{24})/)![1]

    // No picker lists it unless it asks: the list answers the warehouses that keep stock.
    const listed = async (query: string) => ((await w.api.get(`/warehouse/warehouse?size=1000${query}`)).warehouses as any[]).some(x => x._id === externalId)
    expect([await listed(''), await listed('&external=include'), await listed('&external=only')]).toEqual([false, true, true])

    // The Warehouses page lists it, and says what it is.
    await page.goto('/inventory/warehouses', { waitUntil: 'networkidle' })
    await page.getByRole('textbox', { name: 'Търсене', exact: true }).fill(name)
    const row = page.locator('.v-data-table tbody tr').filter({ hasText: name })
    await expect(row).toHaveCount(1)
    await expect(row.getByTestId('warehouse-external-chip')).toHaveText('Външен')

    // ── a transfer to it ──
    await page.goto('/inventory/movements/new', { waitUntil: 'networkidle' })
    await pickType(page, 'Прехвърляне')
    await choose(page, /От склад/, w.warehouse.name)
    await choose(page, /Към склад/, label)
    await expect(toField(page)).toContainText(label)
    await expect(note(page)).toContainText(`„${name}“ е външен склад: стоката излиза от вашия склад`)
    // The line starts from what our own warehouse holds, as on any transfer.
    const quantity = await pickArticle(page, w)
    await expect.poll(async () => Number(await quantity.inputValue())).toBe(10)
    await quantity.fill('3')

    const confirmed = page.waitForResponse(r => r.request().method() === 'POST' && r.url().includes('/confirm'))
    await actions(page).getByRole('button', { name: 'Запази и потвърди' }).click()
    expect((await confirmed).status()).toBe(200)
    await page.waitForURL(/\/inventory\/movements\/[0-9a-f]{24}/)
    const id = page.url().match(/movements\/([0-9a-f]{24})/)![1]

    // Our level dropped, and the external warehouse has no level at all.
    await expect.poll(() => stockOf(w)).toBe(7)
    expect(await levelsIn(w, externalId)).toEqual([])
    // Booked, the movement names in its stock fields only the warehouse whose stock it moved.
    const movement = await movementOf(w, id)
    expect([movement.status, movement.fromWarehouseId, movement.toWarehouseId ?? null, movement.externalToWarehouseId, movement.toExternal])
      .toEqual(['completed', w.warehouse._id, null, externalId, true])

    // The booked movement still reads as it was written, and prints.
    await expect(toField(page)).toContainText(label)
    await expect(note(page)).toBeVisible()
    await expectPrints(page, () => page.getByTestId('movement-print').click(), id, movement.number)

    // ── the list: found by the external warehouse, marked on its side, printed from its row ──
    await page.goto(`/inventory/movements?warehouse=${externalId}`, { waitUntil: 'networkidle' })
    const rows = page.locator('.v-data-table tbody tr').filter({ hasText: movement.number })
    await expect(rows).toHaveCount(1)
    await expect(rows.getByTestId('movement-external-side')).toHaveCount(1)
    await expect(rows).toContainText(name)
    await expectPrints(page, () => rows.getByTestId('movement-print').click(), id, movement.number)
  })

  test('goods arriving from one come into our warehouse: the line reads the destination and starts empty', async ({ page }) => {
    const w = await world('arrive')
    await receipt(w, 10)
    const external = await externalWarehouse(w, 'arrive')

    await signInForUx(page)
    await page.goto('/inventory/movements/new', { waitUntil: 'networkidle' })
    await pickType(page, 'Прехвърляне')
    await choose(page, /От склад/, external.label)
    await choose(page, /Към склад/, w.warehouse.name)
    await expect(note(page)).toContainText(`„${external.name}“ е външен склад: стоката влиза във вашия склад`)

    // What is on hand is our warehouse's 10, and it is not what arrives: the quantity is the person's to type.
    // (The chip and a prefill are written together, so once the chip shows, an unfilled quantity stays unfilled.)
    const quantity = await pickArticle(page, w)
    await expect(page.locator('tbody tr').first().locator('td').nth(1)).toHaveText('10')
    expect(Number(await quantity.inputValue())).toBe(0)
    await quantity.fill('4')

    const confirmed = page.waitForResponse(r => r.request().method() === 'POST' && r.url().includes('/confirm'))
    await actions(page).getByRole('button', { name: 'Запази и потвърди' }).click()
    expect((await confirmed).status()).toBe(200)
    await page.waitForURL(/\/inventory\/movements\/[0-9a-f]{24}/)
    const id = page.url().match(/movements\/([0-9a-f]{24})/)![1]

    await expect.poll(() => stockOf(w)).toBe(14)
    expect(await levelsIn(w, external.id)).toEqual([])
    const movement = await movementOf(w, id)
    expect([movement.status, movement.fromWarehouseId ?? null, movement.externalFromWarehouseId, movement.toWarehouseId, movement.fromExternal])
      .toEqual(['completed', null, external.id, w.warehouse._id, true])
    await expect(fromField(page)).toContainText(external.label)
  })

  test('only a transfer names one, with our own warehouse on the other side, and the flag\'s refusal reads in Bulgarian', async ({ page }) => {
    const w = await world('rules')
    const external = await externalWarehouse(w, 'rules-a')
    const second = await externalWarehouse(w, 'rules-b')

    await signInForUx(page)
    const writes: string[] = []
    page.on('request', (r) => {
      if (r.method() !== 'GET' && /\/warehouse\/movement(\/|$)/.test(new URL(r.url()).pathname)) writes.push(`${r.method()} ${r.url()}`)
    })
    await page.goto('/inventory/movements/new', { waitUntil: 'networkidle' })

    // A receipt offers the warehouses that keep stock, to the last of them, and no external one.
    const own = ((await w.api.get('/warehouse/warehouse?size=1000')).warehouses as any[]).map(x => x.name as string)
    await openSelect(page, /Към склад/)
    const offered = await optionsOf(page, page.getByRole('listbox', { name: /Към склад/ }))
    expect(offered).toContain(w.warehouse.name)
    expect(offered).toContain(own[own.length - 1])
    expect(offered.filter(o => o.includes('(външен)'))).toEqual([])
    await page.keyboard.press('Escape')

    // A transfer offers it, and the choice goes when the type changes away.
    await pickType(page, 'Прехвърляне')
    await choose(page, /От склад/, w.warehouse.name)
    await choose(page, /Към склад/, external.label)
    await expect(note(page)).toBeVisible()
    await pickType(page, 'Корекция')
    await expect(toField(page).locator('.v-select__selection')).toHaveCount(0)
    await expect(fromField(page)).toContainText(w.warehouse.name)
    await expect(note(page)).toHaveCount(0)

    // Two external warehouses move nothing of ours: refused on the screen, before anything is sent.
    await pickType(page, 'Прехвърляне')
    await choose(page, /От склад/, external.label)
    await choose(page, /Към склад/, second.label)
    await actions(page).getByRole('button', { name: 'Запази', exact: true }).click()
    await expect(snackbar(page)).toContainText('Прехвърляне с външен склад променя наличността на ваш склад')
    expect(writes).toEqual([])

    // The server says the same to a client that asks anyway, and to any other type that names one.
    const line = { productId: w.article._id, quantity: 1, unitCost: 2.5, totalCost: 2.5 }
    const both = await w.api.post('/warehouse/movement', { type: 'transfer', date: today(), fromWarehouseId: external.id, toWarehouseId: second.id, lines: [line], totalAmount: 2.5 })
    const dispatch = await w.api.post('/warehouse/movement', { type: 'dispatch', date: today(), fromWarehouseId: external.id, lines: [line], totalAmount: 2.5 })
    expect([both.code, dispatch.code]).toEqual(['transfer_without_own_warehouse', 'external_warehouse_not_transfer'])

    // A warehouse that still holds goods is not made external. No door saves one here (this warehouse is empty),
    // so the refusal is staged on the response the form reads: the screen says it in Bulgarian, with the count.
    await page.route(`**/warehouse/warehouse/${external.id}`, (route) => {
      if (route.request().method() !== 'PUT') return route.continue()
      return route.fulfill({
        status: 422, contentType: 'application/json',
        body: JSON.stringify({ code: 'warehouse_holds_stock', articles: 3, message: 'This warehouse holds or has reserved stock of 3 article(s).' }),
      })
    })
    await page.goto(`/inventory/warehouses/${external.id}/edit`, { waitUntil: 'networkidle' })
    await expect(page.getByLabel('Външен склад')).toBeChecked()
    await expect(page.getByTestId('warehouse-default').locator('input')).toBeDisabled()
    await actions(page).getByRole('button', { name: 'Запази', exact: true }).click()
    await expect(snackbar(page)).toContainText('Артикули с наличност или резервация в този склад: 3')
  })
})
