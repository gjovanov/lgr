import { test, expect } from '@playwright/test'
import { loginForApp } from './helpers/login'

// FR-05 (#12): grid state lives in the querystring — Back restores the exact view and
// URLs are shareable. Menus hover-open on desktop (Playwright runs a fine-pointer
// profile, so hover applies).
test.describe('Grid URL state + hover menus', () => {
  test('search lands in the URL and Back from a detail page restores it', async ({ page }) => {
    await loginForApp(page)
    await page.goto('/invoicing/invoices')
    await expect(page.locator('.v-data-table')).toBeVisible({ timeout: 10000 })

    // Type a search — after the 300ms debounce + 250ms write it must reach ?q=
    const searchInput = page.getByLabel(/search/i).first()
    await searchInput.fill('INV')
    await expect(page).toHaveURL(/[?&]q=INV/, { timeout: 5000 })

    // Navigate into any document (first number link), then browser Back.
    const firstLink = page.locator('.v-data-table tbody a').first()
    const hasRows = await firstLink.isVisible({ timeout: 5000 }).catch(() => false)
    test.skip(!hasRows, 'no documents seeded')
    await firstLink.click()
    await page.waitForURL(/\/(invoices|bills)\/[0-9a-f]+\/edit/)
    await page.goBack()

    // The URL still carries the search and the input shows it again.
    await expect(page).toHaveURL(/[?&]q=INV/)
    await expect(page.getByLabel(/search/i).first()).toHaveValue('INV')
  })

  test('a pasted URL reproduces the filtered state', async ({ page }) => {
    await loginForApp(page)
    await page.goto('/invoicing/invoices?q=INV&status=paid&size=25')
    await expect(page.locator('.v-data-table')).toBeVisible({ timeout: 10000 })
    await expect(page.getByLabel(/search/i).first()).toHaveValue('INV')
    // The bare URL stays clean: defaults are omitted, provided params kept.
    await expect(page).toHaveURL(/status=paid/)
    await expect(page).toHaveURL(/size=25/)
  })

  test('top-menu groups open on hover (desktop)', async ({ page }) => {
    await loginForApp(page)
    await page.goto('/invoicing/invoices')
    await expect(page.locator('.v-data-table')).toBeVisible({ timeout: 10000 })

    // Hover (no click) over the Outgoing Documents group must open its list.
    const group = page.getByRole('button', { name: /outgoing documents/i })
    await group.hover()
    await expect(page.locator('.v-overlay__content .v-list-item', { hasText: /proforma/i }))
      .toBeVisible({ timeout: 3000 })
  })
})
