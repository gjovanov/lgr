import { test, expect } from '@playwright/test'
import { loginForApp } from './helpers/login'

test.describe('Invoice Stock Adjustment — Warehouse Selector', () => {
  test('should show warehouse selector on sales invoice form', async ({ page }) => {
    await loginForApp(page)
    await page.goto('/trade/invoices/new')
    await expect(page.locator('.v-form')).toBeVisible({ timeout: 10000 })
    const warehouseHeader = page.locator('.v-table th', { hasText: /warehouse/i })
    await expect(warehouseHeader).toBeVisible()
  })

  test('should show warehouse selector on purchase invoice form', async ({ page }) => {
    await loginForApp(page)
    await page.goto('/trade/purchase-invoices/new')
    await expect(page.locator('.v-form')).toBeVisible({ timeout: 10000 })
    const warehouseHeader = page.locator('.v-table th', { hasText: /warehouse/i })
    await expect(warehouseHeader).toBeVisible()
  })

  test('should show warehouse selector on cash register sale form', async ({ page }) => {
    await loginForApp(page)
    await page.goto('/trade/cash-sales/new')
    await expect(page.locator('.v-form')).toBeVisible({ timeout: 10000 })
    const warehouseHeader = page.locator('.v-table th', { hasText: /warehouse/i })
    await expect(warehouseHeader).toBeVisible()
  })

  test('should show warehouse selector on proforma invoice form', async ({ page }) => {
    await loginForApp(page)
    await page.goto('/trade/proforma-invoices/new')
    await expect(page.locator('.v-form')).toBeVisible({ timeout: 10000 })
    const warehouseHeader = page.locator('.v-table th', { hasText: /warehouse/i })
    await expect(warehouseHeader).toBeVisible()
  })

  test('should show warehouse selector on credit note form', async ({ page }) => {
    await loginForApp(page)
    await page.goto('/trade/credit-notes/new')
    await expect(page.locator('.v-form')).toBeVisible({ timeout: 10000 })
    const warehouseHeader = page.locator('.v-table th', { hasText: /warehouse/i })
    await expect(warehouseHeader).toBeVisible()
  })

  test('should navigate from purchase invoices list to new form', async ({ page }) => {
    await loginForApp(page)
    await page.goto('/trade/purchase-invoices')
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible({ timeout: 10000 })
    const createBtn = page.locator('a.v-btn', { hasText: /create/i })
    await expect(createBtn).toBeVisible()
    await createBtn.click()
    await page.waitForURL('**/purchase-invoices/new')
    await expect(page.locator('.v-form')).toBeVisible({ timeout: 10000 })
  })

  test('should navigate from cash register sales list to new form', async ({ page }) => {
    await loginForApp(page)
    await page.goto('/trade/cash-sales')
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible({ timeout: 10000 })
    const createBtn = page.locator('a.v-btn', { hasText: /create/i })
    await expect(createBtn).toBeVisible()
    await createBtn.click()
    await page.waitForURL('**/cash-sales/new')
    await expect(page.locator('.v-form')).toBeVisible({ timeout: 10000 })
  })

  test('should navigate from proforma invoices list to new form', async ({ page }) => {
    await loginForApp(page)
    await page.goto('/trade/proforma-invoices')
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible({ timeout: 10000 })
    const createBtn = page.locator('a.v-btn', { hasText: /create/i })
    await expect(createBtn).toBeVisible()
    await createBtn.click()
    await page.waitForURL('**/proforma-invoices/new')
    await expect(page.locator('.v-form')).toBeVisible({ timeout: 10000 })
  })

  test('should navigate from credit notes list to new form', async ({ page }) => {
    await loginForApp(page)
    await page.goto('/trade/credit-notes')
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible({ timeout: 10000 })
    const createBtn = page.locator('a.v-btn', { hasText: /create/i })
    await expect(createBtn).toBeVisible()
    await createBtn.click()
    await page.waitForURL('**/credit-notes/new')
    await expect(page.locator('.v-form')).toBeVisible({ timeout: 10000 })
  })
})
