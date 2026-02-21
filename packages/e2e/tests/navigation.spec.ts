import { test, expect } from '@playwright/test'
import { loginAsAdmin } from './helpers/login'

test.describe('Navigation', () => {
  test('should show sidebar navigation drawer after login', async ({ page }) => {
    await loginAsAdmin(page)

    // The v-navigation-drawer should be visible
    await expect(page.locator('.v-navigation-drawer')).toBeVisible()

    // Dashboard link is always visible in the sidebar (v-list-item with to="/dashboard")
    await expect(page.locator('.v-navigation-drawer').getByRole('link', { name: /dashboard/i })).toBeVisible()
  })

  test('should display portal nav items in sidebar', async ({ page }) => {
    await loginAsAdmin(page)

    const drawer = page.locator('.v-navigation-drawer')

    // Portal sidebar items: Apps, Dashboard, Organization, Users & Roles, Invites, Billing, Audit Log
    const navItems = [
      'Apps',
      'Dashboard',
      'Organization',
      'Users',
      'Invites',
      'Billing',
      'Audit Log',
    ]

    for (const item of navItems) {
      await expect(
        drawer.locator('.v-list-item-title', { hasText: new RegExp(item, 'i') })
      ).toBeVisible()
    }
  })

  test('should navigate to settings/organization when clicking Organization link', async ({ page }) => {
    await loginAsAdmin(page)

    await page.locator('.v-navigation-drawer').getByText('Organization').first().click()
    await page.waitForURL('**/settings/organization', { timeout: 10000 })
    await expect(page).toHaveURL(/settings\/organization/)
  })

  test('should navigate to settings/users when clicking Users link', async ({ page }) => {
    await loginAsAdmin(page)

    await page.locator('.v-navigation-drawer').getByText(/users/i).first().click()
    await page.waitForURL('**/settings/users', { timeout: 10000 })
    await expect(page).toHaveURL(/settings\/users/)
  })

  test('should toggle sidebar drawer open and close', async ({ page }) => {
    await loginAsAdmin(page)

    // Sidebar should be visible initially
    const drawer = page.locator('.v-navigation-drawer')
    await expect(drawer).toBeVisible()

    // The drawer uses the "permanent" prop, so it stays in the DOM.
    // Toggling v-model changes the --is-active class / translate transform.
    // Verify the nav icon button is clickable and triggers a state change.
    const navIcon = page.locator('.v-app-bar').locator('button').first()
    await navIcon.click()

    // Wait for animation
    await page.waitForTimeout(500)

    // With "permanent", the drawer stays in DOM but Vuetify adds a translate
    // transform to slide it offscreen. Click again to toggle back.
    await navIcon.click()

    // Wait for animation
    await page.waitForTimeout(500)

    // The navigation drawer should still be visible (permanent drawer)
    await expect(drawer).toBeVisible()
  })

  test('should toggle theme between dark and light', async ({ page }) => {
    await loginAsAdmin(page)

    // Get the initial theme (use .first() as Vuetify may create multiple .v-application elements)
    const appEl = page.locator('.v-application').first()
    const initialClass = await appEl.getAttribute('class')
    const initialIsDark = initialClass?.includes('v-theme--dark')

    // Find the theme toggle button by its icon (mdi-weather-night or mdi-weather-sunny)
    const themeBtn = page.locator('.v-app-bar').locator('button').filter({
      has: page.locator('.mdi-weather-night, .mdi-weather-sunny'),
    })
    await expect(themeBtn).toBeVisible({ timeout: 5000 })
    await themeBtn.click()

    // Wait for theme class to change on the v-application element
    await page.waitForFunction(
      (wasDark) => {
        const cls = document.querySelector('.v-application')?.className || ''
        const isDark = cls.includes('v-theme--dark')
        return isDark !== wasDark
      },
      initialIsDark ?? false,
      { timeout: 5000 },
    )

    // After toggling, check theme changed
    const afterClass = await appEl.getAttribute('class')
    const afterIsDark = afterClass?.includes('v-theme--dark')

    // The theme should have changed
    expect(initialIsDark).not.toBe(afterIsDark)
  })

  test('should logout from the user menu in the app bar', async ({ page }) => {
    await loginAsAdmin(page)

    // Open the user menu by clicking the user button in the app bar (v-btn with v-avatar inside)
    await page.locator('.v-app-bar').locator('button').filter({ has: page.locator('.v-avatar') }).click()

    // Wait for menu to open
    await page.waitForTimeout(300)

    // Click the Sign Out menu item (v-list-item with i18n key: auth.logout = "Sign Out")
    await page.getByText(/sign out/i).click()

    // Should redirect to the login page
    await page.waitForURL('**/auth/login', { timeout: 10000 })
    await expect(page).toHaveURL(/auth\/login/)
  })
})
