import { test, expect } from '@playwright/test'
import { loginForApp } from './helpers/login'
import { activeContact, apiGet, apiLogin, apiPost } from './helpers/api'

/**
 * FR-31.12 (#796): lines keep their identity when a row is removed.
 *
 * The line grids keyed their rows by position: removing the second of three lines reused the second row for the third
 * line. What that row held by itself (an open menu, typed text, its loaded options, the focus) was the old second
 * line's, and it loaded the third line's article and prices again. Now the third line's row is the same row after.
 */
test('removing the second of three lines leaves the third line’s row as it was, and loads nothing again', async ({ page }) => {
  const api = await apiLogin()
  const customer = await activeContact(api, 'customer')
  const { warehouses } = await apiGet(api, '/warehouse/warehouse?size=50')
  const wh = warehouses.find((w: any) => w.code === 'WH-01') || warehouses[0]
  const warehouseId = String(wh.id || wh._id)
  const { products } = await apiGet(api, `/trade/pos/catalog?warehouseId=${warehouseId}&type=goods&size=3`)
  expect(customer && products?.length === 3, 'a customer and three articles — is the DB seeded?').toBeTruthy()
  const lines = products.map((p: any) => ({
    productId: p.productId, warehouseId, description: p.productName, unit: p.unit || 'pcs', quantity: 1, unitPrice: 1, discount: 0, taxRate: p.taxRate || 0,
  }))
  const res = await apiPost(api, '/invoices', {
    type: 'invoice', direction: 'outgoing', contactId: customer.id || customer._id,
    issueDate: new Date().toISOString().slice(0, 10), currency: 'EUR', lines, subtotal: 3, taxTotal: 0, total: 3,
  })
  expect(res.ok, `draft → ${res.status}`).toBe(true)
  const draft = (await res.json()).invoice

  await loginForApp(page)
  await page.goto(`/invoicing/invoices/${draft.id || draft._id}/edit`)
  const rows = page.locator('.line-table tbody tr')
  await expect(rows).toHaveCount(3, { timeout: 15000 })
  await expect(rows.nth(2).locator('input').first()).toHaveValue(products[2].productName)
  // Let every row finish its own loads before counting.
  await page.waitForLoadState('networkidle')

  // The third line's row, marked as an element; and a quantity typed into it that is not stored yet.
  await rows.nth(2).evaluate((el) => { (el as HTMLElement).dataset.e2eMark = 'third' })
  const qty = rows.nth(2).locator('td').nth(2).locator('input')
  // The price follows the quantity once the typing stops (FR-31.5): that lookup is the typing's, and is let finish.
  const looked = page.waitForResponse(r => /\/pricing\/options\?.*quantity=7/.test(r.url()))
  await qty.fill('7')
  await looked
  await page.waitForLoadState('networkidle')

  const loads: string[] = []
  page.on('request', (r) => {
    if (/\/(pricing|warehouse\/product|price-options|stock)/.test(r.url())) loads.push(r.url())
  })
  await rows.nth(1).getByRole('button', { name: /remove/i }).click()

  await expect(rows).toHaveCount(2)
  // The row that showed the third line is the same element, now second, with what was typed in it.
  await expect(rows.nth(1)).toHaveAttribute('data-e2e-mark', 'third')
  await expect(rows.nth(1).locator('input').first()).toHaveValue(products[2].productName)
  await expect(rows.nth(1).locator('td').nth(2).locator('input')).toHaveValue('7')
  await expect(rows.nth(0).locator('input').first()).toHaveValue(products[0].productName)
  await page.waitForTimeout(1000)
  expect(loads, 'no row loaded its article or prices again').toEqual([])
})
