import { test, expect } from '@playwright/test'
import { loginForApp } from './helpers/login'
import {
  clickCreate,
  waitForDataTable,
  uniqueName,
} from './helpers/crud'

test.describe('ERP CRUD', () => {
  test('should open BOM create form and verify fields', async ({ page }) => {
    await loginForApp(page)
    await page.goto('/erp/bom')

    await waitForDataTable(page)

    const dialog = await clickCreate(page)

    // Fill name field
    const nameField = dialog.getByLabel(/^name$/i)
    await expect(nameField).toBeVisible({ timeout: 3000 })
    await nameField.fill(uniqueName('TestBOM'))

    // Verify Output Product combobox exists
    const productCombobox = dialog.getByRole('combobox', { name: /output\s*product/i })
    expect(await productCombobox.isVisible({ timeout: 2000 }).catch(() => false)).toBeTruthy()

    // Verify Labor Hours spinbutton exists
    const laborHours = dialog.getByRole('spinbutton', { name: /labor\s*hours/i })
    expect(await laborHours.isVisible({ timeout: 2000 }).catch(() => false)).toBeTruthy()

    // Verify Labor Cost/Hour spinbutton exists
    const laborCostPerHour = dialog.getByRole('spinbutton', { name: /labor\s*cost/i })
    expect(await laborCostPerHour.isVisible({ timeout: 2000 }).catch(() => false)).toBeTruthy()

    // Verify Overhead Cost spinbutton exists
    const overheadCost = dialog.getByRole('spinbutton', { name: /overhead\s*cost/i })
    expect(await overheadCost.isVisible({ timeout: 2000 }).catch(() => false)).toBeTruthy()

    // Verify Materials heading
    const materialsHeading = dialog.getByRole('heading', { name: /materials/i })
    expect(await materialsHeading.isVisible({ timeout: 2000 }).catch(() => false)).toBeTruthy()

    // Fill numeric fields
    await laborHours.fill('8')
    await laborCostPerHour.fill('50')
    await overheadCost.fill('100')

    // Cancel
    await page.keyboard.press('Escape')
    await page.waitForTimeout(300)
  })

  test('should open Production Order form and verify fields', async ({ page }) => {
    await loginForApp(page)
    await page.goto('/erp/production-orders')

    await waitForDataTable(page)

    const dialog = await clickCreate(page)

    // Verify key autocomplete fields exist
    const productCombobox = dialog.getByRole('combobox', { name: /^product$/i })
    expect(await productCombobox.isVisible({ timeout: 2000 }).catch(() => false)).toBeTruthy()

    const warehouseCombobox = dialog.getByRole('combobox', { name: /^warehouse$/i })
    expect(await warehouseCombobox.isVisible({ timeout: 2000 }).catch(() => false)).toBeTruthy()

    const outputWarehouseCombobox = dialog.getByRole('combobox', { name: /output\s*warehouse/i })
    expect(await outputWarehouseCombobox.isVisible({ timeout: 2000 }).catch(() => false)).toBeTruthy()

    // Verify date fields
    const plannedStart = dialog.getByLabel(/planned\s*start/i)
    expect(await plannedStart.isVisible({ timeout: 2000 }).catch(() => false)).toBeTruthy()

    const plannedEnd = dialog.getByLabel(/planned\s*end/i)
    expect(await plannedEnd.isVisible({ timeout: 2000 }).catch(() => false)).toBeTruthy()

    // Verify quantity
    const quantity = dialog.getByLabel(/quantity/i)
    expect(await quantity.isVisible({ timeout: 2000 }).catch(() => false)).toBeTruthy()

    // Close dialog
    await page.keyboard.press('Escape')
    await page.waitForTimeout(300)
  })
})
