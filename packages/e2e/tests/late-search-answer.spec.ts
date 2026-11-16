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
