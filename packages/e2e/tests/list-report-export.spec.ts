import { test, expect } from '@playwright/test'
import { loginForApp } from './helpers/login'
import { apiGet, apiLogin, apiPost } from './helpers/api'
import { openSelect } from './helpers/vuetify'

/**
 * FR-31.11 (#796): an Export that is offered exports.
 *
 * Eight inventory lists offered an Export whose handler only wrote a line to the browser's console. Now Stock levels,
 * Movements and Valuation open their report in Reports on the list's filters, and the report's own Excel works; the
 * other five offer no Export.
 */

const exportLink = (page: any) => page.getByTestId('report-export')

async function mainWarehouse(): Promise<{ id: string; name: string }> {
  const api = await apiLogin()
  const { warehouses } = await apiGet(api, '/warehouse/warehouse?size=50')
  const wh = warehouses.find((w: any) => w.code === 'WH-01') || warehouses[0]
  return { id: String(wh.id || wh._id), name: wh.name }
}

test.describe('a list’s Export opens its report (FR-31.11)', () => {
  test('Movements: the report arrives with the period, the type and the warehouse, and exports to Excel', async ({ page }) => {
    // A receipt of its own, confirmed, so the report has a row and its Export is enabled.
    const api = await apiLogin()
    const wh = await mainWarehouse()
    const ts = Date.now().toString(36)
    const made = await apiPost(api, '/warehouse/product', {
      sku: `E2E-RX-${ts}`, name: `E2E report export ${ts}`, category: 'Test', type: 'goods', unit: 'pcs', sellingPrice: 2, purchasePrice: 1, taxRate: 20,
    })
    expect(made.ok, `product → ${made.status}`).toBe(true)
    const { product } = await made.json()
    const res = await apiPost(api, '/warehouse/movement', {
      type: 'receipt', date: new Date().toISOString(), toWarehouseId: wh.id,
      lines: [{ productId: product._id || product.id, quantity: 3, unitCost: 1, totalCost: 3 }], totalAmount: 3,
    })
    expect(res.ok, `receipt → ${res.status}`).toBe(true)
    const { stockMovement } = await res.json()
    const confirmed = await apiPost(api, `/warehouse/movement/${stockMovement._id || stockMovement.id}/confirm`, {})
    expect(confirmed.ok, `confirm → ${confirmed.status}`).toBe(true)
    const type = 'receipt'
    await loginForApp(page)
    await page.goto(`/inventory/movements?type=${type}&from=2000-01-01&to=2099-12-31&warehouse=${wh.id}`)
    await expect(exportLink(page)).toBeVisible({ timeout: 15000 })
    await exportLink(page).click()

    await page.waitForURL(/\/reports\/stock-movements\?/, { timeout: 15000 })
    const url = new URL(page.url())
    expect(url.searchParams.get('periodPreset')).toBe('custom')
    expect(url.searchParams.get('periodFrom')).toBe('2000-01-01')
    expect(url.searchParams.get('periodTo')).toBe('2099-12-31')
    expect(url.searchParams.get('types')).toBe(type)
    expect(url.searchParams.get('warehouseId')).toBe(wh.id)

    await expect(page.locator('.v-data-table').first()).toBeVisible({ timeout: 20000 })
    await page.getByRole('button', { name: /^export$/i }).click()
    await expect(page.locator('.v-overlay--active .v-card').first()).toBeVisible({ timeout: 5000 })
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 30000 }),
      page.locator('.v-overlay--active').getByRole('button', { name: /^export$/i }).click(),
    ])
    expect(download.suggestedFilename()).toMatch(/stock-movements-\d{4}-\d{2}-\d{2}\.xlsx$/i)
  })

  test('Stock levels and Valuation: the report arrives with the warehouse', async ({ page }) => {
    const wh = await mainWarehouse()
    await loginForApp(page)
    for (const [list, report] of [['stock-levels', 'stock-levels'], ['inventory-valuation', 'inventory-valuation']] as const) {
      await page.goto(`/inventory/${list}`)
      await expect(exportLink(page)).toBeVisible({ timeout: 15000 })
      await openSelect(page, /^warehouse$/i)
      await page.getByRole('option').filter({ hasText: wh.name }).first().click()
      // The menu is gone before the link is clicked: a click on its closing overlay goes nowhere.
      await expect(page.getByRole('option')).toHaveCount(0)
      await expect(exportLink(page)).toHaveAttribute('href', new RegExp(`warehouseId=${wh.id}`))
      await exportLink(page).click()
      await page.waitForURL(new RegExp(`/reports/${report}\\?`), { timeout: 15000 })
      expect(new URL(page.url()).searchParams.get('warehouseId')).toBe(wh.id)
      await expect(page.locator('.v-data-table').first()).toBeVisible({ timeout: 20000 })
    }
  })

  test('the five lists without an export of their own offer none', async ({ page }) => {
    await loginForApp(page)
    for (const list of ['categories', 'warehouses', 'price-lists', 'inventory-counts', 'products']) {
      await page.goto(`/inventory/${list}`)
      await expect(page.locator('.v-data-table, .v-table').first()).toBeVisible({ timeout: 15000 })
      await expect(page.getByRole('button', { name: /^export$/i })).toHaveCount(0)
      await expect(exportLink(page)).toHaveCount(0)
    }
  })
})
