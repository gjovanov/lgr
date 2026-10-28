import { test, expect } from '@playwright/test'
import { loginForApp } from './helpers/login'

/**
 * The product search on both order forms — the supplier order's line table and the customer
 * order's — asks the server and keeps the keyboard: ↓ moves through the results without closing
 * them, and Enter takes the highlighted one. Regression for the order form's field reportedly not
 * searching at all. The invoice form has the same check in invoicing-product-autocomplete.spec.ts.
 *
 * ⚠ Taller viewport: the results are `position: fixed` under the input, so on a short page they
 * can land below the fold (see that spec's header).
 */
test.use({ viewport: { width: 1280, height: 1200 } })

for (const target of [
  { name: 'supplier order', path: '/invoicing/orders/new', heading: /new supplier order/i },
  { name: 'customer order', path: '/invoicing/internal-orders/new', heading: /new customer order/i },
]) {
  test(`the ${target.name} form searches products on the server; arrows move, Enter picks`, async ({ page }) => {
    await loginForApp(page)
    await page.goto(target.path)
    await expect(page.getByRole('heading', { name: target.heading }).first()).toBeVisible({ timeout: 15000 })

    // The first line's product field; the seed's articles are PRD-0001…PRD-0050.
    const search = page.getByPlaceholder(/search products/i).first()
    await expect(search).toBeVisible({ timeout: 10000 })
    const asked = page.waitForRequest((r) => r.url().includes('/warehouse/product') && r.url().includes('search='), { timeout: 8000 })
    await search.click()
    await page.keyboard.type('PRD-001', { delay: 60 })
    expect((await asked).url()).toContain('search=')

    const items = page.locator('.pld-overlay .pld-item')
    await expect(items.first()).toBeVisible({ timeout: 8000 })
    for (let n = 0; n < 2; n++) {
      await page.keyboard.press('ArrowDown')
      await page.waitForTimeout(150)
      await expect(items.first(), `the results closed after ArrowDown #${n + 1}`).toBeVisible()
    }
    await expect(page.locator('.pld-overlay .pld-item--active')).toBeVisible()
    await page.keyboard.press('Enter')
    await expect(items.first()).not.toBeVisible({ timeout: 3000 })
    // The pick shows as the line's product chip.
    await expect(page.locator('.v-table tbody tr').first().locator('.v-chip').filter({ hasText: /PRD-001|Product 1/ }).first()).toBeVisible({ timeout: 4000 })
  })
}
