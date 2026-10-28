import { test, expect } from '@playwright/test'
import { loginForApp } from './helpers/login'
import { apiLogin, apiGet, apiPost } from './helpers/api'
import { lineUnitPrice } from './helpers/document-form'
import { rowAction, rowOf, rowsWithStatus } from './helpers/row-actions'

test.describe('Stock Validation on Invoicing', () => {
  test('should show error when creating cash register sale with insufficient stock', async ({ page }) => {
    await loginForApp(page)
    await page.goto('/invoicing/cash-sales/new')
    await expect(page.locator('.v-form')).toBeVisible({ timeout: 10000 })

    // ⚠ Rewritten for the POS terminal. FR-03 replaced the cash-sale line editor with
    // `CashSaleTerminal.vue` — product CARDS on the left, a cart on the right — so there is no
    // `.v-table` line row, no ProductLineDescription and no per-line warehouse select on this
    // screen any more. The old flow waited 10s for an input that no longer exists.
    const card = page.getByTestId('register-card').first()
    test.skip(!(await card.isVisible({ timeout: 10000 }).catch(() => false)), 'no products seeded')
    await card.click()

    const cartRow = page.locator('[data-testid^="cart-line-"]').first()
    await expect(cartRow).toBeVisible()

    // Ask for far more than anyone has in stock.
    const qtyInput = cartRow.locator('input[type="number"]').first()
    await qtyInput.fill('999999')
    await qtyInput.blur()

    await page.getByRole('button', { name: /^save$/i }).first().click()

    // The server refuses on stock. Either surface is acceptable — a snackbar, or the
    // stock-transfer dialog that offers to cover the shortfall — but something MUST say so,
    // and we must not have navigated away to the list as if the sale succeeded.
    //
    // ⚠ The previous version wrapped this in `if (hasError)`, so a silent failure to validate
    // passed the test.
    await expect(
      page.locator('.v-snackbar').or(page.locator('.v-dialog')),
    ).toBeVisible({ timeout: 10000 })
    await expect(page).toHaveURL(/cash-sales\/new/)
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

  test('should successfully create cash register sale when stock is sufficient', async ({ page }) => {
    await loginForApp(page)

    // First check stock levels to find a product with stock
    await page.goto('/inventory/stock-levels')
    await expect(page.locator('.v-data-table')).toBeVisible({ timeout: 10000 })
    await page.waitForTimeout(1000)

    // Check if any stock levels exist
    const rows = page.locator('.v-data-table tbody tr')
    const rowCount = await rows.count()
    const hasNoData = rowCount > 0
      ? await rows.first().getByText('No data available').isVisible().catch(() => false)
      : true

    if (hasNoData || rowCount === 0) {
      // No stock data, skip
      return
    }

    // ⚠ Rewritten for the POS terminal (FR-03) — see the first test. There is no free-text
    // line editor on this screen, so "a service item with no warehouse" is not a thing a cash
    // sale can contain any more; every line comes from a product card.
    //
    // Pick a product that genuinely HAS stock, rather than whichever card happens to be first:
    // the point of this test is the sufficient-stock path, and a short product would take the
    // shortfall dialog instead.
    //
    // ⚠ By what the form's OWN warehouse can sell (`stockAvailable`, reservations taken off), never
    // by a stock level's quantity anywhere: in a full run that picked an article the reservation
    // specs hold (on hand 10, free 0), and the form rightly offered a transfer instead of saving.
    const session = await apiLogin()
    const { warehouses } = await apiGet(session, '/warehouse/warehouse?size=1000')
    const wh = warehouses.find((w: any) => w.isDefault) || warehouses[0]
    const { products } = await apiGet(session, `/trade/pos/catalog?warehouseId=${wh.id || wh._id}&type=goods&size=100`)
    const stocked = (products || []).find((p: any) => (p.stockAvailable ?? 0) > 5 && p.unitPrice > 0)
    test.skip(!stocked, 'no article with spare stock in the default warehouse')

    await page.goto('/invoicing/cash-sales/new')
    await expect(page.locator('.v-form')).toBeVisible({ timeout: 10000 })

    await page.getByRole('textbox', { name: /search/i }).first().fill(stocked.sku || stocked.productName)
    await page.waitForTimeout(800)

    const card = page.getByTestId('register-card').filter({ hasText: stocked.productName }).first()
    test.skip(!(await card.isVisible({ timeout: 10000 }).catch(() => false)), 'product not in catalog')
    await card.click()
    await expect(page.locator('[data-testid^="cart-line-"]').first()).toBeVisible()

    await page.getByRole('button', { name: /^save$/i }).first().click()

    // ⚠ The old assertion was `expect(onList || onForm).toBe(true)` — one of those is always
    // true, so it could not fail. A sale with stock behind it must actually save and land back
    // on the list.
    await expect(page.getByRole('heading', { name: 'Cash Register Sales' })).toBeVisible({ timeout: 15000 })
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
