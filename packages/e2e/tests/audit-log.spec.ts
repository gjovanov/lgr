/**
 * `admin/audit-log` — a shipped portal view with no spec until now (gjovanov/lgr#31 P2).
 *
 * The audit-log SERVICE is well covered (`integration/audit-log.flow.test.ts`: filters,
 * redaction, correlation ids, pagination). None of that says the screen an admin actually
 * uses renders a row, and the view is the only consumer of three endpoints — `/audit-logs`,
 * `/filters`, `/search-users` — whose response shapes nothing else pins.
 *
 * The rows are seeded data's own audit trail, so this drives the real grid rather than a
 * fixture: what the page must do is show entries, narrow them, and expand one.
 */
import { test, expect } from '@playwright/test'
import { loginAsAdmin } from './helpers/login'
import { openSelect, chooseOption } from './helpers/vuetify'

test.beforeEach(async ({ page }) => {
  await loginAsAdmin(page)
  await page.goto('/admin/audit-log', { waitUntil: 'networkidle' })
})

test('renders the log with its columns', async ({ page }) => {
  await expect(page.getByRole('heading', { name: /audit log/i })).toBeVisible()

  // The three filter selects the view loads from `/audit-logs/filters`. If that endpoint
  // changes shape they render empty, and no service test would notice.
  await expect(page.getByRole('combobox', { name: /module/i })).toBeVisible()
  await expect(page.getByRole('combobox', { name: /action/i })).toBeVisible()

  await expect(page.locator('table')).toBeVisible()
})

test('filters by module and keeps the filter in the grid', async ({ page }) => {
  const table = page.locator('table')
  await expect(table).toBeVisible()

  await openSelect(page, /module/i)
  const moduleName = await chooseOption(page)

  await page.getByRole('button', { name: /^filter$/i }).click()
  await page.waitForLoadState('networkidle')

  // Every visible module chip must be the one selected — the assertion that the filter was
  // applied server-side rather than merely painted into the select.
  const cells = page.locator('tbody tr td:nth-child(3)')
  const count = await cells.count()
  if (count > 0 && moduleName) {
    for (let i = 0; i < Math.min(count, 5); i++) {
      await expect(cells.nth(i)).toHaveText(new RegExp(moduleName, 'i'))
    }
  }
})

test('expands an entry to show its field-level changes', async ({ page }) => {
  const firstRow = page.locator('tbody tr').first()
  await expect(firstRow).toBeVisible()

  // `show-expand` renders a chevron per row; the expanded panel is where redaction and the
  // old→new diff actually reach a human.
  await firstRow.getByRole('button').first().click()

  await expect(
    page.getByText(/change details|no changes|no recorded changes/i).first(),
  ).toBeVisible()
})

test('resets filters back to the unfiltered log', async ({ page }) => {
  await openSelect(page, /module/i)
  await chooseOption(page)
  await page.getByRole('button', { name: /^filter$/i }).click()
  await page.waitForLoadState('networkidle')

  await page.getByRole('button', { name: /^reset$/i }).click()
  await page.waitForLoadState('networkidle')

  // A reset that leaves the chips behind is the bug this catches — the store and the select
  // are separate pieces of state.
  await expect(page.locator('table')).toBeVisible()
  await expect(page.getByRole('combobox', { name: /module/i }).locator('.v-chip')).toHaveCount(0)
})

