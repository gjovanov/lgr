import { test, expect } from '@playwright/test'
import { loginForApp } from './helpers/login'

test.describe('ERP Module', () => {
  test('should navigate to /erp/bom and render data table', async ({ page }) => {
    await loginForApp(page)
    await page.goto('/erp/bom')
    await expect(page).toHaveURL(/erp\/bom/)

    // BillOfMaterialsView uses <h1 class="text-h4"> with i18n key erp.billOfMaterials
    await expect(page.getByRole('heading', { name: /bills of materials/i })).toBeVisible()

    // Data table should be present (uses v-data-table directly)
    await expect(page.locator('.v-data-table')).toBeVisible()

    // Create button should be visible
    await expect(page.getByRole('button', { name: /create/i })).toBeVisible()
  })

  test('should navigate to /erp/production-orders and render list', async ({ page }) => {
    await loginForApp(page)
    await page.goto('/erp/production-orders')
    await expect(page).toHaveURL(/erp\/production-orders/)

    // ProductionOrdersView uses <h1 class="text-h4"> with i18n key erp.productionOrders
    await expect(page.getByRole('heading', { name: /production orders/i })).toBeVisible()

    // Data table should be present
    await expect(page.locator('.v-data-table')).toBeVisible()

    // Create button should be visible
    await expect(page.getByRole('button', { name: /create/i })).toBeVisible()
  })

  test('should navigate to /erp/construction-projects and render project list', async ({ page }) => {
    await loginForApp(page)
    await page.goto('/erp/construction-projects')
    await expect(page).toHaveURL(/erp\/construction-projects/)

    // ConstructionProjectsView uses <h1 class="text-h4"> with i18n key erp.constructionProjects
    await expect(page.getByRole('heading', { name: /construction projects/i })).toBeVisible()

    // Data table with project columns
    await expect(page.locator('.v-data-table')).toBeVisible()

    // Create button should be visible
    await expect(page.getByRole('button', { name: /create/i })).toBeVisible()
  })

  test('should navigate to /erp/pos and render POS view', async ({ page }) => {
    await loginForApp(page)
    await page.goto('/erp/pos')
    await expect(page).toHaveURL(/erp\/pos/)

    // POSView uses <h1 class="text-h5"> with i18n key erp.pos = "Point of Sale"
    await expect(page.getByRole('heading', { name: /point of sale/i })).toBeVisible()

    // Initially shows "no active session" state with an "Open Session" button
    // or if a session is already open, shows the cart area
    const openSessionBtn = page.getByRole('button', { name: /open session/i })
    const cartTitle = page.locator('.v-card-title', { hasText: /cart/i })
    await expect(openSessionBtn.or(cartTitle)).toBeVisible()
  })

  test('should open BOM create form via dialog', async ({ page }) => {
    await loginForApp(page)
    await page.goto('/erp/bom')
    await expect(page).toHaveURL(/erp\/bom/)

    // Click the create button to open the dialog
    await page.getByRole('button', { name: /create/i }).click()

    // Dialog form should appear with name, version, and status fields
    await expect(page.locator('.v-dialog')).toBeVisible()
    await expect(page.locator('.v-dialog .v-card-title')).toBeVisible()
    await expect(page.locator('.v-dialog .v-form')).toBeVisible()
  })

  test('should open Construction project create form via dialog', async ({ page }) => {
    await loginForApp(page)
    await page.goto('/erp/construction-projects')
    await expect(page).toHaveURL(/erp\/construction-projects/)

    // Click the create button to open the dialog
    await page.getByRole('button', { name: /create/i }).click()

    // Dialog form should appear with name, project code, and status fields
    await expect(page.locator('.v-dialog')).toBeVisible()
    await expect(page.locator('.v-dialog .v-card-title')).toBeVisible()
    await expect(page.locator('.v-dialog .v-form')).toBeVisible()
  })
})
