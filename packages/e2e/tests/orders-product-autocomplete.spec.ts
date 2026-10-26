import { test, expect } from '@playwright/test'
import { loginForApp } from './helpers/login'

/**
 * The product combobox must fire a server search and support native keyboard
 * navigation (↓/Enter) on BOTH the invoice line table (grid-nav wrapped) and the
 * order form (plain table). Regression for: grid-nav stealing arrow keys, and the
 * order form's field reportedly not firing any search request.
 */
for (const target of [
  { name: 'invoice form', path: '/invoicing/invoices/new', heading: /new invoice/i },
  { name: 'order form', path: '/invoicing/orders/new', heading: /new supplier order/i },
]) {
  test(`product search fires ajax + arrows/Enter select on the ${target.name}`, async ({ page }) => {
    await loginForApp(page)
    await page.goto(target.path)
    await expect(page.getByRole('heading', { name: target.heading }).first()).toBeVisible({ timeout: 15000 })

    const lineRow = page.locator('.v-table tbody tr').first()
    await expect(lineRow).toBeVisible({ timeout: 10000 })
    // By what it asks for: the invoice line opens with its number (td.line-no), the order line
    // does not, and both hold the same ProductLineDescription.
    const descInput = lineRow.getByPlaceholder(/search products/i)

    const reqPromise = page.waitForRequest(
      (r) => r.url().includes('/warehouse/product') && r.url().includes('search='),
      { timeout: 6000 },
    )
    await descInput.click()
    await descInput.pressSequentially('Te', { delay: 100 })
    const req = await reqPromise
    expect(req.url()).toContain('search=')

    // Results open — in ProductLineDescription's own overlay, teleported to <body> (not a v-menu)…
    const menuItem = page.locator('.pld-overlay .pld-item').first()
    await expect(menuItem).toBeVisible({ timeout: 5000 })

    // …and ↓ + Enter selects (menu must NOT close on arrows).
    await page.keyboard.press('ArrowDown')
    await page.waitForTimeout(150)
    await expect(menuItem).toBeVisible()
    await page.keyboard.press('Enter')
    await expect(lineRow.locator('.v-chip').first()).toBeVisible({ timeout: 4000 })
  })
}
