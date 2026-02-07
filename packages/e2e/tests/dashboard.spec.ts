import { test, expect } from '@playwright/test'
import { loginAsAdmin } from './helpers/login'

test.describe('Dashboard', () => {
  test('should load dashboard page after login and show heading', async ({ page }) => {
    await loginAsAdmin(page)

    await expect(page).toHaveURL(/dashboard/)
    // DashboardView uses <h1 class="text-h4">
    await expect(page.getByRole('heading', { name: /dashboard/i })).toBeVisible()
  })

  test('should display KPI cards with summary data', async ({ page }) => {
    await loginAsAdmin(page)

    // Total Revenue card - text is inside v-card-text within a div.text-body-2
    await expect(page.getByText(/total revenue/i)).toBeVisible()

    // Outstanding Invoices card
    await expect(page.getByText(/outstanding invoices/i)).toBeVisible()

    // Stock Value card
    await expect(page.getByText(/stock value/i)).toBeVisible()

    // Active Employees card
    await expect(page.getByText(/active employees/i)).toBeVisible()
  })

  test('should show quick action buttons', async ({ page }) => {
    await loginAsAdmin(page)

    // "Quick Actions" is rendered as v-card-title text
    await expect(page.getByText('Quick Actions')).toBeVisible()

    // Quick action buttons are v-btn with "to" prop, rendering as <a> elements with role="link"
    await expect(page.getByRole('link', { name: /new invoice/i })).toBeVisible()
    await expect(page.getByRole('link', { name: /new journal entry/i })).toBeVisible()
    await expect(page.getByRole('link', { name: /new product/i })).toBeVisible()
    await expect(page.getByRole('link', { name: /new lead/i })).toBeVisible()
  })

  test('should navigate to invoicing via quick action link', async ({ page }) => {
    await loginAsAdmin(page)

    await page.getByRole('link', { name: /new invoice/i }).click()
    await page.waitForURL('**/invoicing/sales/new', { timeout: 10000 })
    await expect(page).toHaveURL(/invoicing\/sales\/new/)
  })

  test('should render dashboard without error banners', async ({ page }) => {
    await loginAsAdmin(page)

    // Verify dashboard content is present (uses <h1 class="text-h4">)
    await expect(page.getByRole('heading', { name: /dashboard/i })).toBeVisible()

    // No error alerts should be visible
    await expect(page.locator('.v-alert[type="error"]')).not.toBeVisible()
    await expect(page.getByText(/something went wrong/i)).not.toBeVisible()

    // Recent Activity section is in a v-card-title
    await expect(page.locator('.v-card-title').filter({ hasText: /recent activity/i })).toBeVisible()
  })
})
