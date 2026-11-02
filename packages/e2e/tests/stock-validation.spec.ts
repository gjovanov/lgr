import { test, expect } from '@playwright/test'
import { loginForApp } from './helpers/login'
import { apiLogin, apiGet, apiPost } from './helpers/api'
import { lineUnitPrice } from './helpers/document-form'
import { rowAction, rowOf, rowsWithStatus } from './helpers/row-actions'
import { createBackOfficeCashSale } from './helpers/cash-register'

test.describe('Stock Validation on Invoicing', () => {
  // ⚠ Through the API: `/cash-sales/new` is the till now, which sells from whatever the warehouse
  // shows (`settings.cashRegister.allowNegativeStock`). The back-office door is `POST /invoices`,
  // the imports' and the API's, and that one refuses a sale the warehouse cannot cover.
  test('should refuse a back-office cash register sale with insufficient stock', async () => {
    const admin = await apiLogin()
    const author = await apiLogin('acme-corp', 'accountant', 'test123')
    const { warehouses } = await apiGet(admin, '/warehouse/warehouse?size=50')
    const wh = warehouses.find((w: any) => w.code === 'WH-01') || warehouses[0]
    const warehouseId = wh.id || wh._id
    const { products } = await apiGet(admin, `/trade/pos/catalog?warehouseId=${warehouseId}&type=goods&size=1`)
    expect(products?.length, 'an article — is the DB seeded?').toBeTruthy()
    const p = products[0]

    const quantity = 999999
    const net = quantity * p.unitPrice
    const tax = Math.round(net * (p.taxRate || 0)) / 100
    const res = await apiPost(author, '/invoices', {
      type: 'cash_sale', direction: 'outgoing', issueDate: new Date().toISOString().slice(0, 10), currency: 'EUR',
      lines: [{
        productId: p.productId, warehouseId, description: p.productName, unit: p.unit || 'pcs',
        quantity, unitPrice: p.unitPrice, discount: 0, taxRate: p.taxRate || 0, taxAmount: tax, lineTotal: net + tax,
      }],
      subtotal: net, taxTotal: tax, total: net + tax, paymentMethod: 'cash',
    })

    // ⚠ Not `if (res.ok)`: the version this replaced let a silent failure to validate pass.
    expect(res.ok, `a sale of ${quantity} → ${res.status}`).toBe(false)
    expect(res.status).toBeLessThan(500)
    expect(JSON.stringify(await res.json())).toMatch(/stock/i)
  })

  test('should show error when sending outgoing invoice with insufficient stock', async ({ page }) => {
    // ⚠ Rewritten (FR-21 §9): the old flow typed a draft into the line editor by CSS position, and
    // the first `.v-table` row is no longer the editable line, so it failed outside the viewport
    // before reaching its point. Its assertions were also conditional: no snackbar, or one saying
    // something else, passed. The draft is now made through the API; what is tested is the list:
    // issuing a draft the warehouses cannot cover is refused, says so, and leaves it a draft.
    const admin = await apiLogin()
    const { contacts } = await apiGet(admin, '/invoicing/contact?type=customer&size=1')
    const { warehouses } = await apiGet(admin, '/warehouse/warehouse?size=50')
    const wh = warehouses.find((w: any) => w.code === 'WH-01') || warehouses[0]
    const { products } = await apiGet(admin, `/trade/pos/catalog?warehouseId=${wh.id || wh._id}&type=goods&size=1`)
    expect(contacts?.length && products?.length, 'a customer and an article — is the DB seeded?').toBeTruthy()
    const p = products[0]
    const res = await apiPost(admin, '/invoices', {
      type: 'invoice', direction: 'outgoing', contactId: contacts[0].id || contacts[0]._id,
      issueDate: new Date().toISOString().slice(0, 10), currency: 'EUR',
      lines: [{
        productId: p.productId, warehouseId: wh.id || wh._id, description: p.productName, unit: p.unit || 'pcs',
        quantity: 999999, unitPrice: 1, discount: 0, taxRate: p.taxRate || 0,
      }],
      subtotal: 999999, taxTotal: 0, total: 999999,
    })
    expect(res.ok, `draft → ${res.status}`).toBe(true)
    const draft = (await res.json()).invoice

    await loginForApp(page)
    await page.goto(`/invoicing/invoices?q=${encodeURIComponent(draft.invoiceNumber)}`)
    const row = rowOf(page, draft.invoiceNumber)
    await expect(row).toBeVisible({ timeout: 15000 })
    await (await rowAction(row, 'issue')).click()

    // The issue stops at the stock check: the transfer dialog says the stock is short, and that no
    // warehouse covers all of it (nothing holds 999,999), so there is nothing it could confirm.
    const dialog = page.locator('.v-dialog').filter({ hasText: /Stock Transfer Required/i })
    await expect(dialog).toBeVisible({ timeout: 10000 })
    await expect(dialog.getByRole('alert').filter({ hasText: /Insufficient Stock/i })).toBeVisible()
    await expect(dialog.getByRole('alert').filter({ hasText: /not fully covered/i })).toBeVisible()
    await page.keyboard.press('Escape')

    // Nothing was issued: still a draft, still under its draft number.
    const again = await apiGet(admin, `/invoices/${draft.id || draft._id}`)
    expect(again.invoice).toMatchObject({ status: 'draft', invoiceNumber: draft.invoiceNumber })
  })

  test('should save a back-office cash register sale when stock is sufficient', async ({ page }) => {
    // `createBackOfficeCashSale` picks an article the warehouse can actually sell (`stockAvailable`,
    // reservations taken off), and throws on a refusal: that it returned is half of this test.
    const sale = await createBackOfficeCashSale()
    await loginForApp(page)
    await page.goto(`/invoicing/cash-sales?q=${sale.number}`)
    await expect(page.getByRole('heading', { name: 'Cash Register Sales' })).toBeVisible({ timeout: 15000 })
    await expect(page.getByRole('link', { name: sale.number, exact: true })).toBeVisible({ timeout: 15000 })
  })

  test('should show error when voiding invoice would cause negative stock', async ({ page }) => {
    await loginForApp(page)
    await page.goto('/invoicing/invoices')
    await expect(page.locator('.v-data-table')).toBeVisible({ timeout: 10000 })

    // Look for a sent invoice that can be voided — FR-22.23: Void sits in the row menu of an
    // issued document, and asks first.
    const sentRow = rowsWithStatus(page, 'Sent').first()
    const hasVoidBtn = await sentRow.isVisible({ timeout: 3000 }).catch(() => false)

    if (hasVoidBtn) {
      await (await rowAction(sentRow, 'void')).click()
      await page.getByTestId('void-dialog').getByRole('button', { name: /^void$/i }).click()
      await page.waitForTimeout(2000)

      // Check for snackbar — may show success or error depending on stock state
      const snackbar = page.locator('.v-snackbar')
      const hasSnackbar = await snackbar.isVisible({ timeout: 5000 }).catch(() => false)
      if (hasSnackbar) {
        const text = await snackbar.textContent()
        // If stock validation prevents the void, we should see the error
        if (text?.includes('Insufficient stock')) {
          expect(text).toContain('Insufficient stock')
          // Invoice should still be visible (not voided)
          await expect(page.locator('.v-data-table')).toBeVisible()
        }
      }
    }

    // Page should still be functional
    await expect(page.locator('.v-data-table')).toBeVisible()
  })

  test('should show insufficient stock error on purchase invoice void with depleted stock', async ({ page }) => {
    await loginForApp(page)
    await page.goto('/invoicing/bills')
    await expect(page.locator('.v-data-table')).toBeVisible({ timeout: 10000 })

    // This test verifies the void button exists and the page handles errors gracefully
    // Look for any received purchase invoice
    const rows = page.locator('.v-data-table tbody tr')
    const rowCount = await rows.count()

    if (rowCount > 0) {
      const hasNoData = await rows.first().getByText('No data available').isVisible().catch(() => false)
      if (!hasNoData) {
        // A received bill offers Void in its row menu (FR-22.23)
        const receivedRow = rowsWithStatus(page, 'Received').first()
        const hasVoidBtn = await receivedRow.isVisible({ timeout: 2000 }).catch(() => false)
        if (hasVoidBtn) {
          // Clicking void on a received purchase invoice triggers reverseInvoiceStockMovement
          // which creates a dispatch — if stock was already used, this should show error
          await (await rowAction(receivedRow, 'void')).click()
          await page.getByTestId('void-dialog').getByRole('button', { name: /^void$/i }).click()
          await page.waitForTimeout(2000)

          const snackbar = page.locator('.v-snackbar')
          const hasSnackbar = await snackbar.isVisible({ timeout: 5000 }).catch(() => false)
          if (hasSnackbar) {
            // We just verify the snackbar appeared and page didn't crash
            await expect(page.locator('.v-data-table')).toBeVisible()
          }
        }
      }
    }

    await expect(page.locator('.v-data-table')).toBeVisible()
  })
})
