import { test, expect } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { loginForApp } from './helpers/login'
import { apiLogin, apiPost } from './helpers/api'
import { okJson, receivedBill } from './helpers/bills'
import { openSelect } from './helpers/vuetify'

/**
 * A supplier bill that booked goods prints its „Stock receipt" (`?doc=stock_receipt`) from the
 * button beside Print; a bill that booked nothing offers none.
 *
 * The sheet is what the warehouse prices the goods from, so the button asks which price to print
 * before it prints anything: „Цена на едро" until the person chooses another, and their last choice
 * after that, on any bill (`&priceLevel=`).
 */

test('a received bill asks which price its „Stock receipt" prints, and remembers the answer', async ({ page }) => {
  const bill = await receivedBill()
  const another = await receivedBill()
  await loginForApp(page)

  // Every print the page asks the server for, by the level it names.
  const asked: Array<string | null> = []
  page.on('request', (r) => {
    const url = new URL(r.url())
    if (url.searchParams.get('doc') === 'stock_receipt') asked.push(url.searchParams.get('priceLevel'))
  })

  await page.goto(`/invoicing/bills/${bill.id}/edit`)
  const print = page.getByTestId('print-stock-receipt')
  await expect(print).toBeVisible({ timeout: 15000 })
  await expect(print).toContainText('Stock receipt')

  // The click asks; it prints nothing yet. A person who never chose starts on „Цена на едро".
  await print.click()
  const dialog = page.getByTestId('stock-receipt-dialog')
  const chosen = dialog.locator('.v-select__selection-text')
  await expect(dialog).toBeVisible()
  await expect(chosen).toHaveText('Цена на едро')

  // What it offers: the selling price, every slot under the name a person reads, the booked price last.
  await openSelect(dialog, /price to print/i)
  const options = page.getByRole('option')
  await expect(options).toHaveText([
    'Selling Price', 'Trade-discount price', 'Цена на едро',
    ...Array.from({ length: 11 }, (_, n) => `Цена ${n}`),
    'Booked price (as on the receipt)',
  ])
  await page.getByRole('option', { name: 'Цена на едро', exact: true }).click()

  // Cancel: nothing is printed, and nothing is remembered.
  await page.getByTestId('stock-receipt-cancel').click()
  await expect(dialog).toBeHidden()
  expect(asked).toEqual([])

  // Another level, printed: the PDF comes down, the dialog closes.
  await print.click()
  await expect(chosen).toHaveText('Цена на едро')
  await openSelect(dialog, /price to print/i)
  await page.getByRole('option', { name: 'Selling Price', exact: true }).click()
  await expect(chosen).toHaveText('Selling Price')
  const [download] = await Promise.all([page.waitForEvent('download', { timeout: 30000 }), page.getByTestId('stock-receipt-confirm').click()])
  expect(download.suggestedFilename()).toBe(`${bill.number}-stock-receipt.pdf`)
  const bytes = readFileSync((await download.path())!)
  expect(bytes.subarray(0, 4).toString()).toBe('%PDF')
  await expect(dialog).toBeHidden()
  expect(asked).toEqual(['selling'])

  // On ANOTHER bill the dialog opens on the level printed last, and prints it.
  await page.goto(`/invoicing/bills/${another.id}/edit`)
  await expect(page.getByTestId('print-stock-receipt')).toBeVisible({ timeout: 15000 })
  await page.getByTestId('print-stock-receipt').click()
  await expect(dialog).toBeVisible()
  await expect(chosen).toHaveText('Selling Price')
  const [second] = await Promise.all([page.waitForEvent('download', { timeout: 30000 }), page.getByTestId('stock-receipt-confirm').click()])
  expect(second.suggestedFilename()).toBe(`${another.number}-stock-receipt.pdf`)
  await expect(dialog).toBeHidden()
  expect(asked).toEqual(['selling', 'selling'])
})

test('a bill that booked nothing offers no „Stock receipt"', async ({ page }) => {
  const bill = await receivedBill()
  await loginForApp(page)

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
