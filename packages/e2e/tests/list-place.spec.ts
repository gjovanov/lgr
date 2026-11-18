import { test, expect, type Page, type Request } from '@playwright/test'
import { loginForApp } from './helpers/login'
import { appears } from './helpers/vuetify'
import { apiDelete, apiLogin, apiPost } from './helpers/api'

/**
 * FR-31 B3 (#796): lists keep their place, and Movements, Stock levels and Inventory counts are on the shared list shell.
 *
 * - FR-31.18: seventeen lists kept nothing in the address, so Back from a record opened page one without the search.
 *   Three of them here: filter, go to page two, open a record, come back (by the browser's Back and by the form's).
 * - FR-31.19: Movements gets the shell's column picker, and the columns it hides stay hidden; its address and its filters
 *   do not change, and it no longer fetches a contact list nothing read.
 */

const rows = (page: Page) => page.locator('.v-data-table tbody tr')
const stamp = () => `${Date.now()}${Math.floor(Math.random() * 1000)}`

/** An untouched form may still ask on leaving; confirming is what a person would do, and it must not cost the place. */
async function confirmLeaveIfAsked(page: Page) {
  const confirmLeave = page.getByRole('dialog').getByRole('button', { name: /confirm|leave|discard/i })
  if (await appears(confirmLeave, 1500)) await confirmLeave.click()
}

test.describe('FR-31.18: a list keeps its place on Back', () => {
  test('Categories: a search and page two survive opening a category, by the form\'s Back and by the browser\'s', async ({ page }) => {
    const api = await apiLogin()
    const word = `Place${stamp()}`
    const made: string[] = []
    try {
      // Twelve that the search finds: ten on page one, two on page two.
      for (let i = 0; i < 12; i++) {
        const res = await apiPost(api, '/warehouse/product-category', { name: `E2E ${word} ${String(i).padStart(2, '0')}` })
        expect(res.ok).toBe(true)
        const body = await res.json()
        made.push(String(body.productCategory?._id || body.productCategory?.id))
      }

      await loginForApp(page)
      await page.goto('/inventory/categories')
      await expect(page.locator('.v-data-table')).toBeVisible({ timeout: 10000 })
      await page.getByLabel(/search/i).first().fill(word)
      await expect(page).toHaveURL(new RegExp(`[?&]q=${word}`), { timeout: 5000 })
      await expect(rows(page)).toHaveCount(10)
      await page.getByRole('button', { name: /next page/i }).click()
      await expect(page).toHaveURL(/[?&]page=2/, { timeout: 5000 })
      await expect(rows(page)).toHaveCount(2)
      const firstOnTwo = (await rows(page).first().innerText()).split('\n')[0].trim()

      // 1. The form's own Back button: it goes to the bare list path, which used to drop the search and the page.
      await page.locator('.v-data-table tbody a[href$="/edit"]').first().click()
      await page.waitForURL(/\/inventory\/categories\/[0-9a-f]{24}\/edit/)
      await page.waitForLoadState('networkidle')
      await page.getByTestId('form-back').click()
      await confirmLeaveIfAsked(page)
      await expect(page).toHaveURL(/\/inventory\/categories(\?|$)/)
      await expect(page).toHaveURL(new RegExp(`[?&]q=${word}`))
      await expect(page).toHaveURL(/[?&]page=2/)
      await expect(page.getByLabel(/search/i).first()).toHaveValue(word)
      await expect(rows(page)).toHaveCount(2)
      await expect(rows(page).first()).toContainText(firstOnTwo)

      // 2. The browser's Back.
      await page.locator('.v-data-table tbody a[href$="/edit"]').first().click()
      await page.waitForURL(/\/inventory\/categories\/[0-9a-f]{24}\/edit/)
      await page.waitForLoadState('networkidle')
      await page.goBack()
      await confirmLeaveIfAsked(page)
      await expect(page).toHaveURL(new RegExp(`[?&]q=${word}`))
      await expect(page).toHaveURL(/[?&]page=2/)
      await expect(rows(page)).toHaveCount(2)
      await expect(rows(page).first()).toContainText(firstOnTwo)
    } finally {
      for (const id of made) await apiDelete(api, `/warehouse/product-category/${id}`)
    }
  })

  test('Warehouses: a search survives opening a warehouse and coming back', async ({ page }) => {
    const api = await apiLogin()
    const word = `Place${stamp()}`
    const res = await apiPost(api, '/warehouse/warehouse', { code: `P${word.slice(-6)}`, name: `E2E ${word}`, type: 'warehouse' })
    expect(res.ok).toBe(true)
    const body = await res.json()
    const id = String(body.warehouse?._id || body.warehouse?.id)
    try {
      await loginForApp(page)
      await page.goto('/inventory/warehouses')
      await expect(page.locator('.v-data-table')).toBeVisible({ timeout: 10000 })
      await page.getByLabel(/search/i).first().fill(word)
      await expect(page).toHaveURL(new RegExp(`[?&]q=${word}`), { timeout: 5000 })
      await expect(rows(page)).toHaveCount(1)

      await page.locator(`.v-data-table tbody a[href$="/warehouses/${id}/edit"]`).click()
      await page.waitForURL(new RegExp(`/inventory/warehouses/${id}/edit`))
      await page.waitForLoadState('networkidle')
      await page.goBack()
      await confirmLeaveIfAsked(page)
      await expect(page).toHaveURL(new RegExp(`[?&]q=${word}`))
      await expect(page.getByLabel(/search/i).first()).toHaveValue(word)
      await expect(rows(page)).toHaveCount(1)
      await expect(rows(page).first()).toContainText(word)
    } finally {
      await apiDelete(api, `/warehouse/warehouse/${id}`)
    }
  })

  test('Accounts: page two survives opening an account and coming back', async ({ page }) => {
    await loginForApp(page)
    await page.goto('/accounting/accounts')
    await expect(rows(page).first()).toBeVisible({ timeout: 10000 })
    const next = page.getByRole('button', { name: /next page/i })
    test.skip(await next.isDisabled(), 'the seeded chart has one page only')
    await next.click()
    await expect(page).toHaveURL(/[?&]page=2/, { timeout: 5000 })
    await page.waitForLoadState('networkidle')
    const firstOnTwo = (await rows(page).first().innerText()).split(/\s/)[0].trim()

    await rows(page).first().click()
    await page.waitForURL(/\/accounting\/accounts\/[0-9a-f]{24}\/edit/)
    await page.waitForLoadState('networkidle')
    await page.goBack()
    await confirmLeaveIfAsked(page)
    await expect(page).toHaveURL(/[?&]page=2/)
    await expect(rows(page).first()).toContainText(firstOnTwo)

    // The address can be shared: opened as it stands, it shows the same page.
    await page.goto(page.url())
    await expect(rows(page).first()).toContainText(firstOnTwo, { timeout: 10000 })
  })
})

test.describe('FR-31.19: Movements on the shared list shell', () => {
  test('a column hidden in the picker stays hidden; the address keeps its filters; no contact list is fetched', async ({ page }) => {
    await loginForApp(page)

    const seen: Request[] = []
    page.on('request', (r) => { if (new URL(r.url()).pathname.startsWith('/api/')) seen.push(r) })
    await page.goto('/inventory/movements?type=receipt&status=draft')
    await expect(page.locator('.v-data-table')).toBeVisible({ timeout: 10000 })
    await page.waitForLoadState('networkidle')
    await page.waitForTimeout(600) // past the debounced address write

    // Its filters and its address do not change: the list asked for what the address says, and the address still says it.
    await expect(page).toHaveURL(/[?&]type=receipt/)
    await expect(page).toHaveURL(/[?&]status=draft/)
    const listCalls = seen.filter((r) => /\/warehouse\/movement$/.test(new URL(r.url()).pathname))
    expect(listCalls.length).toBeGreaterThan(0)
    for (const r of listCalls) {
      const q = new URL(r.url()).searchParams
      expect({ type: q.get('type'), status: q.get('status') }).toEqual({ type: 'receipt', status: 'draft' })
    }
    // The contact list the page used to fetch, and never read, is not asked for.
    expect(seen.filter((r) => /\/invoicing\/contact$/.test(new URL(r.url()).pathname))).toEqual([])

    // The shell's column picker: Type goes, and stays gone after a reload (the choice is kept by the route's name).
    const typeHeader = page.locator('.v-data-table thead th').filter({ hasText: /^Type$/ })
    await expect(typeHeader).toHaveCount(1)
    await page.getByRole('button', { name: 'Columns' }).click()
    const dialog = page.getByRole('dialog')
    await dialog.locator('.v-list-item').filter({ has: page.locator('.v-list-item-title', { hasText: /^Type$/ }) }).getByRole('checkbox').click()
    await dialog.getByRole('button', { name: 'Close' }).last().click()
    await expect(typeHeader).toHaveCount(0)
    await page.reload()
    await expect(page.locator('.v-data-table')).toBeVisible({ timeout: 10000 })
    await expect(page.locator('.v-data-table thead th').filter({ hasText: /^Status$/ })).toHaveCount(1)
    await expect(typeHeader).toHaveCount(0)

    // Put it back, for whatever runs after.
    await page.getByRole('button', { name: 'Columns' }).click()
    await page.getByRole('dialog').getByRole('button', { name: 'Reset' }).click()
    await page.getByRole('dialog').getByRole('button', { name: 'Close' }).last().click()
    await expect(typeHeader).toHaveCount(1)
  })

  test('Stock levels and Inventory counts have the column picker too, and keep their address', async ({ page }) => {
    await loginForApp(page)
    for (const path of ['/inventory/stock-levels?low=true', '/inventory/inventory-counts?q=IC-']) {
      await page.goto(path)
      await expect(page.locator('.v-data-table')).toBeVisible({ timeout: 10000 })
      await page.waitForLoadState('networkidle')
      await expect(page.getByRole('button', { name: 'Columns' })).toBeVisible()
      await page.waitForTimeout(600)
      expect(page.url()).toContain(path.split('?')[1])
    }
  })
})
