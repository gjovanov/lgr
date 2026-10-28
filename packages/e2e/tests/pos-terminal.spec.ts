import { test, expect } from '@playwright/test'
import { loginForApp } from './helpers/login'

test.describe('POS Terminal', () => {
  test('should navigate to POS Terminal and verify heading renders', async ({ page }) => {
    await loginForApp(page)
    await page.goto('/pos/terminal')
    await page.waitForLoadState('networkidle')

    await expect(page.getByRole('heading', { name: /POS Terminal/i })).toBeVisible()
  })

  test('should show "Open Session" button when no active session', async ({ page }) => {
    await loginForApp(page)
    await page.goto('/pos/terminal')
    await page.waitForLoadState('networkidle')

    // When there is no active session, the "Open Session" button should be visible
    await expect(page.getByRole('button', { name: /Open Session/i })).toBeVisible({ timeout: 10000 })
  })

  test('should open session dialog with warehouse select when clicking "Open Session"', async ({ page }) => {
    await loginForApp(page)
    await page.goto('/pos/terminal')
    await page.waitForLoadState('networkidle')

    // Click "Open Session" button
    const openBtn = page.getByRole('button', { name: /Open Session/i })
    await expect(openBtn).toBeVisible({ timeout: 10000 })
    await openBtn.click()

    // Verify dialog opens
    const dialog = page.locator('.v-dialog')
    await expect(dialog).toBeVisible({ timeout: 5000 })

    // Verify dialog has warehouse select (Vuetify v-select)
    await expect(dialog.getByRole('combobox', { name: /Warehouse/i })).toBeVisible()

    // Verify dialog has opening balance field
    await expect(dialog.getByLabel(/Opening Balance/i)).toBeVisible()

    // Verify dialog has Cancel and Open Session buttons
    await expect(dialog.getByRole('button', { name: /Cancel/i })).toBeVisible()
    await expect(dialog.getByRole('button', { name: /Open Session/i })).toBeVisible()
  })

  test('should verify catalog filter controls are present when session is active', async ({ page }) => {
    await loginForApp(page)
    await page.goto('/pos/terminal')
    await page.waitForLoadState('networkidle')

    // Check if there is already an active session (catalog visible) or no session
    const hasOpenSessionBtn = await page.getByRole('button', { name: /Open Session/i }).isVisible({ timeout: 5000 }).catch(() => false)

    if (hasOpenSessionBtn) {
      // No active session — open one to see catalog controls
      await page.getByRole('button', { name: /Open Session/i }).click()

      const dialog = page.locator('.v-dialog')
      await expect(dialog).toBeVisible({ timeout: 5000 })

      // Select first warehouse if available
      const warehouseSelect = dialog.getByRole('combobox', { name: /Warehouse/i })
      await warehouseSelect.click({ force: true })
      const firstOption = page.getByRole('option').first()
      const hasOption = await firstOption.isVisible({ timeout: 3000 }).catch(() => false)

      if (hasOption) {
        await firstOption.click()

        // Click Open Session in dialog
        await dialog.getByRole('button', { name: /Open Session/i }).click()
        await page.waitForLoadState('networkidle')
      } else {
        // No warehouses available, close dialog and skip catalog checks
        // force: the dialog animates, so the stability check never settles on this button.
    await dialog.getByRole('button', { name: /Cancel/i }).click({ force: true })
        return
      }
    }

    // At this point we should have an active session — verify catalog filter controls.
    // By role, not by label: the field opens with the cursor in it (FR-22.54), and a focused
    // clearable field also renders its clear icon, labelled "Clear Search products...".
    await expect(page.getByRole('textbox', { name: /Search Products/i })).toBeVisible({ timeout: 10000 })
    await expect(page.getByRole('combobox', { name: /Category/i })).toBeVisible()
    await expect(page.getByRole('combobox', { name: /Type/i })).toBeVisible()
  })
})
