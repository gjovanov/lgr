import { test, expect } from '@playwright/test'
import { loginAsAdmin } from './helpers/login'

test.describe('Settings Module', () => {
  test('should navigate to /settings/organization and render org settings form', async ({ page }) => {
    await loginAsAdmin(page)
    await page.goto('/settings/organization')
    await expect(page).toHaveURL(/settings\/organization/)

    // OrganizationView uses <h1 class="text-h4 mb-6">
    await expect(page.getByRole('heading', { name: /organization/i })).toBeVisible()

    // The page wraps content in a <v-form> which renders as <form>
    await expect(page.locator('form')).toBeVisible()
  })

  test('organization settings should show name and currency fields', async ({ page }) => {
    await loginAsAdmin(page)
    await page.goto('/settings/organization')
    await expect(page).toHaveURL(/settings\/organization/)

    // Name field (v-text-field with label common.name = "Name")
    await expect(page.getByLabel(/name/i).first()).toBeVisible()

    // Base currency select - v-select labels are aria-hidden when value selected, use combobox role
    await expect(page.getByRole('combobox', { name: /base currency/i })).toBeVisible()
  })

  test('should navigate to /settings/users and render users list', async ({ page }) => {
    await loginAsAdmin(page)
    await page.goto('/settings/users')
    await expect(page).toHaveURL(/settings\/users/)

    // UsersView uses <h1 class="text-h4">
    await expect(page.getByRole('heading', { name: /users/i })).toBeVisible()

    // UsersView uses DataTable component which renders a v-data-table inside a v-card
    await expect(page.locator('.v-data-table')).toBeVisible()

    // Create button should be visible (i18n key: common.create)
    await expect(page.getByRole('button', { name: /create/i })).toBeVisible()
  })

  test('users list should show role column', async ({ page }) => {
    await loginAsAdmin(page)
    await page.goto('/settings/users')
    await expect(page).toHaveURL(/settings\/users/)

    // The table headers should include a "Role" column (i18n key: settings.role)
    // Header is rendered as th element within v-data-table
    await expect(page.locator('thead th').filter({ hasText: /role/i })).toBeVisible()
  })

  test('organization settings page should have a save button', async ({ page }) => {
    await loginAsAdmin(page)
    await page.goto('/settings/organization')
    await expect(page).toHaveURL(/settings\/organization/)

    // Save button (i18n key: common.save)
    await expect(page.getByRole('button', { name: /save/i })).toBeVisible()
  })

  test('organization settings should show tax configuration section', async ({ page }) => {
    await loginAsAdmin(page)
    await page.goto('/settings/organization')
    await expect(page).toHaveURL(/settings\/organization/)

    // Tax Configuration card title (v-card-title with i18n key: settings.taxConfig)
    await expect(page.locator('.v-card-title').filter({ hasText: /tax config/i })).toBeVisible()

    // VAT enabled switch (v-switch with i18n key: settings.vatEnabled)
    await expect(page.getByText(/vat enabled/i)).toBeVisible()
  })

  test('users view should have invite user button', async ({ page }) => {
    await loginAsAdmin(page)
    await page.goto('/settings/users')
    await expect(page).toHaveURL(/settings\/users/)

    // Invite User button (i18n key: settings.inviteUser)
    await expect(page.getByRole('button', { name: /invite/i })).toBeVisible()
  })
})
