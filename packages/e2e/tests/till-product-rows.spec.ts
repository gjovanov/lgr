import { test, expect } from '@playwright/test'
import { loginForApp } from './helpers/login'
import { apiLogin, apiDelete } from './helpers/api'
import { closeTillSession, openTillSession, ownCashier } from './helpers/cash-register'

/**
 * The cash register's articles, one to a row (goran, 2026-11-12): the name on the first line in a
 * larger font; the code, the price (bold) and the stock (a coloured badge) on the second. A pick (a
 * click, or Details) puts the cursor in the quantity of the cart line the article went to, its figure
 * selected, so the clerk types how many at once; Enter hands the cursor back to the search. The till
 * (`/invoicing/cash-sales/new`) and the back-office cash sale are the same terminal and do the same.
 *
 * The scanner's Enter in the search keeps the cursor there (FR-22.55, walked by `ux-budgets/p4-till`),
 * and a code scanned into a quantity is a scan, never a quantity of billions.
 *
 * The articles are this spec's own, stamped, so a search for the stamp shows exactly them.
 */

test.use({ viewport: { width: 1366, height: 768 } })

const API = process.env.BASE_URL || 'http://localhost:4001'

interface Article { id: string; sku: string; name: string; barcode?: string; price: number; stock: number }
interface Fixture { stamp: string; five: Article; zero: Article; long: Article }

/** Three articles stocked at the till's store, made once per worker. */
let made: Promise<Fixture> | undefined
function fixture(): Promise<Fixture> {
  made ??= (async () => {
    const admin = await apiLogin()
    const call = async (method: string, path: string, body?: unknown) => {
      const res = await fetch(`${API}/api/org/${admin.orgId}${path}`, {
        method,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${admin.token}` },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
      const json = await res.json().catch(() => null)
      if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${JSON.stringify(json)}`)
      return json
    }
    // The store a cashier's session opens at (`openTillSession`).
    const { warehouses } = await call('GET', '/warehouse/warehouse?size=50')
    const store = warehouses.find((w: any) => w.code === 'ST-01') || warehouses[0]
    const warehouseId = store.id || store._id
    const stamp = `trw${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`
    const digits = String(Date.now()).slice(-10)
    const move = async (productId: string, type: 'receipt' | 'adjustment', quantity: number) => {
      const side = type === 'receipt' ? 'toWarehouseId' : 'fromWarehouseId'
      const { stockMovement } = await call('POST', '/warehouse/movement', {
        type, date: new Date().toISOString(), [side]: warehouseId, notes: `e2e till rows ${stamp}`,
        lines: [{ productId, quantity, unitCost: 1, totalCost: quantity }], totalAmount: quantity,
      })
      await call('POST', `/warehouse/movement/${stockMovement._id || stockMovement.id}/confirm`, {})
    }
    const article = async (key: string, name: string, price: number, stock: number, barcode?: string): Promise<Article> => {
      const sku = `E2E-${stamp}-${key}`.toUpperCase()
      const { product } = await call('POST', '/warehouse/product', {
        sku, name, category: 'Test', type: 'goods', unit: 'pcs', sellingPrice: price, purchasePrice: 1, taxRate: 20,
        ...(barcode ? { barcode } : {}),
      })
      const id = product._id || product.id
      // Received, and for the zero one taken out again: a stock row at 0, not "never stocked" (null).
      await move(id, 'receipt', stock || 2)
      if (!stock) await move(id, 'adjustment', 2)
      return { id, sku, name, barcode, price, stock }
    }
    return {
      stamp,
      five: await article('5', `E2E Till Row ${stamp} five`, 12.34, 5, `29${digits}1`),
      zero: await article('0', `E2E Till Row ${stamp} zero`, 3.5, 0),
      long: await article('L', `E2E Till Row ${stamp} long, a hex bolt M8x25 DIN 933 8.8 zinc plated with a name far too long for the width of its row`, 0.35, 3, `29${digits}2`),
    }
  })()
  return made
}

test.afterAll(async () => {
  if (!made) return
  const f = await made
  const admin = await apiLogin()
  for (const a of [f.five, f.zero, f.long]) await apiDelete(admin, `/warehouse/product/${a.id}`)
})

const card = (page: any, a: Article) => page.getByTestId('register-card').filter({ hasText: a.sku })
const qty = (page: any, i: number) => page.getByTestId(`cart-line-${i}`).getByTestId('cart-qty').locator('input')
const lineOf = (page: any, a: Article) => page.locator('[data-testid^="cart-line-"]').filter({ hasText: a.name })

/** The till of a cashier of this test's own, its search showing just this spec's articles. */
async function openTill(page: any, f: Fixture) {
  const cashier = await ownCashier('rows')
  const till = await openTillSession(cashier.session)
  await loginForApp(page, 'acme-corp', cashier.username, cashier.password)
  await page.goto('/invoicing/cash-sales/new')
  const search = page.getByRole('textbox', { name: /Search products/i })
  await expect(search).toBeVisible({ timeout: 15000 })
  await search.fill(f.stamp)
  await expect(page.getByTestId('register-card')).toHaveCount(3, { timeout: 10000 })
  return {
    search,
    done: async () => {
      await closeTillSession(till.id, cashier.session)
      await cashier.drop()
    },
  }
}

test.describe('the till lists its articles one to a row', () => {
  test('one column of rows: the name, then the code, the price and the stock as a coloured badge', async ({ page }) => {
    const f = await fixture()
    const till = await openTill(page, f)
    try {
      const cards = page.getByTestId('register-card')
      // One column: every row starts at the same x and is as wide as the list.
      const boxes = await cards.evaluateAll((els: HTMLElement[]) => els.map((e) => e.getBoundingClientRect()).map((r) => ({ x: r.x, y: r.y, w: r.width, h: r.height })))
      const listWidth = await page.getByTestId('register-list').evaluate((el: HTMLElement) => el.clientWidth)
      for (const b of boxes) {
        expect(Math.abs(b.x - boxes[0].x)).toBeLessThanOrEqual(1)
        expect(Math.abs(b.w - boxes[0].w)).toBeLessThanOrEqual(1)
        expect(b.w).toBeGreaterThan(listWidth * 0.9)
        // Two lines, compact: a laptop screen holds a useful number of them.
        expect(b.h).toBeLessThanOrEqual(64)
      }
      for (let i = 1; i < boxes.length; i++) expect(boxes[i].y).toBeGreaterThanOrEqual(boxes[i - 1].y + boxes[i - 1].h)

      // Line 1 the name, in a larger font than line 2's code; line 2 the code, then the price (bold), then the stock.
      const row = card(page, f.five)
      const look = await row.evaluate((el: HTMLElement) => {
        const part = (id: string) => el.querySelector(`[data-testid="${id}"]`) as HTMLElement
        const box = (id: string) => part(id).getBoundingClientRect()
        const css = (id: string) => getComputedStyle(part(id))
        return {
          nameSize: parseFloat(css('register-card-name').fontSize),
          skuSize: parseFloat(css('register-card-sku').fontSize),
          priceSize: parseFloat(css('register-card-price').fontSize),
          priceWeight: Number(css('register-card-price').fontWeight),
          nameBottom: box('register-card-name').bottom,
          lineTwoTop: Math.min(box('register-card-sku').top, box('register-card-price').top, box('register-card-stock').top),
          skuX: box('register-card-sku').x,
          priceX: box('register-card-price').x,
          stockX: box('register-card-stock').x,
        }
      })
      expect(look.nameSize).toBeGreaterThan(look.skuSize)
      expect(look.priceSize).toBeGreaterThan(look.skuSize)
      expect(look.priceWeight).toBeGreaterThanOrEqual(700)
      expect(look.lineTwoTop).toBeGreaterThanOrEqual(look.nameBottom - 1)
      expect(look.skuX).toBeLessThan(look.priceX)
      expect(look.priceX).toBeLessThan(look.stockX)
      await expect(row.getByTestId('register-card-name')).toHaveText(f.five.name)
      await expect(row.getByTestId('register-card-sku')).toHaveText(f.five.sku)
      await expect(row.getByTestId('register-card-price')).toHaveText(/12\.3400/)

      // The stock: green while there is some, red at none.
      await expect(row.getByTestId('register-card-stock')).toHaveText('Stock: 5')
      await expect(row.getByTestId('register-card-stock')).toHaveClass(/bg-success/)
      const zero = card(page, f.zero).getByTestId('register-card-stock')
      await expect(zero).toHaveText('Stock: 0')
      await expect(zero).toHaveClass(/bg-error/)

      // A name too long for its row ends in an ellipsis on one line, and says itself in full on hover.
      const longName = card(page, f.long).getByTestId('register-card-name')
      await expect(longName).toHaveAttribute('title', f.long.name)
      const cut = await longName.evaluate((el: HTMLElement) => ({
        overflow: getComputedStyle(el).textOverflow, wraps: getComputedStyle(el).whiteSpace, cut: el.scrollWidth > el.clientWidth,
      }))
      expect(cut).toEqual({ overflow: 'ellipsis', wraps: 'nowrap', cut: true })

      expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true)
    } finally {
      await till.done()
    }
  })

  test('a click puts the cursor in the quantity of the line the article went to, selected', async ({ page }) => {
    const f = await fixture()
    const till = await openTill(page, f)
    try {
      // A new line: its quantity has the cursor, and what is typed replaces the 1.
      await card(page, f.five).click()
      await expect(qty(page, 0)).toBeFocused()
      await expect(qty(page, 0)).toHaveValue('1')
      await page.keyboard.type('3')
      await expect(qty(page, 0)).toHaveValue('3')
      // Enter takes it, and hands the cursor back to the search for the next article.
      await page.keyboard.press('Enter')
      await expect(till.search).toBeFocused()
      await expect(page.getByTestId('cart-line-0')).toContainText('3 x')

      // Another article: its own new line.
      await card(page, f.long).click()
      await expect(qty(page, 1)).toBeFocused()
      await expect(qty(page, 1)).toHaveValue('1')

      // The first again: one more on ITS line, and the cursor there.
      await card(page, f.five).click()
      await expect(qty(page, 0)).toBeFocused()
      await expect(qty(page, 0)).toHaveValue('4')
      await page.keyboard.type('7')
      // Tab moves on as it always did; leaving the field takes what was typed.
      await page.keyboard.press('Tab')
      await expect(qty(page, 0)).not.toBeFocused()
      await expect(page.getByTestId('cart-line-0')).toContainText('7 x')
      await expect(page.locator('[data-testid^="cart-line-"]')).toHaveCount(2)

      // A cleared quantity is not a removal: the line stays, at 1.
      await qty(page, 1).click()
      await page.keyboard.press('Backspace')
      await till.search.click()
      await expect(page.locator('[data-testid^="cart-line-"]')).toHaveCount(2)
      await expect(qty(page, 1)).toHaveValue('1')
    } finally {
      await till.done()
    }
  })

  test('a pick far down the list leaves the page and the list where they were', async ({ page }) => {
    const f = await fixture()
    const till = await openTill(page, f)
    try {
      // The whole catalog: a page of 24, more than the list's box shows.
      await till.search.fill('')
      const cards = page.getByTestId('register-card')
      await expect(cards).toHaveCount(24, { timeout: 10000 })
      const list = page.getByTestId('register-list')
      expect(await list.evaluate((el: HTMLElement) => el.scrollHeight > el.clientHeight)).toBe(true)

      // The last row: the list scrolls to it in its own box; the page does not move.
      const last = cards.last()
      const name = (await last.getByTestId('register-card-name').innerText()).trim()
      await last.click()
      await expect(page.locator('[data-testid^="cart-line-"]')).toHaveCount(1)
      await expect(page.getByTestId('cart-line-0')).toContainText(name)
      await expect(qty(page, 0)).toBeFocused()
      expect(await page.evaluate(() => window.scrollY)).toBe(0)
      expect(await list.evaluate((el: HTMLElement) => el.scrollTop)).toBeGreaterThan(0)
      await expect(last).toBeInViewport()
      // And the pager is in view under it.
      await expect(page.locator('.register-catalog .v-pagination')).toBeInViewport()
    } finally {
      await till.done()
    }
  })

  test('a pick in Details puts the cursor in the picked article\'s quantity', async ({ page }) => {
    const f = await fixture()
    const till = await openTill(page, f)
    try {
      const dialog = page.getByTestId('product-picker')
      const rows = dialog.locator('.picker-table tbody tr')
      const pickInDetails = async (a: Article) => {
        // Details opens searching for what the grid's search holds: the stamp.
        await page.locator('[data-testid="product-details"]').first().click()
        await expect(dialog).toBeVisible()
        await rows.filter({ hasText: a.sku }).click()
        await page.getByTestId('product-picker-add').click()
        await expect(dialog).toBeHidden()
      }
      await pickInDetails(f.zero)
      await expect(lineOf(page, f.zero)).toHaveCount(1)
      await expect(qty(page, 0)).toBeFocused()
      await expect(qty(page, 0)).toHaveValue('1')
      await page.keyboard.type('2')
      await expect(qty(page, 0)).toHaveValue('2')
      await page.keyboard.press('Enter')

      // The same article again: one more on its line, and the cursor there.
      await pickInDetails(f.zero)
      await expect(qty(page, 0)).toBeFocused()
      await expect(qty(page, 0)).toHaveValue('3')
    } finally {
      await till.done()
    }
  })

  test('a code scanned into a quantity adds the scanned article and leaves the quantity alone', async ({ page }) => {
    const f = await fixture()
    const till = await openTill(page, f)
    try {
      await card(page, f.five).click()
      await expect(qty(page, 0)).toBeFocused()
      // The scanner types the code at its own speed and ends with Enter.
      await page.keyboard.type(f.long.barcode!, { delay: 5 })
      await page.keyboard.press('Enter')
      await expect(lineOf(page, f.long)).toHaveCount(1)
      await expect(page.locator('[data-testid^="cart-line-"]')).toHaveCount(2)
      await expect(qty(page, 0)).toHaveValue('1')
      await expect(page.getByTestId('cart-line-0')).toContainText('1 x')
      // Where a scan leaves it: the search, empty, ready for the next.
      await expect(till.search).toBeFocused()
      await expect(till.search).toHaveValue('')
    } finally {
      await till.done()
    }
  })
})

test.describe('the back-office cash sale is the same terminal', () => {
  test('a click puts the cursor in the quantity there too, and Enter does not save the sale', async ({ page }) => {
    const f = await fixture()
    await loginForApp(page)
    const saves: string[] = []
    page.on('request', (r: any) => { if (r.method() === 'POST' && /\/invoices\/?$/.test(new URL(r.url()).pathname)) saves.push(r.url()) })
    await page.goto('/invoicing/cash-sales/draft')
    const search = page.locator('.register-catalog input').first()
    await expect(search).toBeVisible({ timeout: 15000 })
    await search.fill(f.stamp)
    await expect(page.getByTestId('register-card')).toHaveCount(3, { timeout: 10000 })

    await card(page, f.five).click()
    await expect(qty(page, 0)).toBeFocused()
    await expect(qty(page, 0)).toHaveValue('1')
    await page.keyboard.type('2')
    await page.keyboard.press('Enter')
    await expect(search).toBeFocused()
    await expect(qty(page, 0)).toHaveValue('2')
    // Enter in the quantity is not the form's submit: the sale is still a draft on this page.
    await expect(page).toHaveURL(/\/invoicing\/cash-sales\/draft/)

    await card(page, f.five).click()
    await expect(qty(page, 0)).toBeFocused()
    await expect(qty(page, 0)).toHaveValue('3')
    expect(saves).toEqual([])
  })
})

test.describe('on a phone', () => {
  test.use({ viewport: { width: 375, height: 812 } })

  test('one column, nothing wider than the screen, and a tap leaves the page where it was', async ({ page }) => {
    const f = await fixture()
    const till = await openTill(page, f)
    try {
      const boxes = await page.getByTestId('register-card').evaluateAll((els: HTMLElement[]) => els.map((e) => e.getBoundingClientRect().x))
      expect(new Set(boxes.map(Math.round)).size).toBe(1)
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true)
      // The cart is under the catalog here: the cursor going to it would pull the page down, away
      // from the article just tapped, on every tap.
      await card(page, f.five).click()
      await expect(page.locator('[data-testid^="cart-line-"]')).toHaveCount(1)
      await expect(qty(page, 0)).not.toBeFocused()
    } finally {
      await till.done()
    }
  })
})
