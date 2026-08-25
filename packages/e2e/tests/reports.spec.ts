import { test, expect } from '@playwright/test'
import { loginForApp } from './helpers/login'

/**
 * FR-06 (#14) — the Reports app, end to end: hub renders → each card opens → the runner
 * runs and exports → the two legacy invoicing URLs redirect here.
 *
 * NOTE: no `import type` from '@playwright/test' in a SPEC file — under this repo's bunx
 * setup that fails the build with an opaque `BuildMessage {}`. Types belong in a helper
 * module (see tests/helpers/), which is why this file only imports values.
 */

const CARD = '.report-card'

test.describe('Reports app', () => {
  test('hub lists the report cards, grouped', async ({ page }) => {
    await loginForApp(page)
    await page.goto('/reports/')

    await expect(page.locator(CARD).first()).toBeVisible({ timeout: 15000 })
    // P1 ships three: the two moved invoicing pages plus the registry-driven valuation.
    expect(await page.locator(CARD).count()).toBeGreaterThanOrEqual(3)

    await expect(page.getByRole('heading', { name: /document export/i })).toBeVisible()
    await expect(page.getByRole('heading', { name: /aging report/i })).toBeVisible()
    await expect(page.getByRole('heading', { name: /inventory valuation/i })).toBeVisible()
  })

  test('hub search narrows the cards', async ({ page }) => {
    await loginForApp(page)
    await page.goto('/reports/')
    await expect(page.locator(CARD).first()).toBeVisible({ timeout: 15000 })

    await page.getByRole('textbox', { name: /search/i }).fill('aging')
    await expect(page.locator(CARD)).toHaveCount(1)
    await expect(page.getByRole('heading', { name: /aging report/i })).toBeVisible()
  })

  test('export card opens the moved export page with its three tabs', async ({ page }) => {
    await loginForApp(page)
    await page.goto('/reports/')
    await expect(page.locator(CARD).first()).toBeVisible({ timeout: 15000 })

    await page.getByRole('heading', { name: /document export/i }).click()
    await page.waitForURL(/\/reports\/export/, { timeout: 15000 })
    await expect(page.locator('.v-data-table').first()).toBeVisible({ timeout: 15000 })

    // Switching tabs is reflected in the URL (FR-05 state), so the link is shareable.
    await page.getByRole('tab').nth(1).click()
    await expect(page).toHaveURL(/[?&]tab=incoming/, { timeout: 10000 })
  })

  test('aging card opens the moved aging page', async ({ page }) => {
    await loginForApp(page)
    await page.goto('/reports/')
    await expect(page.locator(CARD).first()).toBeVisible({ timeout: 15000 })

    await page.getByRole('heading', { name: /aging report/i }).click()
    await page.waitForURL(/\/reports\/aging/, { timeout: 15000 })
    await expect(page.locator('.v-data-table').first()).toBeVisible({ timeout: 15000 })
  })

  test('registry-driven report runs and exports XLSX', async ({ page }) => {
    await loginForApp(page)
    await page.goto('/reports/inventory-valuation')

    // The runner auto-runs on mount, so the grid is the readiness signal.
    await expect(page.locator('.v-data-table').first()).toBeVisible({ timeout: 20000 })

    await page.getByRole('button', { name: /^export$/i }).click()
    await expect(page.locator('.v-overlay--active .v-card')).toBeVisible({ timeout: 5000 })

    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 30000 }),
      page.locator('.v-overlay--active').getByRole('button', { name: /^export$/i }).click(),
    ])
    expect(download.suggestedFilename()).toMatch(/inventory-valuation-\d{4}-\d{2}-\d{2}\.xlsx$/i)

    // Real bytes: XLSX is a ZIP, magic 'PK'.
    const stream = await download.createReadStream()
    if (stream) {
      const chunk = await new Promise<Buffer>((resolve) => {
        stream.once('data', (c: Buffer) => resolve(c))
      })
      expect(chunk[0]).toBe(0x50)
      expect(chunk[1]).toBe(0x4b)
    }
  })

  test('runner params ride in the URL and survive a reload', async ({ page }) => {
    await loginForApp(page)
    await page.goto('/reports/inventory-valuation')
    await expect(page.locator('.v-data-table').first()).toBeVisible({ timeout: 20000 })

    // Vuetify's v-switch renders a plain <input type="checkbox"> with an aria-label, so its
    // role is `checkbox`, not `switch` — getByRole('switch') matches nothing. Same family of
    // gotcha as the v-select/combobox one.
    await page.getByLabel(/include zero stock/i).check()
    await expect(page).toHaveURL(/[?&]includeZero=true/, { timeout: 10000 })

    await page.reload()
    await expect(page.getByLabel(/include zero stock/i)).toBeChecked({ timeout: 20000 })
  })

  // The app has no menu bar, so without this button a report page is a dead end for anyone
  // who arrived by favorite, shared link or redirect stub — there is no in-app history.
  for (const [name, path] of [
    ['export', '/reports/export'],
    ['aging', '/reports/aging'],
    ['runner', '/reports/inventory-valuation'],
  ] as const) {
    test(`back button returns from ${name} to the hub`, async ({ page }) => {
      await loginForApp(page)
      await page.goto(path)
      await expect(page.locator('.v-data-table').first()).toBeVisible({ timeout: 20000 })

      await page.getByRole('button', { name: /back to reports/i }).click()
      await page.waitForURL(/\/reports\/?$/, { timeout: 15000 })
      await expect(page.locator(CARD).first()).toBeVisible({ timeout: 15000 })
    })
  }

  test('unknown report id reports not-found rather than an empty grid', async ({ page }) => {
    await loginForApp(page)
    await page.goto('/reports/no-such-report')
    await expect(page.getByText(/does not exist, or you have no access/i)).toBeVisible({ timeout: 15000 })
  })
})

test.describe('Legacy invoicing report URLs', () => {
  test('/invoicing/aging-report redirects into the Reports app', async ({ page }) => {
    await loginForApp(page)
    await page.goto('/invoicing/aging-report')
    await page.waitForURL(/\/reports\/aging/, { timeout: 20000 })
    await expect(page.locator('.v-data-table').first()).toBeVisible({ timeout: 15000 })
  })

  test('/invoicing/reporting/export redirects and preserves the query string', async ({ page }) => {
    await loginForApp(page)
    await page.goto('/invoicing/reporting/export?tab=cash_register')
    await page.waitForURL(/\/reports\/export/, { timeout: 20000 })
    // FR-6.19a: an old bookmark's grid state must survive the hop.
    expect(page.url()).toContain('tab=cash_register')
  })

  test('the invoicing Reporting menu group is gone', async ({ page }) => {
    await loginForApp(page)
    await page.goto('/invoicing/')
    await expect(page.locator('.v-app-bar').first()).toBeVisible({ timeout: 15000 })
    // Both of its children moved, so the whole group went with them.
    await expect(page.getByRole('button', { name: /^reporting$/i })).toHaveCount(0)
  })
})
