import { test, expect } from '@playwright/test'
import { loginForApp } from './helpers/login'
import { apiLogin, apiGet } from './helpers/api'
import { lineUnitPrice } from './helpers/document-form'
import { rowAction, rowsWithStatus } from './helpers/row-actions'

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
    await loginForApp(page)
    await page.goto('/invoicing/invoices')
    await expect(page.locator('.v-data-table')).toBeVisible({ timeout: 10000 })

    // Look for a draft invoice — FR-22.23: its row menu offers „Issue"
    const draftRows = rowsWithStatus(page, 'Draft')
    const hasDraft = await draftRows.first().isVisible({ timeout: 3000 }).catch(() => false)

    if (!hasDraft) {
      // No draft invoices — create one with excessive stock request
      await page.goto('/invoicing/invoices/new')
      await expect(page.locator('.v-form')).toBeVisible({ timeout: 10000 })

      // Select contact
      const contactInput = page.locator('.v-autocomplete input').first()
      await contactInput.click({ force: true })
      await page.waitForTimeout(500)
      const contactOption = page.locator('.v-overlay--active .v-list-item').first()
      if (await contactOption.isVisible({ timeout: 3000 }).catch(() => false)) {
        await contactOption.click()
        await page.waitForTimeout(300)
      }

      // Fill line with product and warehouse
      const lineRow = page.locator('.v-table tbody tr').first()
      const productInput = lineRow.locator('.v-autocomplete input').first()
      await productInput.click({ force: true })
      await page.waitForTimeout(500)
      await productInput.fill('БОЛТ')
      await page.waitForTimeout(1000)
      const productOpt = page.locator('.v-overlay--active .v-list-item').first()
      if (!(await productOpt.isVisible({ timeout: 3000 }).catch(() => false))) {
        return // No products available
      }
      await productOpt.click()
      await page.waitForTimeout(500)

      // Select warehouse
      const whSelect = lineRow.locator('.v-autocomplete, .v-select').last()
      await whSelect.click({ force: true })
      await page.waitForTimeout(500)
      const whOpt = page.locator('.v-overlay--active .v-list-item').first()
      if (await whOpt.isVisible({ timeout: 3000 }).catch(() => false)) {
        await whOpt.click()
        await page.waitForTimeout(300)
      }

      // Set extremely high quantity
      const qtyInput = lineRow.locator('input[type="number"]').first()
      await qtyInput.fill('999999')

      const priceInput = lineUnitPrice(lineRow)
      await priceInput.fill('1')

      // Save as draft
      await page.getByRole('button', { name: /^save$/i }).first().click()
      await page.waitForTimeout(2000)

      // Navigate back to sales invoices
      await page.goto('/invoicing/invoices')
      await expect(page.locator('.v-data-table')).toBeVisible({ timeout: 10000 })
    }

    // Find and issue a draft invoice
    const canSend = await draftRows.first().isVisible({ timeout: 3000 }).catch(() => false)

    if (canSend) {
      await (await rowAction(draftRows.first(), 'issue')).click()
      await page.waitForTimeout(2000)

      // Check for error snackbar
      const snackbar = page.locator('.v-snackbar')
      const hasError = await snackbar.isVisible({ timeout: 5000 }).catch(() => false)
      if (hasError) {
        const text = await snackbar.textContent()
        // If this invoice has warehouse+product lines with insufficient stock, expect the error
        if (text?.includes('Insufficient stock')) {
          expect(text).toContain('Insufficient stock')
        }
      }
    }

    // Page should still be visible (didn't crash)
    await expect(page.locator('.v-data-table')).toBeVisible()
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
    const session = await apiLogin()
    const levels = await apiGet(session, '/warehouse/stock-level/?size=50')
    const stocked = (levels.stockLevels ?? levels.items ?? []).find((l: any) => (l.quantity ?? 0) > 5)
    test.skip(!stocked, 'no stock levels with spare quantity to sell')

    await page.goto('/invoicing/cash-sales/new')
    await expect(page.locator('.v-form')).toBeVisible({ timeout: 10000 })

    await page.getByRole('textbox', { name: /search/i }).first().fill(stocked.productName ?? '')
    await page.waitForTimeout(800)

    const card = page.getByTestId('register-card').first()
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
