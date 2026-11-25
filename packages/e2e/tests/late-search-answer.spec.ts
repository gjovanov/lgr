import { test, expect } from '@playwright/test'
import { loginForApp } from './helpers/login'
import { apiLogin, apiPost } from './helpers/api'
import { lineDescription } from './helpers/document-form'

/**
 * FR-31.4 (#796): the latest question wins. A slow answer to an earlier search used to replace the matches of what
 * the field holds, with its first row highlighted, and Enter then put THAT article on the line (reproduced with the
 * first answer held back three seconds).
 *
 * The overlay is teleported and fixed under the field: a tall viewport keeps it on screen (see
 * `invoicing-product-autocomplete.spec.ts`).
 */
test.use({ viewport: { width: 1280, height: 1200 } })

test('a line search whose first answer comes three seconds late puts the article the field names on the line', async ({ page }) => {
  const ts = `${Date.now()}`
  const api = await apiLogin()
  const make = async (word: string) => {
    const res = await apiPost(api, '/warehouse/product', {
      sku: `E2E-LATE-${word}-${ts}`, name: `Late${ts} ${word}`, category: 'Test', type: 'goods', unit: 'pcs', sellingPrice: 5, taxRate: 20,
    })
    expect(res.ok).toBe(true)
  }
  await make('alpha')
  await make('beta')
  const first = `Late${ts} al`
  const second = `Late${ts} be`

  // The first search's answer is held back three seconds; every other request goes through.
  await page.route('**/warehouse/product?*', async (route) => {
    const search = new URL(route.request().url()).searchParams.get('search')
    if (search === first) await new Promise((r) => setTimeout(r, 3000))
    // A request the page has given up on (aborted) can no longer be continued.
    await route.continue().catch(() => {})
  })

  await loginForApp(page)
  await page.goto('/invoicing/invoices/new')
  await expect(page.getByRole('heading', { name: /new invoice/i })).toBeVisible({ timeout: 10000 })
  await page.locator('.v-autocomplete input').first().click({ force: true })
  await page.locator('.v-overlay .v-list-item').first().click()
  await page.getByRole('button', { name: /add line/i }).click()
  const row = page.locator('.v-table tbody tr').first()
  const field = lineDescription(row).locator('input').first()

  const firstAsked = page.waitForRequest((r) => new URL(r.url()).searchParams.get('search') === first)
  await field.fill(first)
  await firstAsked
  await field.fill(second)

  const hits = page.locator('.pld-overlay .pld-item')
  await expect(hits.filter({ hasText: `Late${ts} beta` })).toBeVisible({ timeout: 5000 })
  // The late answer for the first word arrives meanwhile, and must change nothing.
  await page.waitForTimeout(3500)
  await expect(hits.filter({ hasText: `Late${ts} alpha` })).toHaveCount(0)
  await expect(hits.filter({ hasText: `Late${ts} beta` })).toBeVisible()
  // No error message for the answer nobody waited for.
  await expect(page.locator('.v-snackbar--active')).toHaveCount(0)

  await field.press('Enter')
  await expect(lineDescription(row).locator('.v-chip')).toContainText(`Late${ts} beta`, { timeout: 5000 })
})

/**
 * FR-33.12 (#933): Enter takes the first hit of what the field holds. A second word typed and Enter pressed within the
 * pause, with the first word's answer still on screen, used to put the first word's highlighted row on an invoice
 * line; on a movement line Enter picked nothing. The second word's answer is held back 1.5 s here, so Enter certainly
 * comes before it: the field waits for it, then takes its first row.
 */
async function twoArticles(prefix: string): Promise<{ word: string; name: (w: 'alpha' | 'beta') => string }> {
  const ts = `${Date.now()}${Math.random().toString(36).slice(2, 5)}`
  const api = await apiLogin()
  for (const w of ['alpha', 'beta']) {
    const res = await apiPost(api, '/warehouse/product', {
      sku: `E2E-${prefix}-${w}-${ts}`, name: `${prefix}${ts} ${w}`, category: 'Test', type: 'goods', unit: 'pcs',
      sellingPrice: 5, purchasePrice: 3, taxRate: 20,
    })
    expect(res.ok).toBe(true)
  }
  return { word: `${prefix}${ts}`, name: (w) => `${prefix}${ts} ${w}` }
}

/** Hold back the answer to the text `held()` names for 1.5 s; every other request goes through. */
async function holdBack(page: any, held: () => string) {
  await page.route('**/warehouse/product?*', async (route: any) => {
    const search = new URL(route.request().url()).searchParams.get('search')
    if (search && search === held()) await new Promise((r) => setTimeout(r, 1500))
    await route.continue().catch(() => {})
  })
}

test('Enter within the pause on an invoice line takes the first hit of the second word, never a row of the first word\'s list', async ({ page }) => {
  const fx = await twoArticles('Fast')
  let second = ''
  await holdBack(page, () => second)

  await loginForApp(page)
  await page.goto('/invoicing/invoices/new')
  await expect(page.getByRole('heading', { name: /new invoice/i })).toBeVisible({ timeout: 10000 })
  await page.locator('.v-autocomplete input').first().click({ force: true })
  await page.locator('.v-overlay .v-list-item').first().click()
  await page.getByRole('button', { name: /add line/i }).click()
  const row = page.locator('.v-table tbody tr').first()
  const field = lineDescription(row).locator('input').first()

  await field.fill(fx.word)
  const hits = page.locator('.pld-overlay .pld-item')
  await expect(hits.filter({ hasText: fx.name('alpha') })).toBeVisible({ timeout: 10000 })
  await expect(hits.filter({ hasText: fx.name('beta') })).toBeVisible()
  // The first word's list is on screen with its first row highlighted: the second word names the other article.
  const active = page.locator('.pld-overlay .pld-item--active')
  await expect(active).toBeVisible()
  const other: 'alpha' | 'beta' = (await active.innerText()).includes(fx.name('alpha')) ? 'beta' : 'alpha'
  second = `${fx.word} ${other.slice(0, 2)}`

  await field.pressSequentially(` ${other.slice(0, 2)}`)
  await field.press('Enter')
  await expect(lineDescription(row).locator('.v-chip')).toContainText(fx.name(other), { timeout: 8000 })
  await expect(field).toHaveValue(fx.name(other))
})

test('Enter on a movement line takes the first hit, and within the pause the first hit of the second word', async ({ page }) => {
  const fx = await twoArticles('Mvfast')
  let second = ''
  await holdBack(page, () => second)
  await loginForApp(page)
  const product = page.locator('[data-testid="product-field"]').first()
  const input = product.locator('input').first()
  const hits = page.locator('.v-overlay--active .v-list-item')

  // Enter takes the first hit of what the field holds (it used to only open the list).
  await page.goto('/inventory/movements/new')
  await input.click()
  await input.fill(`${fx.word} al`)
  await expect(hits.filter({ hasText: fx.name('alpha') })).toBeVisible({ timeout: 10000 })
  await input.press('Enter')
  await expect(product.locator('.v-chip')).toContainText(fx.name('alpha'), { timeout: 8000 })

  // A fresh line: the first word's list on screen, then a second word and Enter within the pause.
  await page.goto('/inventory/movements/new')
  await input.click()
  await input.fill(fx.word)
  await expect(hits.filter({ hasText: fx.name('alpha') })).toBeVisible({ timeout: 10000 })
  await expect(hits.filter({ hasText: fx.name('beta') })).toBeVisible()
  const other: 'alpha' | 'beta' = (await hits.first().innerText()).includes(fx.name('alpha')) ? 'beta' : 'alpha'
  second = `${fx.word} ${other.slice(0, 2)}`

  await input.pressSequentially(` ${other.slice(0, 2)}`)
  await input.press('Enter')
  await expect(product.locator('.v-chip')).toContainText(fx.name(other), { timeout: 8000 })
})
