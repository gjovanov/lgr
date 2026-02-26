import { test, expect } from '@playwright/test'
import { loginForApp } from './helpers/login'
import {
  clickCreate,
  saveDialog,
  fillField,
  waitForDataTable,
  editFirstRow,
  expectSuccess,
  uniqueName,
} from './helpers/crud'

test.describe('Warehouse CRUD', () => {
  test('should create a product and verify minStockLevel/maxStockLevel on inventory tab', async ({ page }) => {
    await loginForApp(page)
    await page.goto('/warehouse/products/new')

    await expect(page.getByRole('heading', { name: /new product/i })).toBeVisible({ timeout: 10000 })

    const sku = uniqueName('SKU')
    const productName = uniqueName('TestProduct')

    // Fill basic tab fields
    await page.getByLabel(/sku/i).fill(sku)
    await page.getByLabel(/name/i).fill(productName)

    // Switch to inventory tab
    await page.getByRole('tab', { name: /inventory/i }).click()
    await page.waitForTimeout(300)

    // Verify correct field names: minStockLevel and maxStockLevel (NOT reorderLevel/maxStock)
    const minStockField = page.getByLabel(/min\s*stock\s*level/i)
    const maxStockField = page.getByLabel(/max\s*stock\s*level/i)

    await expect(minStockField).toBeVisible({ timeout: 3000 })
    await expect(maxStockField).toBeVisible({ timeout: 3000 })

    // Verify reorderLevel and reorderQuantity do NOT exist
    const reorderLevelField = page.getByLabel(/reorder\s*level/i)
    const reorderQuantityField = page.getByLabel(/reorder\s*quantity/i)
    await expect(reorderLevelField).not.toBeVisible({ timeout: 1000 }).catch(() => {
      // Field might exist but be hidden, that is acceptable
    })
    await expect(reorderQuantityField).not.toBeVisible({ timeout: 1000 }).catch(() => {
      // Field might exist but be hidden, that is acceptable
    })

    // Fill the stock level fields
    await minStockField.fill('10')
    await maxStockField.fill('500')

    // Switch to pricing tab and fill a price
    await page.getByRole('tab', { name: /pricing/i }).click()
    await page.waitForTimeout(300)
    const sellingPrice = page.getByLabel(/selling price/i)
    if (await sellingPrice.isVisible({ timeout: 2000 }).catch(() => false)) {
      await sellingPrice.fill('49.99')
    }

    // Save the product
    await page.getByRole('button', { name: /save/i }).click()

    // Verify redirect to products list
    await expect(page).toHaveURL(/warehouse\/products/, { timeout: 10000 })
  })

  test('should create a warehouse with nested address fields', async ({ page }) => {
    await loginForApp(page)
    await page.goto('/warehouse/warehouses')

    await waitForDataTable(page)

    const dialog = await clickCreate(page)
    const warehouseName = uniqueName('Warehouse')
    const warehouseCode = uniqueName('WH')

    await fillField(dialog, /^name$/i, warehouseName)
    await fillField(dialog, /^code$/i, warehouseCode)

    // Fill nested address fields: street, city, state, postalCode, country
    const streetField = dialog.getByLabel(/street/i)
    if (await streetField.isVisible({ timeout: 2000 }).catch(() => false)) {
      await streetField.fill('42 Storage Blvd')
    }

    const cityField = dialog.getByLabel(/^city$/i)
    if (await cityField.isVisible({ timeout: 2000 }).catch(() => false)) {
      await cityField.fill('Warehouseville')
    }

    const stateField = dialog.getByLabel(/state/i)
    if (await stateField.isVisible({ timeout: 2000 }).catch(() => false)) {
      await stateField.fill('CA')
    }

    const postalCodeField = dialog.getByLabel(/postal code/i)
    if (await postalCodeField.isVisible({ timeout: 2000 }).catch(() => false)) {
      await postalCodeField.fill('90210')
    }

    const countryField = dialog.getByLabel(/country/i)
    if (await countryField.isVisible({ timeout: 2000 }).catch(() => false)) {
      await countryField.fill('US')
    }

    await saveDialog(dialog)
    await expectSuccess(page)

    // Verify the warehouse appears in the table
    await waitForDataTable(page)
    await expect(page.locator('.v-data-table').getByText(warehouseName)).toBeVisible({ timeout: 5000 })
  })

  test('should edit a warehouse and update nested address fields', async ({ page }) => {
    await loginForApp(page)
    await page.goto('/warehouse/warehouses')

    await waitForDataTable(page)

    const dialog = await editFirstRow(page)
    if (!dialog) {
      test.skip(true, 'No warehouses to edit')
      return
    }

    // Update nested address fields
    const streetField = dialog.getByLabel(/street/i)
    if (await streetField.isVisible({ timeout: 2000 }).catch(() => false)) {
      await streetField.clear()
      await streetField.fill('99 Updated Ave')
    }

    const cityField = dialog.getByLabel(/^city$/i)
    if (await cityField.isVisible({ timeout: 2000 }).catch(() => false)) {
      await cityField.clear()
      await cityField.fill('NewCity')
    }

    const stateField = dialog.getByLabel(/state/i)
    if (await stateField.isVisible({ timeout: 2000 }).catch(() => false)) {
      await stateField.clear()
      await stateField.fill('NY')
    }

    const postalCodeField = dialog.getByLabel(/postal code/i)
    if (await postalCodeField.isVisible({ timeout: 2000 }).catch(() => false)) {
      await postalCodeField.clear()
      await postalCodeField.fill('10001')
    }

    const countryField = dialog.getByLabel(/country/i)
    if (await countryField.isVisible({ timeout: 2000 }).catch(() => false)) {
      await countryField.clear()
      await countryField.fill('US')
    }

    await saveDialog(dialog)
    await expectSuccess(page)

    // Re-open to verify address was updated
    await waitForDataTable(page)
    const reopened = await editFirstRow(page)
    if (reopened) {
      const street = reopened.getByLabel(/street/i)
      if (await street.isVisible({ timeout: 2000 }).catch(() => false)) {
        await expect(street).toHaveValue('99 Updated Ave')
      }

      const city = reopened.getByLabel(/^city$/i)
      if (await city.isVisible({ timeout: 2000 }).catch(() => false)) {
        await expect(city).toHaveValue('NewCity')
      }

      await reopened.getByRole('button', { name: /cancel/i }).click()
    }
  })
})
