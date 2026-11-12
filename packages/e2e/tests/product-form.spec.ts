import { test, expect, type Locator, type Page } from '@playwright/test'
import { loginForApp } from './helpers/login'
import { apiDelete, apiGet, apiLogin, apiPost, ensureProductCategory, type ApiSession } from './helpers/api'
import { openSelect } from './helpers/vuetify'

/**
 * The product form as the owner laid it out on 2026-11-12.
 *
 * Edit tab, three fields to a line: SKU, Name, Tariff code / Type, Category, Unit / Barcode, Description, Tags / Active.
 * The tariff code (the customs tariff number) is new, and empty until given.
 *
 * Pricing tab: the tiers table begins with the article's purchase price and selling price, the SAME figures as the
 * fields above it; a price keeps four decimals and a margin three (0.0472, 2000.555), shown in full; and every one of
 * those fields is wide enough for its figures, whichever filter columns the table shows.
 *
 * Geometry is read from the rendered boxes, because the layout IS the requirement.
 *
 * ⚠ `input.value` is what a number field HOLDS, with a point: a browser set to Bulgarian shows it with a comma.
 */

const WIDTHS = [1366, 1920]
const TIER_NAMES = ['Доставна цена', 'Цена на едро', 'Цена 0', 'Цена 1', 'Цена 2', 'Цена 3', 'Цена 4', 'Цена 5', 'Цена 6', 'Цена 7', 'Цена 8', 'Цена 9', 'Цена 10']

let session: ApiSession
const made: string[] = []

test.beforeAll(async () => { session = await apiLogin() })

// A deactivated article is off the Products screen, the pickers and the till (FR-22.48), so the specs after this
// file do not meet its articles there. ⚠ The bare `GET /warehouse/product` still lists it: `isActive=true` is the
// screen's filter, not the route's default.
test.afterAll(async () => {
  for (const id of made) await apiDelete(session, `/warehouse/product/${id}`)
})

function stamp(): string {
  return `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`
}

async function makeProduct(over: Record<string, unknown> = {}): Promise<any> {
  const s = stamp()
  const res = await apiPost(session, '/warehouse/product', { sku: `E2E-PF-${s}`, name: `E2E product form ${s}`, category: 'General', type: 'goods', unit: 'pcs', ...over })
  expect(res.ok, `create product: ${res.status}`).toBe(true)
  const { product } = await res.json()
  made.push(product._id)
  return product
}

async function stored(id: string): Promise<any> {
  return (await apiGet(session, `/warehouse/product/${id}`)).product
}

async function save(page: Page) {
  await page.getByRole('button', { name: /^save$/i }).first().click()
  await expect(page.getByText(/saved successfully/i).first()).toBeVisible({ timeout: 10000 })
}

/** The Edit tab with the article in it. */
async function openEdit(page: Page, product: any) {
  await page.goto(`/inventory/products/${product._id}/edit`)
  await expect(page.getByRole('textbox', { name: /^name$/i })).toHaveValue(product.name, { timeout: 10000 })
}

/** The Pricing tab with the article's tiers in it. */
async function openPricing(page: Page, product: any) {
  await page.goto(`/inventory/products/${product._id}/pricing`)
  await expect(page.getByTestId('tier-row').first()).toBeVisible({ timeout: 10000 })
}

const input = (scope: Page | Locator, testId: string) => scope.getByTestId(testId).locator('input')
/** A tier's row, by its name. */
function tierRow(page: Page, name: string): Locator {
  return page.locator(`[data-testid="tier-row"][data-tier="${name}"]`)
}
/** The dialog a form with unsaved edits asks with before it lets go. */
const leaveDialog = (page: Page) => page.locator('.v-dialog').filter({ hasText: 'Unsaved changes' })
const percentOf = (row: Locator) => row.locator('.tier-percent input')
const priceOf = (row: Locator) => row.locator('.tier-price input')

interface Box { x: number; y: number; width: number; height: number }
async function boxOf(loc: Locator): Promise<Box> {
  await expect(loc).toBeVisible()
  const b = await loc.boundingBox()
  expect(b, 'the element has a box on screen').toBeTruthy()
  return b as Box
}

// ── Edit tab ──

for (const width of WIDTHS) {
  test(`a new article at ${width} px: three fields to a line, the tariff code after the name`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 })
    await loginForApp(page)
    await page.goto('/inventory/products/new/edit')
    await expect(page.getByRole('textbox', { name: /^sku$/i })).toBeVisible({ timeout: 10000 })

    const LINES = [
      ['SKU', 'Name', 'Tariff Code'],
      ['Type', 'Category', 'Unit'],
      ['Barcode', 'Description', 'Tags'],
    ]
    let bottomOfLast = 0
    for (const [i, labels] of LINES.entries()) {
      const line = page.getByTestId(`product-basic-line-${i + 1}`)
      const fields = line.locator(':scope > div > .v-input')
      await expect(fields, `line ${i + 1}`).toHaveCount(3)
      const shown: string[] = []
      const boxes: Box[] = []
      for (let f = 0; f < 3; f++) {
        shown.push(((await fields.nth(f).locator('label').first().textContent()) ?? '').trim())
        boxes.push(await boxOf(fields.nth(f)))
      }
      expect(shown, `line ${i + 1}`).toEqual(labels)
      // One line: the three start at the same height, left to right, each a third of it.
      expect(Math.abs(boxes[1].y - boxes[0].y), `line ${i + 1}: 2nd beside 1st`).toBeLessThanOrEqual(2)
      expect(Math.abs(boxes[2].y - boxes[0].y), `line ${i + 1}: 3rd beside 1st`).toBeLessThanOrEqual(2)
      expect(boxes[1].x).toBeGreaterThan(boxes[0].x + boxes[0].width)
      expect(boxes[2].x).toBeGreaterThan(boxes[1].x + boxes[1].width)
      expect(Math.abs(boxes[1].width - boxes[0].width)).toBeLessThanOrEqual(2)
      expect(Math.abs(boxes[2].width - boxes[0].width)).toBeLessThanOrEqual(2)
      // …and under the line before it.
      expect(boxes[0].y, `line ${i + 1} under line ${i}`).toBeGreaterThanOrEqual(bottomOfLast)
      bottomOfLast = Math.max(...boxes.map(b => b.y + b.height))
    }
    // Line 4: Active, alone.
    const active = page.getByTestId('product-basic-line-4')
    await expect(active.locator('.v-input')).toHaveCount(1)
    await expect(active.getByLabel(/^active$/i)).toBeChecked()
    expect((await boxOf(active.locator('.v-input'))).y).toBeGreaterThanOrEqual(bottomOfLast)

    // Empty until given, and no longer than the route takes.
    const tariff = input(page, 'product-tariff-code')
    await expect(tariff).toHaveValue('')
    await expect(tariff).toHaveAttribute('maxlength', '50')
    // Nothing spills past the window.
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0)
  })
}

test('a new article is saved with its tariff code', async ({ page }) => {
  const category = await ensureProductCategory()
  const s = stamp()
  await loginForApp(page)
  await page.goto('/inventory/products/new/edit')
  await page.getByRole('textbox', { name: /^sku$/i }).fill(`E2E-PF-NEW-${s}`)
  await page.getByRole('textbox', { name: /^name$/i }).fill(`E2E product form new ${s}`)
  await input(page, 'product-tariff-code').fill('  7318 15 95 ')
  // The route refuses an article without a category. Typed, so the one wanted is in the list however many there are.
  await openSelect(page, /category/i)
  await page.getByRole('combobox', { name: /category/i }).fill(category)
  await page.getByRole('option', { name: category, exact: true }).first().click()
  await save(page)

  // A new article opens as itself once saved.
  await page.waitForURL(/\/inventory\/products\/[0-9a-f]{24}\/edit$/)
  const id = page.url().split('/').at(-2)!
  made.push(id)
  const product = await stored(id)
  expect([product.sku, product.tariffCode, product.category]).toEqual([`E2E-PF-NEW-${s}`, '7318 15 95', category])
  await expect(input(page, 'product-tariff-code')).toHaveValue('7318 15 95')
})

test('the tariff code of an article is shown, changed and emptied', async ({ page }) => {
  const product = await makeProduct()
  expect(product.tariffCode).toBeUndefined()
  await loginForApp(page)
  await openEdit(page, product)
  const tariff = input(page, 'product-tariff-code')
  await expect(tariff).toHaveValue('')

  await tariff.fill('73181595')
  await save(page)
  expect((await stored(product._id)).tariffCode).toBe('73181595')

  await page.reload()
  await expect(page.getByRole('textbox', { name: /^name$/i })).toHaveValue(product.name, { timeout: 10000 })
  await expect(input(page, 'product-tariff-code')).toHaveValue('73181595')

  await input(page, 'product-tariff-code').fill('')
  await save(page)
  expect((await stored(product._id)).tariffCode).toBe('')
})

test('a change of type is saved on an existing article', async ({ page }) => {
  // The update route never named `type`: the select showed the new type, Save answered 200, and the article kept the old.
  const product = await makeProduct({ type: 'goods' })
  await loginForApp(page)
  await openEdit(page, product)
  await openSelect(page, /^type$/i)
  await page.getByRole('option', { name: /^service$/i }).click()
  await save(page)
  expect((await stored(product._id)).type).toBe('service')
})

// ── Pricing tab ──

test('the tiers begin with the purchase price and the selling price: the same figures as the fields above', async ({ page }) => {
  const product = await makeProduct({
    purchasePrice: 10, sellingPrice: 12.5,
    priceTiers: [
      { name: 'Цена 1', percent: 25, finalPrice: 12.5, manualOverride: false },
      { name: 'Цена 2', percent: 100, finalPrice: 20, manualOverride: true },
    ],
  })
  await loginForApp(page)
  await openPricing(page, product)

  // The two base prices lead the table, unnumbered; the article's slots follow, numbered from 1.
  const rows = page.getByTestId('tier-table').locator('tbody tr')
  await expect(rows.nth(0)).toHaveAttribute('data-testid', 'tier-base-purchase')
  await expect(rows.nth(1)).toHaveAttribute('data-testid', 'tier-base-selling')
  await expect(rows.nth(0)).toContainText('Purchase Price')
  await expect(rows.nth(1)).toContainText('Selling Price')
  await expect(page.getByTestId('tier-row')).toHaveCount(TIER_NAMES.length)
  await expect(rows.nth(2).locator('td').first()).toHaveText('1')

  const topPurchase = input(page, 'base-purchase-price')
  const topSelling = input(page, 'base-selling-price')
  const topMargin = input(page, 'base-selling-margin')
  const rowPurchase = priceOf(page.getByTestId('tier-base-purchase'))
  const rowSelling = priceOf(page.getByTestId('tier-base-selling'))
  const rowMargin = percentOf(page.getByTestId('tier-base-selling'))
  await expect(topPurchase).toHaveValue('10.0000')
  await expect(rowPurchase).toHaveValue('10.0000')
  await expect(topSelling).toHaveValue('12.5000')
  await expect(rowSelling).toHaveValue('12.5000')
  await expect(topMargin).toHaveValue('25.000')
  await expect(rowMargin).toHaveValue('25.000')

  // Typed in the table, shown above.
  await rowSelling.fill('15')
  await expect(topSelling).toHaveValue('15.0000')
  await expect(topMargin).toHaveValue('50.000')
  await expect(rowMargin).toHaveValue('50.000')

  // Typed above, shown in the table; the tiers move as they do from the field above: one that follows the purchase
  // price goes to its margin over the new one, one fixed by hand keeps its price and shows its new margin.
  await topPurchase.fill('8')
  await expect(rowPurchase).toHaveValue('8.0000')
  await expect(priceOf(tierRow(page, 'Цена 1'))).toHaveValue('10.0000')
  await expect(priceOf(tierRow(page, 'Цена 2'))).toHaveValue('20.0000')
  await expect(percentOf(tierRow(page, 'Цена 2'))).toHaveValue('150.000')
  await expect(rowMargin).toHaveValue('87.500')

  // And from the table's purchase price, the same.
  await rowPurchase.fill('5')
  await expect(topPurchase).toHaveValue('5.0000')
  await expect(priceOf(tierRow(page, 'Цена 1'))).toHaveValue('6.2500')
  await expect(percentOf(tierRow(page, 'Цена 2'))).toHaveValue('300.000')

  // The margin in the table moves the selling price in both places.
  await rowMargin.fill('100')
  await expect(topSelling).toHaveValue('10.0000')
  await rowMargin.blur()
  await expect(rowSelling).toHaveValue('10.0000')

  await save(page)
  const after = await stored(product._id)
  expect([after.purchasePrice, after.sellingPrice]).toEqual([5, 10])
  const tier = (name: string) => after.priceTiers.find((t: any) => t.name === name)
  expect([tier('Цена 1').finalPrice, tier('Цена 1').percent, tier('Цена 1').manualOverride]).toEqual([6.25, 25, false])
  expect([tier('Цена 2').finalPrice, tier('Цена 2').percent, tier('Цена 2').manualOverride]).toEqual([20, 300, true])
  // The base rows are no slots of the article.
  expect(after.priceTiers.map((t: any) => t.name).sort()).toEqual([...TIER_NAMES].sort())
})

test('a tier the purchase price never set keeps its price when the purchase price moves', async ({ page }) => {
  const product = await makeProduct({
    purchasePrice: 10, sellingPrice: 15,
    priceTiers: [
      // Follows: the purchase price plus its margin.
      { name: 'Цена 1', percent: 25, finalPrice: 12.5, manualOverride: false },
      // A slot the backfill filled: the selling price, at a margin of 0.
      { name: 'Цена 3', percent: 0, finalPrice: 15, manualOverride: false },
      // A price an import wrote beside a margin it did not compute.
      { name: 'Цена 4', percent: 10, finalPrice: 14.2, manualOverride: false },
    ],
  })
  await loginForApp(page)
  await openPricing(page, product)
  // The title counts the slots the table shows (it said 10 for 13).
  await expect(page.getByTestId('tier-title')).toHaveText(`Price Tiers (${TIER_NAMES.length} slots)`)

  const purchase = input(page, 'base-purchase-price')
  await purchase.fill('8')
  await expect(priceOf(tierRow(page, 'Цена 1'))).toHaveValue('10.0000')
  // These took the purchase price itself, a price nobody chose.
  await expect(priceOf(tierRow(page, 'Цена 3'))).toHaveValue('15.0000')
  await expect(percentOf(tierRow(page, 'Цена 3'))).toHaveValue('0.000')
  await expect(priceOf(tierRow(page, 'Цена 4'))).toHaveValue('14.2000')
  // A slot the article did not hold, which the form shows at the selling price.
  await expect(priceOf(tierRow(page, 'Цена 5'))).toHaveValue('15.0000')

  // A margin typed on such a tier is a margin over the purchase price: from then on it follows.
  await percentOf(tierRow(page, 'Цена 3')).fill('50')
  await expect(priceOf(tierRow(page, 'Цена 3'))).toHaveValue('12.0000')
  await purchase.fill('6')
  await expect(priceOf(tierRow(page, 'Цена 3'))).toHaveValue('9.0000')
  await expect(priceOf(tierRow(page, 'Цена 1'))).toHaveValue('7.5000')
  await expect(priceOf(tierRow(page, 'Цена 4'))).toHaveValue('14.2000')

  await save(page)
  const after = await stored(product._id)
  const tier = (name: string) => after.priceTiers.find((t: any) => t.name === name)
  expect(after.purchasePrice).toBe(6)
  expect([tier('Цена 1').finalPrice, tier('Цена 1').percent]).toEqual([7.5, 25])
  expect([tier('Цена 3').finalPrice, tier('Цена 3').percent, tier('Цена 3').manualOverride]).toEqual([9, 50, false])
  expect([tier('Цена 4').finalPrice, tier('Цена 4').percent, tier('Цена 4').manualOverride]).toEqual([14.2, 10, false])
  expect(tier('Цена 5').finalPrice).toBe(15)
})

test('an edit of a tier alone is an unsaved change, and so is an edit made after a save', async ({ page }) => {
  const product = await makeProduct({ purchasePrice: 10, sellingPrice: 15, priceTiers: [{ name: 'Цена 1', percent: 25, finalPrice: 12.5, manualOverride: false }] })
  await loginForApp(page)
  await openPricing(page, product)
  // Untouched, the form lets go without a word.
  await page.getByTestId('form-back').click()
  await expect(page).toHaveURL(/\/inventory\/products(\?|$)/)
  await expect(page.getByText('Unsaved changes', { exact: true })).toHaveCount(0)

  await openPricing(page, product)
  await priceOf(tierRow(page, 'Цена 1')).fill('13')
  await page.getByTestId('form-back').click()
  // It used to leave here too: the tiers were not among what the form compared.
  await expect(page.getByText('Unsaved changes', { exact: true })).toBeVisible()

  // Stay and save. The form stays open on what it saved, and an edit from there is unsaved again: after its first
  // save the form used to let every later edit go without a word.
  await leaveDialog(page).getByRole('button', { name: /^cancel$/i }).click()
  await expect(page.getByText('Unsaved changes', { exact: true })).toHaveCount(0)
  await save(page)
  expect((await stored(product._id)).priceTiers.find((t: any) => t.name === 'Цена 1').finalPrice).toBe(13)
  await priceOf(tierRow(page, 'Цена 1')).fill('14')
  await page.getByTestId('form-back').click()
  await expect(page.getByText('Unsaved changes', { exact: true })).toBeVisible()
})

test('a new article opens as itself once saved, and what is edited there is an unsaved change', async ({ page }) => {
  const category = await ensureProductCategory()
  const s = stamp()
  await loginForApp(page)
  await page.goto('/inventory/products/new/edit')
  await page.getByRole('textbox', { name: /^sku$/i }).fill(`E2E-PF-AFTER-${s}`)
  await page.getByRole('textbox', { name: /^name$/i }).fill(`E2E product form after save ${s}`)
  await openSelect(page, /category/i)
  await page.getByRole('combobox', { name: /category/i }).fill(category)
  await page.getByRole('option', { name: category, exact: true }).first().click()
  await save(page)
  await page.waitForURL(/\/inventory\/products\/[0-9a-f]{24}\/edit$/)
  made.push(page.url().split('/').at(-2)!)

  await page.getByRole('textbox', { name: /^name$/i }).fill(`E2E product form after save ${s} B`)
  await page.getByTestId('form-back').click()
  await expect(page.getByText('Unsaved changes', { exact: true })).toBeVisible()
})

test('a new article with no category is told so on the field, and nothing is sent', async ({ page }) => {
  const s = stamp()
  await loginForApp(page)
  const posts: string[] = []
  page.on('request', (r) => { if (r.method() === 'POST' && /\/warehouse\/product$/.test(new URL(r.url()).pathname)) posts.push(r.url()) })
  await page.goto('/inventory/products/new/edit')
  await page.getByRole('textbox', { name: /^sku$/i }).fill(`E2E-PF-NOCAT-${s}`)
  await page.getByRole('textbox', { name: /^name$/i }).fill(`E2E product form no category ${s}`)
  await page.getByRole('button', { name: /^save$/i }).first().click()
  // The route refuses an article without a category; the save used to go and come back as an error.
  await expect(page.getByTestId('product-category').locator('.v-messages__message')).toBeVisible()
  await expect(page).toHaveURL(/\/inventory\/products\/new\/edit$/)

  // Asked from another tab, the save comes back to the field that stops it.
  await page.getByRole('tab', { name: /pricing/i }).click()
  await expect(page).toHaveURL(/\/inventory\/products\/new\/pricing$/)
  await page.getByRole('button', { name: /^save$/i }).first().click()
  await expect(page).toHaveURL(/\/inventory\/products\/new\/edit$/)
  await expect(page.getByTestId('product-category').locator('.v-messages__message')).toBeVisible()
  expect(posts).toEqual([])
})

test('a price keeps four decimals and a margin three, shown in full', async ({ page }) => {
  const product = await makeProduct({
    purchasePrice: 0.0472, sellingPrice: 0.059,
    priceTiers: [{ name: 'Цена 1', percent: 0, finalPrice: 0.0472, manualOverride: false }],
  })
  await loginForApp(page)
  await openPricing(page, product)

  // At rest: every decimal, the trailing zeros too.
  await expect(input(page, 'base-purchase-price')).toHaveValue('0.0472')
  await expect(input(page, 'base-selling-price')).toHaveValue('0.0590')
  await expect(input(page, 'base-selling-margin')).toHaveValue('25.000')
  await expect(input(page, 'base-margin')).toHaveValue('25.000')
  await expect(priceOf(tierRow(page, 'Цена 1'))).toHaveValue('0.0472')
  await expect(percentOf(tierRow(page, 'Цена 1'))).toHaveValue('0.000')

  // A margin typed with more is three decimals, and its price four (0.0472 × 1.12346 = 0.05302…; it was 0.05).
  const percent1 = percentOf(tierRow(page, 'Цена 1'))
  await percent1.fill('12.3456')
  await expect(percent1).toHaveValue('12.3456') // while it is being typed, the text is the person's
  await expect(priceOf(tierRow(page, 'Цена 1'))).toHaveValue('0.0530')
  await percent1.blur()
  await expect(percent1).toHaveValue('12.346')

  // A price typed with more is four, a half going up; its margin three; and it is fixed by hand.
  const row2 = tierRow(page, 'Цена 2')
  await priceOf(row2).fill('0.04725')
  await priceOf(row2).blur()
  await expect(priceOf(row2)).toHaveValue('0.0473')
  await expect(percentOf(row2)).toHaveValue('0.212')
  await expect(row2.locator('.mdi-pencil-lock')).toBeVisible()

  // A margin of four digits and three decimals.
  const row3 = tierRow(page, 'Цена 3')
  await percentOf(row3).fill('2000.555')
  await percentOf(row3).blur()
  await expect(percentOf(row3)).toHaveValue('2000.555')
  await expect(priceOf(row3)).toHaveValue('0.9915') // 0.0472 × 21.00555 = 0.99146…

  // Saved by keyboard with the field still focused: no fifth decimal is stored (FR-22.52's Ctrl+S).
  const selling = input(page, 'base-selling-price')
  await selling.fill('2000.55555')
  await page.keyboard.press('Control+s')
  await expect(page.getByText(/saved successfully/i).first()).toBeVisible({ timeout: 10000 })

  const after = await stored(product._id)
  expect(after.sellingPrice).toBe(2000.5556)
  const tier = (name: string) => after.priceTiers.find((t: any) => t.name === name)
  expect([tier('Цена 1').percent, tier('Цена 1').finalPrice, tier('Цена 1').manualOverride]).toEqual([12.346, 0.053, false])
  expect([tier('Цена 2').percent, tier('Цена 2').finalPrice, tier('Цена 2').manualOverride]).toEqual([0.212, 0.0473, true])
  expect([tier('Цена 3').percent, tier('Цена 3').finalPrice]).toEqual([2000.555, 0.9915])
})

test('a figure nobody changed is saved as it was loaded, more decimals and all', async ({ page }) => {
  // An import may have stored more than four decimals. The form shows four, and must not round what it only showed.
  const product = await makeProduct({
    purchasePrice: 0.047231, sellingPrice: 0.059049,
    priceTiers: [{ name: 'Цена 1', percent: 25.02117, finalPrice: 0.059049, manualOverride: true }],
  })
  await loginForApp(page)
  await openPricing(page, product)
  await expect(input(page, 'base-purchase-price')).toHaveValue('0.0472')
  await expect(input(page, 'base-selling-price')).toHaveValue('0.0590')
  await expect(percentOf(tierRow(page, 'Цена 1'))).toHaveValue('25.021')

  // A click into a field and out again changes nothing.
  await input(page, 'base-selling-price').click()
  await priceOf(tierRow(page, 'Цена 1')).click()
  await input(page, 'base-purchase-price').click()
  await page.getByText('Base Prices').click()
  await save(page)

  const after = await stored(product._id)
  expect([after.purchasePrice, after.sellingPrice]).toEqual([0.047231, 0.059049])
  const tier = after.priceTiers.find((t: any) => t.name === 'Цена 1')
  expect([tier.percent, tier.finalPrice]).toEqual([25.02117, 0.059049])
})

// ── Widths ──

/**
 * For each kind of field: the least room among its inputs (inside its paddings) against what the widest figure it
 * keeps needs in the input's own font: a margin of four digits, three decimals and a sign; a price of six digits and
 * four decimals.
 */
async function roomForFigures(page: Page): Promise<{ kind: string; inputs: number; room: number; need: number }[]> {
  return page.evaluate(() => {
    const KINDS = [
      { kind: 'top purchase price', sel: '[data-testid="base-purchase-price"] input', sample: '123456.7891' },
      { kind: 'top selling price', sel: '[data-testid="base-selling-price"] input', sample: '123456.7891' },
      { kind: 'top selling margin', sel: '[data-testid="base-selling-margin"] input', sample: '-2000.555' },
      { kind: 'top margin', sel: '[data-testid="base-margin"] input', sample: '-2000.555' },
      { kind: 'table margin', sel: '[data-testid="tier-table"] .tier-percent input', sample: '-2000.555' },
      { kind: 'table price', sel: '[data-testid="tier-table"] .tier-price input', sample: '123456.7891' },
    ]
    const canvas = document.createElement('canvas').getContext('2d')!
    return KINDS.map(({ kind, sel, sample }) => {
      const inputs = [...document.querySelectorAll<HTMLInputElement>(sel)]
      let room = Number.POSITIVE_INFINITY
      let need = 0
      for (const el of inputs) {
        const cs = getComputedStyle(el)
        canvas.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`
        need = Math.max(need, canvas.measureText(sample).width + (Number.parseFloat(cs.letterSpacing) || 0) * sample.length)
        room = Math.min(room, el.clientWidth - Number.parseFloat(cs.paddingLeft) - Number.parseFloat(cs.paddingRight))
      }
      return { kind, inputs: inputs.length, room, need }
    })
  })
}

for (const width of WIDTHS) {
  test(`every price and margin field has room for its figures at ${width} px, with the filter columns and without`, async ({ page }) => {
    const product = await makeProduct({
      purchasePrice: 3, sellingPrice: 123456.7891,
      priceTiers: [
        { name: 'Цена 1', percent: 2000.555, finalPrice: 63.0167, manualOverride: false },
        // Fixed by hand: its field also holds the lock.
        { name: 'Цена 2', percent: -50, finalPrice: 123456.7891, manualOverride: true },
      ],
    })
    await page.setViewportSize({ width, height: 900 })
    await loginForApp(page)
    await openPricing(page, product)

    const check = async (when: string) => {
      const rooms = await roomForFigures(page)
      // The table: both base rows (three fields) and the thirteen slots.
      expect(rooms.find(r => r.kind === 'table margin')!.inputs, when).toBe(1 + TIER_NAMES.length)
      expect(rooms.find(r => r.kind === 'table price')!.inputs, when).toBe(2 + TIER_NAMES.length)
      for (const r of rooms) expect(r.room, `${when}: ${r.kind} has ${r.room} px for ${r.need} px`).toBeGreaterThanOrEqual(r.need)
      // The figures themselves, as rendered: nothing runs past its field.
      for (const field of [percentOf(tierRow(page, 'Цена 1')), priceOf(tierRow(page, 'Цена 2')), input(page, 'base-selling-price')]) {
        expect(await field.evaluate((el: HTMLInputElement) => el.scrollWidth - el.clientWidth), when).toBeLessThanOrEqual(0)
      }
      // The page never scrolls sideways (the table may, inside itself, before a field is cut).
      expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), when).toBeLessThanOrEqual(0)
    }

    await check('no filter column')
    for (const name of ['Contact', 'Tags', 'Min Qty', 'Validity']) await page.locator('.v-chip').filter({ hasText: new RegExp(`^${name}$`) }).click()
    await expect(page.getByTestId('tier-table').locator('thead th')).toHaveCount(9)
    await check('all four filter columns')
    // A date is still a date: the wider figures are not paid for by the columns beside them.
    const date = await boxOf(tierRow(page, 'Цена 1').locator('.tier-date').first())
    expect(date.width).toBeGreaterThanOrEqual(136)
  })
}
