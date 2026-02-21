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

  test('should render dashboard without error banners', async ({ page }) => {
    await loginAsAdmin(page)

    // Verify dashboard content is present (uses <h1 class="text-h4">)
    await expect(page.getByRole('heading', { name: /dashboard/i })).toBeVisible()

    // No error alerts should be visible
    await expect(page.locator('.v-alert[type="error"]')).not.toBeVisible()
    await expect(page.getByText(/something went wrong/i)).not.toBeVisible()
  })
})
