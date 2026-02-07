import { test, expect } from '@playwright/test'

test.describe('Authentication', () => {
  test('should show login page', async ({ page }) => {
    await page.goto('/auth/login')
    // v-card-title renders as a div, not a heading element
    await expect(page.locator('.v-card-title', { hasText: /sign in/i })).toBeVisible()
  })

  test('should login with valid credentials and redirect to dashboard', async ({ page }) => {
    await page.goto('/auth/login', { waitUntil: 'networkidle' })

    // Use seeded credentials: acme-corp / admin / test123
    await page.getByRole('textbox', { name: /organization/i }).fill('acme-corp')
    await page.getByRole('textbox', { name: /username/i }).fill('admin')
    await page.getByRole('textbox', { name: /password/i }).fill('test123')
    await page.getByRole('button', { name: /sign in/i }).click()

    // Wait for redirect to dashboard
    await page.waitForURL('**/dashboard', { timeout: 15000 })
    await expect(page).toHaveURL(/dashboard/)
  })

  test('should reject invalid credentials', async ({ page }) => {
    await page.goto('/auth/login', { waitUntil: 'networkidle' })

    await page.getByRole('textbox', { name: /organization/i }).fill('acme-corp')
    await page.getByRole('textbox', { name: /username/i }).fill('admin')
    await page.getByRole('textbox', { name: /password/i }).fill('wrong-password')
    await page.getByRole('button', { name: /sign in/i }).click()

    // Error appears in a v-alert; the message comes from the API
    await expect(page.locator('.v-alert')).toBeVisible({ timeout: 10000 })
    await expect(page).toHaveURL(/auth\/login/)
  })

  test('should show error for non-existent organization', async ({ page }) => {
    await page.goto('/auth/login', { waitUntil: 'networkidle' })

    await page.getByRole('textbox', { name: /organization/i }).fill('non-existent-org')
    await page.getByRole('textbox', { name: /username/i }).fill('admin')
    await page.getByRole('textbox', { name: /password/i }).fill('test123')
    await page.getByRole('button', { name: /sign in/i }).click()

    // Error appears in a v-alert
    await expect(page.locator('.v-alert')).toBeVisible({ timeout: 10000 })
  })

  test('should redirect to login when not authenticated', async ({ page }) => {
    await page.goto('/dashboard')
    await expect(page).toHaveURL(/auth\/login/)
  })

  test('should show register page', async ({ page }) => {
    await page.goto('/auth/register')
    // v-card-title renders as a div, not a heading element
    await expect(page.locator('.v-card-title', { hasText: /create account/i })).toBeVisible()
  })
})
