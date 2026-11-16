import { test, expect } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { loginForApp } from './helpers/login'
import { apiLogin, apiGet, apiPost } from './helpers/api'

/**
 * A customer order (ORDI) prints. „Печат" on its form and in its row of the list brings down the order's sheet as
 * a PDF named by the order's number, through the tab's session (`GET /invoicing/internal-orders/:id/export`).
 *
 * What the sheet says (its title per status, the two parties, no price anywhere) is the unit test's
 * (`unit/customer-order-sheet.test.ts`); who may have it is the integration test's
 * (`integration/internal-order-print.flow.test.ts`). Here: the buttons are there, and the file arrives.
 */

type Session = Awaited<ReturnType<typeof apiLogin>>

/** A client, an article, and that client's order for it: a draft, or confirmed. */
async function customerOrder(session: Session, opts: { confirmed: boolean }) {
  const ts = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
  const { product } = await (await apiPost(session, '/warehouse/product', {
    sku: `E2E-OPRINT-${ts}`, name: `E2E print article ${ts}`, category: 'Test', type: 'goods', unit: 'pcs', sellingPrice: 3, purchasePrice: 1, taxRate: 20,
  })).json()
  const { contact } = await (await apiPost(session, '/invoicing/contact', { type: 'customer', companyName: `E2E print client ${ts}` })).json()
  const { internalOrder } = await (await apiPost(session, '/invoicing/internal-orders', {
    contactId: String(contact._id || contact.id), issueDate: new Date().toISOString().slice(0, 10), requestedDeliveryDate: '2026-11-20',
    lines: [{ productId: String(product._id || product.id), description: product.name, quantity: 4, unit: 'pcs', expectedUnitPrice: 3 }],
  })).json()
  if (!opts.confirmed) return internalOrder
  return (await (await apiPost(session, `/invoicing/internal-orders/${internalOrder._id}/confirm`, {})).json()).internalOrder
}

async function expectPdf(download: any, filename: string) {
  expect(download.suggestedFilename()).toBe(filename)
  const bytes = readFileSync((await download.path())!)
  expect(bytes.subarray(0, 4).toString()).toBe('%PDF')
  expect(bytes.length).toBeGreaterThan(5000)
}

async function openForm(page: any, ordi: any) {
  await loginForApp(page)
  await page.goto(`/invoicing/internal-orders/${ordi._id}/edit`)
  await expect(page.locator('.form-paper-header').getByText(ordi.orderNumber)).toBeVisible({ timeout: 15000 })
  await expect(page.getByTestId('print-order')).toBeVisible()
}

test.describe('A customer order prints', () => {
  test('Print on the form brings down the order sheet, a PDF named by the order number', async ({ page }) => {
    const session = await apiLogin()
    const ordi = await customerOrder(session, { confirmed: true })
    expect(ordi.orderNumber).toMatch(/^ORDI-/)
    await openForm(page, ordi)

    const [download] = await Promise.all([page.waitForEvent('download', { timeout: 30000 }), page.getByTestId('print-order').click()])
    await expectPdf(download, `${ordi.orderNumber}.pdf`)
    // Printing changed nothing: the order is as it was, and the form holds nothing unsaved.
    const { internalOrder: after } = await apiGet(session, `/invoicing/internal-orders/${ordi._id}`)
    expect(after.status).toBe('confirmed')
    expect(after.updatedAt).toBe(ordi.updatedAt)
  })

  test('an edit not saved yet is saved before it prints: the sheet is the stored order', async ({ page }) => {
    const session = await apiLogin()
    const ordi = await customerOrder(session, { confirmed: true })
    await openForm(page, ordi)

    const note = `Deliver before noon ${ordi.orderNumber}`
    await page.getByRole('textbox', { name: 'Notes', exact: true }).fill(note)
    const [download] = await Promise.all([page.waitForEvent('download', { timeout: 30000 }), page.getByTestId('print-order').click()])
    await expectPdf(download, `${ordi.orderNumber}.pdf`)
    const { internalOrder: after } = await apiGet(session, `/invoicing/internal-orders/${ordi._id}`)
    expect(after.notes).toBe(note)
  })

  test('Print in the list row brings down that order, a draft too', async ({ page }) => {
    const session = await apiLogin()
    const draft = await customerOrder(session, { confirmed: false })
    expect(draft.orderNumber).toMatch(/^DRF-/)
    await loginForApp(page)
    await page.goto(`/invoicing/internal-orders?q=${encodeURIComponent(draft.orderNumber)}`)
    const row = page.locator('tbody tr').filter({ hasText: draft.orderNumber })
    await expect(row).toHaveCount(1, { timeout: 15000 })

    const [download] = await Promise.all([page.waitForEvent('download', { timeout: 30000 }), row.getByTestId('print-order-row').click()])
    await expectPdf(download, `${draft.orderNumber}.pdf`)
    // The row's button is free again: a second file can be asked for.
    await expect(row.getByTestId('print-order-row')).toBeEnabled()
  })
})
