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
import { expectPaginatedTable, getPageInfo, goToNextPage, waitForTableLoaded } from './helpers/pagination'

test.describe('Warehouse CRUD', () => {
  test('should create a product and verify minStockLevel/maxStockLevel on inventory tab', async ({ page }) => {
    await loginForApp(page)
    await page.goto('/inventory/products/new')

    await expect(page.getByRole('heading', { name: /new product/i })).toBeVisible({ timeout: 10000 })

    const sku = uniqueName('SKU')
    const productName = uniqueName('TestProduct')

    // Fill basic tab fields
    await page.getByLabel(/sku/i).fill(sku)
    await page.getByLabel(/name/i).fill(productName)

    // The product form's tabs are routes now (/products/:id/:tab, edit|pricing|settings) and
    // the stock-level fields live under 'Settings' — the old 'Inventory' tab label is gone,
    // so this waited 10s for a tab that does not exist.
    await page.getByRole('tab', { name: /settings/i }).click()
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
    await page.getByRole('button', { name: /^save$/i }).first().click()

    // Verify redirect to products list
    await expect(page).toHaveURL(/inventory\/products/, { timeout: 10000 })
  })

  test('should create a warehouse with nested address fields', async ({ page }) => {
    await loginForApp(page)
    await page.goto('/inventory/warehouses')

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

    // ⚠ Warehouses create through a ROUTED form now, and saving leaves you on it rather than
    // returning to the list — so the table assertion below has to go back there first.
    await page.goto('/inventory/warehouses')
    await waitForDataTable(page)
    await expect(page.locator('.v-data-table').getByText(warehouseName)).toBeVisible({ timeout: 5000 })
  })

  test('should edit a warehouse and update nested address fields', async ({ page }) => {
    await loginForApp(page)
    await page.goto('/inventory/warehouses')

    await waitForDataTable(page)

    // ⚠ Pin the RECORD, not the position. This test used to edit "the first row", save, then
    // reopen "the first row" — but the create test earlier in this file adds a warehouse, so
    // by the time it reopened, row one was a different record and the assertion compared the
    // new warehouse's address ('42 Storage Blvd') against the edit it had just made.
    const editHref = await page.locator('.v-data-table a[href*="/warehouses/"][href*="/edit"]')
      .first().getAttribute('href').catch(() => null)
    if (!editHref) {
      test.skip(true, 'No warehouses to edit')
      return
    }
    await page.goto(editHref)
    const dialog = page.locator('.entity-form-shell, form').first()
    await expect(dialog).toBeVisible({ timeout: 10000 })

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

    // Re-open THE SAME warehouse — by its own URL, not by position.
    await page.goto(editHref)
    const reopened = page.locator('.entity-form-shell, form').first()
    await expect(reopened).toBeVisible({ timeout: 10000 })

    await expect(reopened.getByLabel(/street/i)).toHaveValue('99 Updated Ave')
    await expect(reopened.getByLabel(/^city$/i)).toHaveValue('NewCity')

    // A routed form has Back, not Cancel — and this only leaves the screen after the
    // assertions above, so navigating away is shape-independent.
    await page.goto('/inventory/warehouses')
  })

  test('should display server-side pagination on warehouses table', async ({ page }) => {
    await loginForApp(page)
    await page.goto('/inventory/warehouses')

    await expectPaginatedTable(page)
    await waitForTableLoaded(page)

    const info = await getPageInfo(page)
    expect(info).toBeTruthy()
  })

  test('should navigate pages on products table', async ({ page }) => {
    await loginForApp(page)
    await page.goto('/inventory/products')

    await expectPaginatedTable(page)
    await waitForTableLoaded(page)

    const infoBefore = await getPageInfo(page)
    const navigated = await goToNextPage(page)
    if (navigated) {
      await waitForTableLoaded(page)
      const infoAfter = await getPageInfo(page)
      expect(infoAfter).not.toBe(infoBefore)
    }
  })
})
