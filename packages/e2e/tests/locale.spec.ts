import { test, expect } from '@playwright/test'
import { loginAsAdmin } from './helpers/login'

test.describe('Locale Switching', () => {
  test('should show English nav labels by default after login', async ({ page }) => {
    await loginAsAdmin(page)

    const drawer = page.locator('.v-navigation-drawer')
    await expect(drawer.locator('.v-list-item-title', { hasText: /^Dashboard$/ })).toBeVisible()
    await expect(drawer.locator('.v-list-item-title', { hasText: /Organization/i })).toBeVisible()
    await expect(drawer.locator('.v-list-item-title', { hasText: /Audit Log/i })).toBeVisible()
  })

  test('should switch to Bulgarian labels when clicking BG', async ({ page }) => {
    await loginAsAdmin(page)

    // Click BG locale button
    await page.locator('.v-app-bar').getByRole('button', { name: 'BG' }).click()
    await page.waitForTimeout(500)

    const drawer = page.locator('.v-navigation-drawer')
    await expect(drawer.locator('.v-list-item-title', { hasText: /^Табло$/ })).toBeVisible()
    await expect(drawer.locator('.v-list-item-title', { hasText: /Организация/i })).toBeVisible()
    await expect(drawer.locator('.v-list-item-title', { hasText: /Одитен дневник/i })).toBeVisible()
  })

  test('should switch to German labels when clicking DE', async ({ page }) => {
    await loginAsAdmin(page)

    // Click DE locale button
    await page.locator('.v-app-bar').getByRole('button', { name: 'DE' }).click()
    await page.waitForTimeout(500)

    const drawer = page.locator('.v-navigation-drawer')
    await expect(drawer.locator('.v-list-item-title', { hasText: /^Dashboard$/ })).toBeVisible()
    await expect(drawer.locator('.v-list-item-title', { hasText: /Organisation/i })).toBeVisible()
    await expect(drawer.locator('.v-list-item-title', { hasText: /Prüfprotokoll/i })).toBeVisible()
  })

  test('should return to English labels when clicking EN after switching', async ({ page }) => {
    await loginAsAdmin(page)

    // Switch to BG first
    await page.locator('.v-app-bar').getByRole('button', { name: 'BG' }).click()
    await page.waitForTimeout(500)

    // Switch back to EN
    await page.locator('.v-app-bar').getByRole('button', { name: 'EN' }).click()
    await page.waitForTimeout(500)

    const drawer = page.locator('.v-navigation-drawer')
    await expect(drawer.locator('.v-list-item-title', { hasText: /^Dashboard$/ })).toBeVisible()
    await expect(drawer.locator('.v-list-item-title', { hasText: /Organization/i })).toBeVisible()
    await expect(drawer.locator('.v-list-item-title', { hasText: /Audit Log/i })).toBeVisible()
  })

  test('should translate dashboard heading when switching to BG', async ({ page }) => {
    await loginAsAdmin(page)

    // Switch to BG
    await page.locator('.v-app-bar').getByRole('button', { name: 'BG' }).click()
    await page.waitForTimeout(500)

    // Navigate to dashboard
    await page.goto('/dashboard', { waitUntil: 'networkidle' })

    // Dashboard heading should be translated
    await expect(page.getByRole('heading', { name: /табло/i })).toBeVisible({ timeout: 5000 })
  })

  test('should navigate to settings/organization and verify page renders in BG', async ({ page }) => {
    await loginAsAdmin(page)

    // Switch to BG
    await page.locator('.v-app-bar').getByRole('button', { name: 'BG' }).click()
    await page.waitForTimeout(500)

    // Navigate to Organization settings
    const drawer = page.locator('.v-navigation-drawer')
    await drawer.getByText('Организация').first().click()
    await page.waitForURL('**/settings/organization', { timeout: 10000 })

    // Verify page loaded without errors
    await expect(page.locator('.v-alert[type="error"]')).not.toBeVisible()
  })

  test('should not show any literal $t: strings on pages', async ({ page }) => {
    await loginAsAdmin(page)

    // Navigate to dashboard
    await page.goto('/dashboard', { waitUntil: 'networkidle' })

    // Check no literal $t: strings are visible
    const bodyText = await page.locator('body').innerText()
    expect(bodyText).not.toContain('$t:')
  })

  test('should not show $t: strings in settings views', async ({ page }) => {
    await loginAsAdmin(page)

    // Check Organization settings
    await page.goto('/settings/organization', { waitUntil: 'networkidle' })
    let bodyText = await page.locator('body').innerText()
    expect(bodyText).not.toContain('$t:')

    // Check Users settings
    await page.goto('/settings/users', { waitUntil: 'networkidle' })
    bodyText = await page.locator('body').innerText()
    expect(bodyText).not.toContain('$t:')
  })
})
