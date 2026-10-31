import { test, expect, type Page } from '@playwright/test'
import { loginForApp } from './helpers/login'
import { columnValues, headerTitles } from './helpers/table'

/**
 * The Products list's price tiers: a column per slot — Доставна цена, Цена на едро, Цена 0..Цена 10.
 * Доставна цена, Цена на едро and Цена 1, 2, 4, 5 are shown and the other seven are on the cog,
 * with the purchase price (Доставна цена again wherever the tiers are kept); each column prints
 * its tier's price to four decimals (a dash when the article has none there) and sorts by it,
 * across every filtered article and through a reload.
 *
 * Articles used: four this spec creates per worker (`E2E-TIER-<ts>-a..d`), found by that prefix.
 */
test.use({ viewport: { width: 1920, height: 900 } })

const apiBase = process.env.BASE_URL || 'http://localhost:4001'
const SHOWN = ['Доставна цена', 'Цена на едро', 'Цена 1', 'Цена 2', 'Цена 4', 'Цена 5']
const ON_COG = ['Purchase Price', 'Цена 0', 'Цена 3', 'Цена 6', 'Цена 7', 'Цена 8', 'Цена 9', 'Цена 10']

let prefix = ''

test.beforeAll(async () => {
  const login = await (await fetch(`${apiBase}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ orgSlug: 'acme-corp', username: 'admin', password: 'test123' }),
  })).json()
  const orgId = login.org?.id || login.org?._id
  prefix = `E2E-TIER-${Date.now()}`
  const tier = (name: string, finalPrice: number) => ({ name, percent: 0, finalPrice, manualOverride: true })
  // Цена 1: a 2.5 · b 0.0472 · c none (a zero slot) · d 1 — an order no name order matches.
  for (const [key, price1] of [['a', 2.5], ['b', 0.0472], ['c', 0], ['d', 1]] as const) {
    const res = await fetch(`${apiBase}/api/org/${orgId}/warehouse/product`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${login.token}` },
      body: JSON.stringify({
        sku: `${prefix}-${key}`, name: `E2E Tier ${key} ${prefix}`, category: 'Test', type: 'goods', unit: 'pcs',
        purchasePrice: 0.05, sellingPrice: 5, taxRate: 20,
        priceTiers: [tier('Доставна цена', 0.05), tier('Цена на едро', 0.0583), tier('Цена 1', price1)],
      }),
    })
    expect(res.ok, `create ${prefix}-${key}`).toBe(true)
  }
})

async function openList(page: Page, query = '') {
  await page.goto(`/inventory/products?q=${prefix}${query}`)
  const table = page.locator('.v-data-table').first()
  await expect(table.locator('tbody tr')).toHaveCount(4, { timeout: 15000 })
  await page.waitForLoadState('networkidle')
  return table
}

const skus = async (table: ReturnType<Page['locator']>) => (await columnValues(table, 'SKU')).map((s) => s.slice(prefix.length + 1))

test('shows Доставна цена, Цена на едро and Цена 1, 2, 4, 5; the cog offers the other seven and the purchase price', async ({ page }) => {
  await loginForApp(page)
  const table = await openList(page)
  const titles = await headerTitles(table)
  for (const t of SHOWN) expect(titles, t).toContain(t)
  for (const t of ON_COG) expect(titles, t).not.toContain(t)
  // Shown in slot order, after the selling price.
  expect(titles.filter((t) => SHOWN.includes(t))).toEqual(SHOWN)
  expect(titles.indexOf('Доставна цена')).toBe(titles.indexOf('Selling Price') + 1)

  await page.getByRole('button', { name: 'Columns' }).click()
  const dialog = page.getByRole('dialog')
  for (const t of [...SHOWN, ...ON_COG]) await expect(dialog.locator('.v-list-item-title').filter({ hasText: new RegExp(`^${t}$`) })).toHaveCount(1)
  for (const t of ['Цена 3', 'Purchase Price']) {
    await dialog.locator('.v-list-item').filter({ has: page.locator('.v-list-item-title', { hasText: new RegExp(`^${t}$`) }) }).getByRole('checkbox').click()
  }
  await dialog.getByRole('button', { name: 'Close' }).click()
  await expect.poll(async () => headerTitles(table)).toContain('Цена 3')
  // The purchase price keeps its decimals too, beside the tier that repeats it.
  await expect.poll(() => columnValues(table, 'Purchase Price')).toEqual(Array(4).fill('€0.05'))

  // The choice is the user's, and it stays.
  await page.reload()
  await expect(table.locator('tbody tr')).toHaveCount(4, { timeout: 15000 })
  expect(await headerTitles(table)).toEqual(expect.arrayContaining(['Цена 3', 'Purchase Price']))
})

test('prints each tier\'s price to four decimals, a dash where the article has none', async ({ page }) => {
  await loginForApp(page)
  const table = await openList(page, '&sortBy=sku&sortOrder=asc')
  expect(await skus(table)).toEqual(['a', 'b', 'c', 'd'])
  expect(await columnValues(table, 'Цена 1')).toEqual(['€2.50', '€0.0472', '—', '€1.00'])
  expect(await columnValues(table, 'Цена на едро')).toEqual(Array(4).fill('€0.0583'))
  expect(await columnValues(table, 'Цена 2')).toEqual(Array(4).fill('—'))
})

test('sorts by a tier — every filtered article, the ones without a price last — and keeps it on reload', async ({ page }) => {
  await loginForApp(page)
  const table = await openList(page)
  const header = table.locator('thead th').filter({ hasText: /^Цена 1$/ })

  await header.click()
  await expect(page).toHaveURL(/sortBy=tier_1&sortOrder=asc/)
  await expect.poll(() => skus(table)).toEqual(['b', 'd', 'a', 'c'])

  await header.click()
  await expect.poll(() => skus(table)).toEqual(['a', 'd', 'b', 'c'])

  // The URL follows the table 250 ms later (`useListQueryState`); descending is the list's
  // default order, so it is the one the URL leaves out.
  await expect(page).not.toHaveURL(/sortOrder=asc/)
  await expect(page).toHaveURL(/sortBy=tier_1/)
  await page.reload()
  await expect(table.locator('tbody tr')).toHaveCount(4, { timeout: 15000 })
  await expect.poll(() => skus(table)).toEqual(['a', 'd', 'b', 'c'])
})
