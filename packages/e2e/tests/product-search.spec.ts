import { test, expect } from '@playwright/test'
import { loginForApp } from './helpers/login'
import { apiLogin, apiPost } from './helpers/api'
import { closeTillSession, openTillSession, ownCashier } from './helpers/cash-register'

/**
 * FR-28.22 – .31 — ONE product search, on every screen that picks a product.
 *
 * Each screen has an autocomplete in the field ("Type to search products...") and "Details", the Products list in
 * a dialog: its filters, its columns (and the user's choice of them), its page sizes. The two inline widgets stay
 * two fields but print the same hit — the name, then SKU · unit · stock · price. What a pick DOES stays with the
 * screen; how an article is FOUND is the same everywhere.
 *
 * The articles of this spec carry a stamp of their own, so what a search finds is exactly what the spec made.
 */

test.use({ viewport: { width: 1366, height: 1200 } })

const SCREENS = [
  { name: 'movements', path: '/inventory/movements/new', priceColumn: true },
  { name: 'invoices', path: '/invoicing/invoices/new', priceColumn: false },
  { name: 'bills', path: '/invoicing/bills/new', priceColumn: true },
  { name: 'proforma', path: '/invoicing/proforma/new', priceColumn: false },
  { name: 'customer orders', path: '/invoicing/internal-orders/new', priceColumn: false },
  { name: 'supplier orders', path: '/invoicing/orders/new', priceColumn: true },
] as const

const PREFIX = 'E2E-PK'
const COUNT = 12

interface Fixture { stamp: string; sku: (n: number) => string; name: (n: number) => string; inactiveSku: string }

/** Twelve articles, so that "Show all N results" has more than ten to show, and one deactivated. Made once per worker. */
let made: Promise<Fixture> | undefined
function fixture(): Promise<Fixture> {
  made ??= (async () => {
    const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`
    const nn = (n: number) => String(n).padStart(2, '0')
    const session = await apiLogin()
    for (let n = 1; n <= COUNT; n++) {
      const res = await apiPost(session, '/warehouse/product', {
        sku: `${PREFIX}-${stamp}-${nn(n)}`, name: `E2E Pick ${stamp} ${nn(n)}`, category: 'Test', type: 'goods', unit: 'pcs',
        sellingPrice: 10 + n, purchasePrice: 5 + n, taxRate: 20,
      })
      expect(res.status, `a fixture article: ${res.status}`).toBeLessThan(300)
    }
    const inactive = await apiPost(session, '/warehouse/product', {
      sku: `${PREFIX}-${stamp}-X`, name: `E2E Pick ${stamp} X`, category: 'Test', type: 'goods', unit: 'pcs', sellingPrice: 1, isActive: false,
    })
    expect(inactive.status).toBeLessThan(300)
    return { stamp, sku: (n) => `${PREFIX}-${stamp}-${nn(n)}`, name: (n) => `E2E Pick ${stamp} ${nn(n)}`, inactiveSku: `${PREFIX}-${stamp}-X` }
  })()
  return made
}

const dialog = (page: any) => page.getByTestId('product-picker')
const rows = (page: any) => dialog(page).locator('.picker-table tbody tr')
const field = (page: any, n = 0) => page.locator('[data-testid="product-field"]').nth(n)

/** What every product field on the screen holds: the text in its input, and the chip an article picked shows. */
async function fieldValues(page: any): Promise<string[]> {
  return page.locator('[data-testid="product-field"]').evaluateAll((els: Element[]) =>
    els.map((el) => `${(el.querySelector('input') as HTMLInputElement | null)?.value || ''} ${el.querySelector('.v-chip')?.textContent || ''}`.trim()))
}

async function headers(scope: any): Promise<string[]> {
  // textContent, not innerText: the list writes its headers in capitals with CSS; the words are the same.
  const texts: string[] = await scope.locator('thead th').evaluateAll((els: Element[]) => els.map((el) => el.textContent || ''))
  return texts.map((t) => t.replace(/\s+/g, ' ').trim()).filter((t) => t && t !== 'Actions')
}

async function openDetails(page: any, search?: string) {
  await page.locator('[data-testid="product-details"]').first().click()
  await expect(dialog(page)).toBeVisible()
  if (search !== undefined) {
    await dialog(page).locator('[data-testid="filter-search"] input').fill(search)
  }
}

async function waitForRows(page: any, n: number) {
  await expect(rows(page)).toHaveCount(n, { timeout: 10000 })
}

for (const screen of SCREENS) {
  test.describe(`${screen.name} (${screen.path})`, () => {
    test('the field says what to type; Details opens the dialog, Escape closes it, and so does F4 open it', async ({ page }) => {
      await loginForApp(page)
      await page.goto(screen.path)
      const input = field(page).locator('input').first()
      await expect(input).toHaveAttribute('placeholder', 'Type to search products...')

      const details = page.locator('[data-testid="product-details"]').first()
      await expect(details).toBeVisible()
      await details.hover()
      await expect(page.getByRole('tooltip').filter({ hasText: 'Details (F4)' })).toBeVisible()
      await details.click()
      await expect(dialog(page)).toBeVisible()
      await page.keyboard.press('Escape')
      await expect(dialog(page)).toBeHidden()

      await input.click()
      await page.keyboard.press('F4')
      await expect(dialog(page)).toBeVisible()
    })

    test('a hit reads SKU · unit · stock · price, and picking it fills the line', async ({ page }) => {
      const fx = await fixture()
      await loginForApp(page)
      await page.goto(screen.path)
      await field(page).locator('input').first().click()
      await field(page).locator('input').first().pressSequentially(fx.sku(3), { delay: 20 })
      const hit = page.locator('.pld-overlay .pld-item, .v-overlay--active .v-list-item').filter({ hasText: fx.sku(3) }).first()
      await expect(hit).toBeVisible({ timeout: 10000 })
      // The second line of the row: the SKU, the unit, the stock once it has answered, the price.
      await expect(hit).toContainText(`${fx.sku(3)} · pcs`)
      await expect(hit).toContainText(/·\s*[^·]*\d/)
      await hit.scrollIntoViewIfNeeded()
      await hit.click({ force: true })
      await expect.poll(async () => (await fieldValues(page))[0], { timeout: 10000 }).toContain(fx.name(3))
    })

    test('two articles ticked in the dialog are added, each on a line of its own, in the order ticked', async ({ page }) => {
      const fx = await fixture()
      await loginForApp(page)
      await page.goto(screen.path)
      await openDetails(page, `${PREFIX}-${fx.stamp}`)
      await waitForRows(page, COUNT)
      // Rows are in name order, 01 … 12: tick 02, then 01.
      await rows(page).nth(1).click()
      await rows(page).nth(0).click()
      await expect(page.getByTestId('product-picker-selected')).toContainText('2 selected')
      await page.getByTestId('product-picker-add').click()
      await expect(dialog(page)).toBeHidden()

      await expect.poll(async () => {
        const v = await fieldValues(page)
        return [v.findIndex((x) => x.includes(fx.name(2))), v.findIndex((x) => x.includes(fx.name(1)))]
      }, { timeout: 10000 }).toEqual([0, 1])
    })
  })
}

test('the dialog shows the Products list\'s columns, and a bill or supplier order also shows the cost it starts from', async ({ page }) => {
  await loginForApp(page)
  await page.goto('/inventory/products')
  await expect(page.locator('.v-data-table thead th').first()).toBeVisible({ timeout: 15000 })
  const list = await headers(page.locator('.v-data-table'))
  expect(list.length).toBeGreaterThan(5)

  for (const screen of SCREENS) {
    await page.goto(screen.path)
    await openDetails(page)
    await waitForRows(page, 25)
    const shown = await headers(dialog(page))
    // The same columns, in the same order — except that a screen that starts from the cost shows the cost column.
    const without = (hs: string[]) => hs.filter((h) => h !== 'Purchase Price')
    expect(without(shown), `${screen.name}: the dialog's columns`).toEqual(without(list))
    expect(shown.includes('Purchase Price'), `${screen.name}: the cost column`).toBe(screen.priceColumn)
    await page.keyboard.press('Escape')
  }
})

test('the typed text goes into the dialog: with F4, and with "Show all N results"', async ({ page }) => {
  const fx = await fixture()
  await loginForApp(page)
  await page.goto('/invoicing/invoices/new')
  const input = field(page).locator('input').first()

  // F4 with one article typed: the dialog opens searching for exactly that.
  await input.click()
  await input.pressSequentially(fx.sku(5), { delay: 20 })
  await expect(page.locator('.pld-overlay .pld-item').first()).toBeVisible({ timeout: 10000 })
  await page.keyboard.press('F4')
  await expect(dialog(page)).toBeVisible()
  await expect(dialog(page).locator('[data-testid="filter-search"] input')).toHaveValue(fx.sku(5))
  await waitForRows(page, 1)
  await page.keyboard.press('Escape')
  await expect(dialog(page)).toBeHidden()

  // More than ten matches: the last hit says how many, and opens them all.
  await input.fill('')
  await input.pressSequentially(`${PREFIX}-${fx.stamp}`, { delay: 20 })
  const all = page.getByTestId('product-show-all')
  await expect(all).toBeVisible({ timeout: 10000 })
  await expect(all).toContainText(`Show all ${COUNT} results`)
  await expect(page.locator('.pld-overlay .pld-item:not(.pld-item--all):not(.pld-item--create)')).toHaveCount(10)
  // It is the last row of the overlay's own scroll area: scroll it into view, as a user does.
  await all.scrollIntoViewIfNeeded()
  await all.click({ force: true })
  await expect(dialog(page)).toBeVisible()
  await expect(dialog(page).locator('[data-testid="filter-search"] input')).toHaveValue(`${PREFIX}-${fx.stamp}`)
  await waitForRows(page, COUNT)
})

test('opening the dialog asks for one page and what its cells need, and nothing sized by the catalogue (FR-28.29)', async ({ page }) => {
  await loginForApp(page)
  await page.goto('/invoicing/invoices/new')
  await page.waitForLoadState('networkidle')

  const calls: string[] = []
  page.on('request', (r: any) => {
    const u = new URL(r.url())
    if (u.pathname.startsWith('/api/')) calls.push(`${u.pathname.replace(/\/org\/[^/]+/, '')}${u.search}`)
  })
  const count = (re: RegExp) => calls.filter((c) => re.test(c)).length

  await openDetails(page)
  await waitForRows(page, 25)
  await page.waitForLoadState('networkidle')

  expect(count(/^\/api\/warehouse\/product\?/), 'one page of products').toBe(1)
  const products = calls.find((c) => /^\/api\/warehouse\/product\?/.test(c))!
  expect(products).toContain('size=25')
  expect(products).not.toMatch(/[?&]size=0\b/)
  expect(products).toContain('sortBy=name')
  expect(products).toContain('isActive=true')
  expect(products, 'the screen\'s warehouse scopes the figures and never restricts the rows').not.toContain('warehouseId')
  expect(count(/^\/api\/warehouse\/stock-level\/by-products/), 'one stock call for the page').toBe(1)
  expect(count(/^\/api\/warehouse\/product-category/), 'the category list').toBe(1)
  expect(count(/^\/api\/warehouse\/warehouse\?/), 'the warehouse list').toBe(1)
  // The supplier choices are asked for when the supplier filter is first used, not when the dialog opens.
  expect(count(/^\/api\/invoicing\/contact/), 'no contact search').toBe(0)
  expect(calls.filter((c) => /^\/api\/warehouse\/product\?/.test(c) && /size=(0|[1-9]\d{3,})/.test(c)), 'nothing catalogue-sized').toEqual([])

  // Opened again: a fresh page, and the lists it already has are not asked for twice.
  await page.keyboard.press('Escape')
  await expect(dialog(page)).toBeHidden()
  calls.length = 0
  await openDetails(page)
  await waitForRows(page, 25)
  await page.waitForLoadState('networkidle')
  expect(count(/^\/api\/warehouse\/product\?/), 'one page again').toBe(1)
  expect(count(/^\/api\/warehouse\/product-category/)).toBe(0)
  expect(count(/^\/api\/warehouse\/warehouse\?/)).toBe(0)
})

test('the dialog lists active articles until Status says otherwise; Enter picks the highlighted row', async ({ page }) => {
  const fx = await fixture()
  await loginForApp(page)
  await page.goto('/invoicing/invoices/new')
  await openDetails(page, `${PREFIX}-${fx.stamp}`)
  await waitForRows(page, COUNT)
  await expect(rows(page).filter({ hasText: fx.inactiveSku })).toHaveCount(0)

  // Status: All — the deactivated article appears.
  await dialog(page).getByRole('combobox', { name: 'Status' }).click({ force: true })
  await page.locator('.v-overlay--active .v-list-item').filter({ hasText: /^All$/ }).click()
  await waitForRows(page, COUNT + 1)
  await expect(rows(page).filter({ hasText: fx.inactiveSku })).toHaveCount(1)
  await page.keyboard.press('Escape')
  await expect(dialog(page)).toBeHidden()

  // Reopened it is fresh: active again. Type a code and press Enter: the article is added and the dialog closes.
  await openDetails(page, fx.sku(7))
  await waitForRows(page, 1)
  await dialog(page).locator('[data-testid="filter-search"] input').press('Enter')
  await expect(dialog(page)).toBeHidden()
  await expect.poll(async () => (await fieldValues(page))[0], { timeout: 10000 }).toContain(fx.name(7))

  // What the document already holds is marked, not hidden.
  await openDetails(page, fx.sku(7))
  await waitForRows(page, 1)
  await expect(rows(page).first().getByTestId('product-on-document')).toBeVisible()
})

test('the dialog keeps the columns the user chose for the Products list', async ({ page }) => {
  const login = await (await fetch(`${process.env.BASE_URL || 'http://localhost:4001'}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ orgSlug: 'acme-corp', username: 'admin', password: 'test123' }),
  })).json()
  const userId = JSON.parse(Buffer.from(login.token.split('.')[1], 'base64url').toString()).id
  const key = `lgr:grid-cols:${userId}:${login.org.id || login.org._id}:inventory.products`

  await loginForApp(page)
  await page.addInitScript(([k]) => localStorage.setItem(k, JSON.stringify({ order: [], hidden: ['category', 'type'], shown: [] })), [key])
  await page.goto('/inventory/products')
  await expect(page.locator('.v-data-table thead th').first()).toBeVisible({ timeout: 15000 })
  const list = await headers(page.locator('.v-data-table'))
  expect(list).not.toContain('Category')
  expect(list).not.toContain('Type')

  await page.goto('/invoicing/invoices/new')
  await openDetails(page)
  await waitForRows(page, 25)
  const shown = await headers(dialog(page))
  expect(shown).not.toContain('Category')
  expect(shown).not.toContain('Type')
  expect(shown).toContain('SKU')
})

// The stock range's two inputs sat in a twelfth of the filter row each (about 86 px at 1366), so their labels read
// "Stoc…" and said nothing. A label that is cut has a scroll width wider than its box. The tags filter's label is the
// longest of the first row: „Филтриране по тагове" was cut to "Филтриране по таг…" there, five pixels short.
const STOCK_WORD = { en: 'Stock', bg: 'Наличност', de: 'Bestand', mk: 'Залиха' } as const
for (const lang of ['en', 'bg', 'de', 'mk'] as const) {
  test(`the labels of the stock range and of the tags filter are not cut at 1366 px, in the Products list and in the dialog (${lang})`, async ({ page }) => {
    await page.setViewportSize({ width: 1366, height: 900 })
    await loginForApp(page)
    await page.addInitScript((l: string) => localStorage.setItem('lgr_locale', l), lang)
    const word = STOCK_WORD[lang]

    const expectReadable = async (scope: any, where: string) => {
      // Every Vuetify field has two label nodes (resting and floating): the resting one is what is read.
      const resting = 'label.v-field-label:not(.v-field-label--floating)'
      for (const id of ['filter-stock-min', 'filter-stock-max']) {
        const label = scope.getByTestId(id).locator(resting)
        await expect(label).toContainText(word)
        expect(await label.evaluate((el: HTMLElement) => el.scrollWidth <= el.clientWidth), `${where}: ${id} label "${await label.innerText()}" is not cut`).toBe(true)
      }
      const tags = scope.locator('.product-filter-bar .v-combobox').locator(resting)
      expect(await tags.evaluate((el: HTMLElement) => el.scrollWidth <= el.clientWidth), `${where}: the tags label "${await tags.innerText()}" is not cut`).toBe(true)
    }

    await page.goto('/inventory/products')
    await expect(page.getByTestId('stock-filters')).toBeVisible({ timeout: 15000 })
    await expectReadable(page, 'the Products list')

    await page.goto('/invoicing/invoices/new')
    await openDetails(page)
    await expect(dialog(page).getByTestId('stock-filters')).toBeVisible()
    await expectReadable(dialog(page), 'the dialog')
  })
}

test.describe('the cash register keeps its card grid and gains Details', () => {
  test('the till: Details reads the till catalog, and several ticked articles add one unit of each', async ({ page }) => {
    const cashier = await ownCashier('details')
    const till = await openTillSession(cashier.session)
    try {
      await loginForApp(page, 'acme-corp', cashier.username, cashier.password)
      await page.goto('/invoicing/cash-sales/new')
      // The grid is still the till's search (and its scanning).
      await expect(page.getByTestId('register-card').first()).toBeVisible({ timeout: 15000 })

      const details = page.locator('[data-testid="product-details"]').first()
      await expect(details).toBeVisible()
      await details.click()
      await expect(dialog(page)).toBeVisible()
      await expect.poll(async () => rows(page).count(), { timeout: 10000 }).toBeGreaterThan(1)
      // The columns the catalog returns, nothing it does not.
      const shown = await headers(dialog(page))
      expect(shown).toEqual(expect.arrayContaining(['SKU', 'Name', 'Stock', 'Selling Price']))
      expect(shown).not.toContain('Suppliers')

      await rows(page).nth(0).click()
      await rows(page).nth(1).click()
      await page.getByTestId('product-picker-add').click()
      await expect(dialog(page)).toBeHidden()
      await expect(page.getByTestId('cart-line-0')).toBeVisible()
      await expect(page.getByTestId('cart-line-1')).toBeVisible()
      for (const i of [0, 1]) await expect(page.getByTestId(`cart-line-${i}`).getByTestId('cart-qty').locator('input')).toHaveValue('1')
    } finally {
      await closeTillSession(till.id, cashier.session)
      await cashier.drop()
    }
  })

  test('the till: F4 in the search opens it, searching for what was typed', async ({ page }) => {
    const cashier = await ownCashier('details')
    const till = await openTillSession(cashier.session)
    try {
      await loginForApp(page, 'acme-corp', cashier.username, cashier.password)
      await page.goto('/invoicing/cash-sales/new')
      const search = page.getByRole('textbox', { name: /Search products/i })
      await expect(search).toBeVisible({ timeout: 15000 })
      await search.fill('E2E')
      await page.keyboard.press('F4')
      await expect(dialog(page)).toBeVisible()
      await expect(dialog(page).locator('[data-testid="filter-search"] input')).toHaveValue('E2E')
    } finally {
      await closeTillSession(till.id, cashier.session)
      await cashier.drop()
    }
  })

  test('the back-office cash sale is the same terminal and has the same button', async ({ page }) => {
    await loginForApp(page)
    await page.goto('/invoicing/cash-sales/draft')
    await expect(page.locator('[data-testid="product-details"]').first()).toBeVisible({ timeout: 15000 })
  })
})
