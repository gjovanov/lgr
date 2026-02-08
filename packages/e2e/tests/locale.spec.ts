import { test, expect } from '@playwright/test'
import { loginAsAdmin, loginAs } from './helpers/login'

test.describe('Locale Switching', () => {
  test('should show English nav labels by default after login', async ({ page }) => {
    await loginAsAdmin(page)

    const drawer = page.locator('.v-navigation-drawer')
    await expect(drawer.locator('.v-list-item-title', { hasText: /^Dashboard$/ })).toBeVisible()
    await expect(drawer.locator('.v-list-item-title', { hasText: /^Accounting$/ })).toBeVisible()
    await expect(drawer.locator('.v-list-item-title', { hasText: /^Warehouse$/ })).toBeVisible()
    await expect(drawer.locator('.v-list-item-title', { hasText: /^Payroll$/ })).toBeVisible()
    await expect(drawer.locator('.v-list-item-title', { hasText: /^HR$/ })).toBeVisible()
  })

  test('should switch to Bulgarian labels when clicking BG', async ({ page }) => {
    await loginAsAdmin(page)

    // Click BG locale button
    await page.locator('.v-app-bar').getByRole('button', { name: 'BG' }).click()
    await page.waitForTimeout(500)

    const drawer = page.locator('.v-navigation-drawer')
    await expect(drawer.locator('.v-list-item-title', { hasText: /^Табло$/ })).toBeVisible()
    await expect(drawer.locator('.v-list-item-title', { hasText: /^Счетоводство$/ })).toBeVisible()
    await expect(drawer.locator('.v-list-item-title', { hasText: /^Склад$/ })).toBeVisible()
    await expect(drawer.locator('.v-list-item-title', { hasText: /^Заплати$/ })).toBeVisible()
    await expect(drawer.locator('.v-list-item-title', { hasText: /^Човешки ресурси$/ })).toBeVisible()
  })

  test('should switch to German labels when clicking DE', async ({ page }) => {
    await loginAsAdmin(page)

    // Click DE locale button
    await page.locator('.v-app-bar').getByRole('button', { name: 'DE' }).click()
    await page.waitForTimeout(500)

    const drawer = page.locator('.v-navigation-drawer')
    await expect(drawer.locator('.v-list-item-title', { hasText: /^Dashboard$/ })).toBeVisible()
    await expect(drawer.locator('.v-list-item-title', { hasText: /^Buchhaltung$/ })).toBeVisible()
    await expect(drawer.locator('.v-list-item-title', { hasText: /^Lager$/ })).toBeVisible()
    await expect(drawer.locator('.v-list-item-title', { hasText: /^Lohnabrechnung$/ })).toBeVisible()
    await expect(drawer.locator('.v-list-item-title', { hasText: /^Personal$/ })).toBeVisible()
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
    await expect(drawer.locator('.v-list-item-title', { hasText: /^Accounting$/ })).toBeVisible()
    await expect(drawer.locator('.v-list-item-title', { hasText: /^Warehouse$/ })).toBeVisible()
  })

  test('should translate page content when navigating to Warehouse > Products in BG', async ({ page }) => {
    await loginAsAdmin(page)

    // Switch to BG
    await page.locator('.v-app-bar').getByRole('button', { name: 'BG' }).click()
    await page.waitForTimeout(500)

    // Navigate to Warehouse > Products
    const drawer = page.locator('.v-navigation-drawer')
    await drawer.getByText('Склад').first().click()
    await page.waitForTimeout(300)
    await drawer.getByRole('link', { name: /^Продукти$/ }).click()
    await page.waitForURL('**/warehouse/products', { timeout: 10000 })

    // Page heading should be in Bulgarian
    await expect(page.getByRole('heading', { name: /Продукти/i })).toBeVisible({ timeout: 5000 })
  })

  test('should translate page content when navigating to Payroll > Employees in DE', async ({ page }) => {
    await loginAsAdmin(page)

    // Switch to DE
    await page.locator('.v-app-bar').getByRole('button', { name: 'DE' }).click()
    await page.waitForTimeout(500)

    // Navigate to Payroll > Employees
    const drawer = page.locator('.v-navigation-drawer')
    await drawer.getByText('Lohnabrechnung').first().click()
    await page.waitForTimeout(300)
    await drawer.getByRole('link', { name: /^Mitarbeiter$/ }).click()
    await page.waitForURL('**/payroll/employees', { timeout: 10000 })

    // Page heading should be in German
    await expect(page.getByRole('heading', { name: /Mitarbeiter/i })).toBeVisible({ timeout: 5000 })
  })

  test('should not show any literal $t: strings on pages', async ({ page }) => {
    await loginAsAdmin(page)

    // Navigate to Accounting > Chart of Accounts (was using $t: prefix pattern)
    const drawer = page.locator('.v-navigation-drawer')
    await drawer.getByText('Accounting').first().click()
    await page.waitForTimeout(300)
    await drawer.getByRole('link', { name: /chart of accounts/i }).click()
    await page.waitForURL('**/accounting/accounts', { timeout: 10000 })

    // Check no literal $t: strings are visible
    const bodyText = await page.locator('body').innerText()
    expect(bodyText).not.toContain('$t:')
  })

  test('should not show $t: strings in other accounting views', async ({ page }) => {
    await loginAsAdmin(page)

    const drawer = page.locator('.v-navigation-drawer')

    // Check Bank Accounts
    await drawer.getByText('Accounting').first().click()
    await page.waitForTimeout(300)
    await drawer.getByRole('link', { name: /bank accounts/i }).click()
    await page.waitForURL('**/accounting/bank-accounts', { timeout: 10000 })
    let bodyText = await page.locator('body').innerText()
    expect(bodyText).not.toContain('$t:')

    // Check Exchange Rates
    await drawer.getByRole('link', { name: /exchange rates/i }).click()
    await page.waitForURL('**/accounting/exchange-rates', { timeout: 10000 })
    bodyText = await page.locator('body').innerText()
    expect(bodyText).not.toContain('$t:')
  })

  test('should work for Regal org (BG locale)', async ({ page }) => {
    await loginAs(page, 'regal', 'rdodova', 'Rd123456')

    // Switch to BG
    await page.locator('.v-app-bar').getByRole('button', { name: 'BG' }).click()
    await page.waitForTimeout(500)

    const drawer = page.locator('.v-navigation-drawer')
    await expect(drawer.locator('.v-list-item-title', { hasText: /^Табло$/ })).toBeVisible()
    await expect(drawer.locator('.v-list-item-title', { hasText: /^Склад$/ })).toBeVisible()

    // Navigate to Warehouse > Products
    await drawer.getByText('Склад').first().click()
    await page.waitForTimeout(300)
    await drawer.getByRole('link', { name: /^Продукти$/ }).click()
    await page.waitForURL('**/warehouse/products', { timeout: 10000 })
    await expect(page.getByRole('heading', { name: /Продукти/i })).toBeVisible({ timeout: 5000 })
  })
})
