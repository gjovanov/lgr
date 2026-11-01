import { test, expect } from '@playwright/test'
import { loginForApp } from './helpers/login'
import { createBackOfficeCashSale } from './helpers/cash-register'

/**
 * The form's warehouse selector.
 *
 * ⚠ Not a table column any more. Since 2026-07-26 the `warehouse` line-item column defaults
 * OFF and `DocumentLineTable.vue` renders a DOC-LEVEL autocomplete above the table instead
 * (`v-if="!isColActive('warehouse')"`), with an apply-to-all that seeds new lines. A user can
 * still switch the column back on through the column picker, so both shapes are legitimate —
 * what these tests care about is that the form offers a warehouse at all.
 */
async function expectWarehouseSelector(page: any) {
  const docLevel = page.getByRole('combobox', { name: /warehouse/i })
  const columnHeader = page.locator('.v-table th').filter({ hasText: /warehouse/i })
  await expect(docLevel.or(columnHeader).first()).toBeVisible()
}

test.describe('Invoice Stock Adjustment — Warehouse Selector', () => {
  test('should show warehouse selector on sales invoice form', async ({ page }) => {
    await loginForApp(page)
    await page.goto('/invoicing/invoices/new')
    await expect(page.locator('.v-form')).toBeVisible({ timeout: 10000 })
    await expectWarehouseSelector(page)
  })

  test('should show warehouse selector on purchase invoice form', async ({ page }) => {
    await loginForApp(page)
    await page.goto('/invoicing/bills/new')
    await expect(page.locator('.v-form')).toBeVisible({ timeout: 10000 })
    await expectWarehouseSelector(page)
  })

  // The form opens on a sale that exists: a new one is rung up on the till.
  test('should show warehouse selector on cash register sale form', async ({ page }) => {
    const sale = await createBackOfficeCashSale()
    await loginForApp(page)
    await page.goto(`/invoicing/cash-sales/${sale.id}/edit`)
    await expect(page.locator('.v-form')).toBeVisible({ timeout: 10000 })
    await expectWarehouseSelector(page)
  })

  test('should show warehouse selector on proforma invoice form', async ({ page }) => {
    await loginForApp(page)
    await page.goto('/invoicing/proforma/new')
    await expect(page.locator('.v-form')).toBeVisible({ timeout: 10000 })
    await expectWarehouseSelector(page)
  })

  test('should show warehouse selector on credit note form', async ({ page }) => {
    await loginForApp(page)
    await page.goto('/invoicing/credit-notes/new')
    await expect(page.locator('.v-form')).toBeVisible({ timeout: 10000 })
    await expectWarehouseSelector(page)
  })

  test('should navigate from purchase invoices list to new form', async ({ page }) => {
    await loginForApp(page)
    await page.goto('/invoicing/bills')
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible({ timeout: 10000 })
    // Scoped by destination, not by label: the list header carries more than one .v-btn`r
    // matching /create/i, so the text filter is ambiguous under strict mode.
    const createBtn = page.locator('a.v-btn[href$="/new"]').first()
    await expect(createBtn).toBeVisible()
    await createBtn.click()
    await page.waitForURL('**/bills/new')
    await expect(page.locator('.v-form')).toBeVisible({ timeout: 10000 })
  })

  test('should navigate from cash register sales list to the terminal', async ({ page }) => {
    await loginForApp(page)
    await page.goto('/invoicing/cash-sales')
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible({ timeout: 10000 })
    // Scoped by destination, not by label: the list header carries more than one .v-btn`r
    // matching /create/i, so the text filter is ambiguous under strict mode.
    const createBtn = page.locator('a.v-btn[href$="/new"]').first()
    await expect(createBtn).toBeVisible()
    await createBtn.click()
    await page.waitForURL('**/cash-sales/new')
    await expect(page.getByRole('heading', { name: 'CS Terminal' })).toBeVisible({ timeout: 10000 })
  })

  test('should navigate from proforma invoices list to new form', async ({ page }) => {
    await loginForApp(page)
    await page.goto('/invoicing/proforma')
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible({ timeout: 10000 })
    // Scoped by destination, not by label: the list header carries more than one .v-btn`r
    // matching /create/i, so the text filter is ambiguous under strict mode.
    const createBtn = page.locator('a.v-btn[href$="/new"]').first()
    await expect(createBtn).toBeVisible()
    await createBtn.click()
    await page.waitForURL('**/proforma/new')
    await expect(page.locator('.v-form')).toBeVisible({ timeout: 10000 })
  })

  test('should navigate from credit notes list to new form', async ({ page }) => {
    await loginForApp(page)
    await page.goto('/invoicing/credit-notes')
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible({ timeout: 10000 })
    // FR-22.50: the list's Create says what it creates, and a list filtered to credit notes
    // creates a credit note („New Credit Note"). Until then it opened a plain invoice, which is
    // why this test waited 30s for a `type=credit_note` that never came.
    const createBtn = page.getByTestId('create-button').first()
    await expect(createBtn).toHaveText(/new credit note/i)
    await createBtn.click()
    // `credit-notes/new` is a redirect into the merged sales-document form carrying
    // `?type=credit_note` — the standalone credit-note route is gone, so the old
    // `**/credit-notes/new` pattern could never match and just timed out at 30s.
    await page.waitForURL(/\/invoicing\/invoices\/new\?.*type=credit_note/)
    await expect(page.locator('.v-form')).toBeVisible({ timeout: 10000 })
  })
})
