import { test, expect } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { loginForApp } from './helpers/login'
import { apiLogin, apiPost } from './helpers/api'
import { okJson, receivedBill } from './helpers/bills'

/**
 * A supplier bill that booked goods prints its „Stock receipt" (`?doc=stock_receipt`) from the
 * button beside Print; a bill that booked nothing offers none.
 */

test('a received bill prints its „Stock receipt"; a bill that booked nothing offers none', async ({ page }) => {
  const bill = await receivedBill()
  await loginForApp(page)

  await page.goto(`/invoicing/bills/${bill.id}/edit`)
  const print = page.getByTestId('print-stock-receipt')
  await expect(print).toBeVisible({ timeout: 15000 })
  await expect(print).toContainText('Stock receipt')
  const [download] = await Promise.all([page.waitForEvent('download', { timeout: 30000 }), print.click()])
  expect(download.suggestedFilename()).toBe(`${bill.number}-stock-receipt.pdf`)
  const bytes = readFileSync((await download.path())!)
  expect(bytes.subarray(0, 4).toString()).toBe('%PDF')

  // A draft that booked nothing yet: no stock receipt to print.
  const s = await apiLogin()
  const { supplier, warehouse, product } = bill.refs
  const draft = (await okJson(await apiPost(s, '/invoices', {
    type: 'invoice', direction: 'incoming', contactId: supplier._id, issueDate: new Date().toISOString().slice(0, 10), currency: 'EUR',
    lines: [{ productId: product._id, warehouseId: warehouse._id, description: product.name, quantity: 1, unit: 'pcs', unitPrice: 2.75, taxRate: 20 }],
    subtotal: 2.75, total: 3.3,
  }))).invoice
  await page.goto(`/invoicing/bills/${draft.id || draft._id}/edit`)
  await expect(page.getByTestId('print-now')).toBeVisible({ timeout: 15000 })
  await expect(page.getByTestId('print-stock-receipt')).toHaveCount(0)
})
