import { test, expect } from '@playwright/test'
import { loginAsAdmin } from './helpers/login'

test.describe('Invite System', () => {
  test.describe('Invite Landing Page', () => {
    test('invalid invite code shows error', async ({ page }) => {
      await page.goto('/invite/invalid-code-that-does-not-exist')
      await page.waitForLoadState('networkidle')

      // Should show error card with "Invite Not Found"
      await expect(page.getByText('Invite Not Found')).toBeVisible({ timeout: 10000 })
      // Should have a "Go to Login" link/button
      await expect(page.getByRole('link', { name: /go to login/i })).toBeVisible()
    })

    test('invite landing page renders card for any code', async ({ page }) => {
      await page.goto('/invite/some-fake-code')
      await page.waitForLoadState('networkidle')
      // Card should be visible (either error or invite info)
      await expect(page.locator('.v-card')).toBeVisible({ timeout: 10000 })
    })
  })

  test.describe('Admin Invite Management', () => {
    test.beforeEach(async ({ page }) => {
      await loginAsAdmin(page)
    })

    test('admin can navigate to invites page', async ({ page }) => {
      await page.goto('/settings/invites')
      await page.waitForLoadState('networkidle')

      // Should show the invites heading
      await expect(page.getByRole('heading', { name: /invites/i })).toBeVisible()
      // Should show the "Create Invite" button
      await expect(page.getByRole('button', { name: /create invite/i })).toBeVisible()
      // Should show the data table
      await expect(page.locator('.v-data-table')).toBeVisible()
    })

    test('admin can open create invite dialog', async ({ page }) => {
      await page.goto('/settings/invites')
      await page.waitForLoadState('networkidle')

      // Click "Create Invite" button
      await page.getByRole('button', { name: /create invite/i }).click()

      // Dialog should appear
      const dialog = page.locator('.v-dialog')
      await expect(dialog).toBeVisible()
      await expect(dialog.locator('.v-card-title')).toContainText('Create Invite')

      // Should have radio buttons for shareable link and email
      await expect(dialog.getByText('Shareable Link')).toBeVisible()
      await expect(dialog.getByText('Email Invite')).toBeVisible()

      // Should have role selector
      await expect(dialog.getByLabel('Role')).toBeVisible()

      // Should have Create and Cancel buttons
      await expect(dialog.getByRole('button', { name: /create/i })).toBeVisible()
      await expect(dialog.getByRole('button', { name: /cancel/i })).toBeVisible()
    })

    test('admin can create a shareable invite', async ({ page }) => {
      await page.goto('/settings/invites')
      await page.waitForLoadState('networkidle')

      // Get initial row count
      const initialRows = await page.locator('.v-data-table tbody tr').count()

      // Click "Create Invite"
      await page.getByRole('button', { name: /create invite/i }).click()
      const dialog = page.locator('.v-dialog')
      await expect(dialog).toBeVisible()

      // "Shareable Link" is the default mode, just click Create
      await dialog.getByRole('button', { name: /^create$/i }).click()

      // Dialog should close
      await expect(dialog).toBeHidden({ timeout: 5000 })

      // Table should now have one more row with an active invite
      await page.waitForTimeout(1000)
      await expect(page.locator('.v-data-table tbody tr')).toHaveCount(initialRows + 1)
      await expect(page.locator('.v-chip', { hasText: 'active' }).first()).toBeVisible()
    })
  })

  test.describe('Register with Invite', () => {
    test('register page with invite param hides org fields and shows joining banner', async ({ page }) => {
      // Login as admin to create an invite first
      await loginAsAdmin(page)

      // Create an invite via the settings page
      await page.goto('/settings/invites')
      await page.waitForLoadState('networkidle')
      await page.getByRole('button', { name: /create invite/i }).click()
      const dialog = page.locator('.v-dialog')
      await expect(dialog).toBeVisible()
      await dialog.getByRole('button', { name: /^create$/i }).click()
      await expect(dialog).toBeHidden({ timeout: 5000 })

      // Get the invite code from the table
      await page.waitForTimeout(500)
      const codeEl = page.locator('.v-data-table tbody tr').first().locator('code')
      const inviteCode = await codeEl.textContent()

      // Logout
      await page.locator('.v-avatar').click()
      await page.getByText(/logout/i).click()
      await page.waitForURL('**/auth/login')

      // Go to register with invite code
      await page.goto(`/auth/register?invite=${inviteCode}`)
      await page.waitForLoadState('networkidle')

      // Should show "Joining" banner with org name
      await expect(page.getByText(/joining/i)).toBeVisible({ timeout: 10000 })

      // Organization Name and Organization Slug fields should NOT be visible
      await expect(page.getByLabel(/organization name/i)).toBeHidden()
      await expect(page.getByLabel(/organization slug/i)).toBeHidden()
    })
  })
})
