import { test, expect } from '@playwright/test'
import { loginForApp } from './helpers/login'
import { openSelect } from './helpers/vuetify'

// FR-05 (#12): grid state lives in the querystring — Back restores the exact view and
// URLs are shareable. Menus hover-open on desktop (Playwright runs a fine-pointer
// profile, so hover applies).
/** status= present and Voided un-ticked (the filter the test sets). */
const NO_VOIDED = /[?&]status=(?![^&]*voided)[^&]+/
/** A document number link (not the empty state's Create link). */
const DOC_LINK = '.v-data-table tbody a[href$="/edit"]'

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

  test('filters survive opening a document and returning by the form\'s Back button', async ({ page }) => {
    await loginForApp(page)
    await page.goto('/invoicing/invoices')
    await expect(page.locator('.v-data-table')).toBeVisible({ timeout: 10000 })

    // A real status filter that still keeps (nearly) every row. The list opens with every
    // status selected, so un-ticking Voided narrows it to the other five.
    await openSelect(page, /^status$/i)
    await page.getByRole('option', { name: /^voided$/i }).click()
    await page.keyboard.press('Escape')
    await expect(page).toHaveURL(NO_VOIDED, { timeout: 5000 })
    await page.getByLabel(/search/i).first().fill('INV')
    await expect(page).toHaveURL(/[?&]q=INV/, { timeout: 5000 })

    const firstLink = page.locator(DOC_LINK).first()
    const hasRows = await firstLink.isVisible({ timeout: 5000 }).catch(() => false)
    test.skip(!hasRows, 'no documents seeded')

    // 1. The form's own Back button — it pushes the bare list path, which used to drop
    //    every filter.
    await firstLink.click()
    await page.waitForURL(/\/(invoices|bills)\/[0-9a-f]+\/edit/)
    await page.waitForLoadState('networkidle')
    await page.getByTestId('form-back').click()
    // An untouched seeded invoice can still trip the leave guard ("Unsaved changes") — a
    // separate issue; confirming is what a user would do, and it must not cost the filters.
    const confirmLeave = page.getByRole('dialog').getByRole('button', { name: /confirm/i })
    if (await confirmLeave.isVisible({ timeout: 2000 }).catch(() => false)) await confirmLeave.click()
    await expect(page).toHaveURL(/\/invoicing\/invoices(\?|$)/)
    await expect(page).toHaveURL(/[?&]q=INV/)
    await expect(page).toHaveURL(NO_VOIDED)
    await expect(page.getByLabel(/search/i).first()).toHaveValue('INV')

    // 2. Browser Back from the document.
    await page.locator(DOC_LINK).first().click()
    await page.waitForURL(/\/(invoices|bills)\/[0-9a-f]+\/edit/)
    await page.goBack()
    await expect(page).toHaveURL(/[?&]q=INV/)
    await expect(page).toHaveURL(NO_VOIDED)
    await expect(page.getByLabel(/search/i).first()).toHaveValue('INV')

    // 3. A fresh load of the bare URL opens the defaults — the memory is for in-app returns,
    //    not a sticky filter nobody can get rid of. Every status selected is the default, so
    //    the URL stays bare (FR-22.15: it used to fill up with the whole status list).
    await page.goto('/invoicing/invoices')
    await expect(page.locator('.v-data-table')).toBeVisible({ timeout: 10000 })
    await expect(page.getByLabel(/search/i).first()).toHaveValue('')
    await expect(page).not.toHaveURL(/[?&]q=/)
    await page.waitForTimeout(600) // past the 250 ms debounced URL write
    await expect(page).not.toHaveURL(/[?&](status|type)=/)
    await expect(page.locator('.v-field').filter({ hasText: /^status/i }).first()).toContainText(/all statuses/i)
  })

  test('an old bookmark that listed every status still shows every document', async ({ page }) => {
    await loginForApp(page)
    // What the proforma list wrote into every URL before FR-22.15 — two of these statuses do
    // not exist, and „voided" was missing.
    await page.goto('/invoicing/proforma?status=draft,sent,accepted,converted,expired')
    await expect(page.locator('.v-data-table')).toBeVisible({ timeout: 10000 })
    await expect(page.locator('.v-field').filter({ hasText: /^status/i }).first()).toContainText(/all statuses/i)
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
