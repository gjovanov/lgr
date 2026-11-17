import { test, expect } from '@playwright/test'
import { loginForApp } from './helpers/login'
import { activeContact, apiGet, apiLogin, apiPost } from './helpers/api'

/**
 * FR-31.16 / .17 (#796): decimal fields in the daily grids, and the app's own confirm dialog.
 *
 * - A number field dropped a typed comma: „2,5" became 25. A DecimalField takes a comma as a point, on every system,
 *   the wheel over a focused one changes nothing, and a loaded figure is not rewritten by opening and saving.
 * - Deleting an order asked through the browser's `confirm()`, whose „OK" and „Отказ" both read as cancelling. The
 *   app's dialog names the action on its button.
 */

const rows = (page: any) => page.locator('.line-table tbody tr')
const qtyOf = (row: any) => row.locator('td').nth(2).locator('input')

test.describe('decimal fields in the line grid (FR-31.16)', () => {
  test('a comma and a point are both a decimal point, and the wheel changes nothing', async ({ page }) => {
    await loginForApp(page)
    await page.goto('/invoicing/invoices/new')
    await expect(rows(page).first()).toBeVisible({ timeout: 15000 })
    const qty = qtyOf(rows(page).first())

    await qty.click()
    await qty.press('ControlOrMeta+a')
    await page.keyboard.type('2,5')
    await expect(qty).toHaveValue('2.5')

    await qty.press('ControlOrMeta+a')
    await page.keyboard.type('1.25')
    await expect(qty).toHaveValue('1.25')

    // The wheel over the focused field: the figure stays.
    await qty.hover()
    await page.mouse.wheel(0, -300)
    await page.mouse.wheel(0, 300)
    await expect(qty).toHaveValue('1.25')
  })

  test('a loaded quantity is not rewritten by opening and saving the form', async ({ page }) => {
    const api = await apiLogin()
    const customer = await activeContact(api, 'customer')
    const res = await apiPost(api, '/invoices', {
      type: 'invoice', direction: 'outgoing', contactId: customer.id || customer._id, issueDate: new Date().toISOString().slice(0, 10), currency: 'EUR',
      lines: [{ description: `E2E decimals ${Date.now()}`, unit: 'pcs', quantity: 1.23456, unitPrice: 0.04723, discount: 0, taxRate: 20 }],
      subtotal: 0.06, taxTotal: 0.01, total: 0.07,
    })
    expect(res.ok, `draft → ${res.status}`).toBe(true)
    const draft = (await res.json()).invoice
    const id = String(draft.id || draft._id)

    await loginForApp(page)
    await page.goto(`/invoicing/invoices/${id}/edit`)
    // Shown to the field's own decimals; held as it was loaded.
    await expect(qtyOf(rows(page).first())).toHaveValue('1.235', { timeout: 15000 })
    // A change elsewhere, so the form has something to save.
    await page.getByTestId('document-notes').locator('textarea').first().fill('E2E: saved without touching the line')
    const saved = page.waitForResponse(r => r.url().includes(`/invoices/${id}`) && r.request().method() === 'PUT')
    await page.locator('[data-action="save"]').first().getByRole('button').click()
    expect((await saved).ok()).toBe(true)

    const { invoice } = await apiGet(api, `/invoices/${id}`)
    expect(invoice.lines[0].quantity).toBe(1.23456)
    expect(invoice.lines[0].unitPrice).toBe(0.04723)
  })
})

test.describe('the app’s own confirm dialog (FR-31.17)', () => {
  async function world() {
    const api = await apiLogin()
    const ts = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
    const made = await apiPost(api, '/warehouse/product', { sku: `E2E-CFM-${ts}`, name: `E2E confirm ${ts}`, category: 'Test', type: 'goods', unit: 'pcs', sellingPrice: 3, purchasePrice: 1, taxRate: 20 })
    const { product } = await made.json()
    const supplier = await (await apiPost(api, '/invoicing/contact', { type: 'supplier', companyName: `E2E confirm supplier ${ts}` })).json()
    const client = await (await apiPost(api, '/invoicing/contact', { type: 'customer', companyName: `E2E confirm client ${ts}` })).json()
    const { warehouses } = await apiGet(api, '/warehouse/warehouse?size=100')
    const warehouse = warehouses.find((w: any) => w.isDefault) || warehouses[0]
    return { api, product, productId: product.id || product._id, supplierId: supplier.contact._id || supplier.contact.id, clientId: client.contact._id || client.contact.id, warehouseId: warehouse._id || warehouse.id }
  }

  async function deleteThroughTheDialog(page: any, url: string, gone: () => Promise<boolean>) {
    await loginForApp(page)
    let browserDialog = false
    page.on('dialog', async (d: any) => { browserDialog = true; await d.dismiss() })
    await page.goto(url)
    const del = page.getByRole('button', { name: /^delete$/i }).first()
    await expect(del).toBeVisible({ timeout: 15000 })

    // Cancel keeps it.
    await del.click()
    const dialog = page.getByTestId('confirm-dialog')
    await expect(dialog.getByTestId('confirm-dialog-yes')).toHaveText(/delete/i)
    await dialog.getByTestId('confirm-dialog-no').click()
    await expect(dialog.getByTestId('confirm-dialog-yes')).toHaveCount(0)
    expect(await gone()).toBe(false)

    // The button that names the action does it.
    await del.click()
    await dialog.getByTestId('confirm-dialog-yes').click()
    await expect.poll(gone, { timeout: 10000 }).toBe(true)
    expect(browserDialog, 'no browser dialog was opened').toBe(false)
  }

  test('deleting a draft supplier order asks in the app, and Delete deletes', async ({ page }) => {
    const w = await world()
    const res = await apiPost(w.api, '/invoicing/orders', {
      issueDate: new Date().toISOString().slice(0, 10), currency: 'EUR', tags: [],
      supplierGroups: [{ supplierId: w.supplierId, lines: [{ productId: w.productId, description: w.product.name, quantity: 4, unit: 'pcs', allocations: [{ warehouseId: w.warehouseId, quantity: 4 }] }] }],
    })
    const { order } = await res.json()
    const id = String(order._id || order.id)
    await deleteThroughTheDialog(page, `/invoicing/orders/${id}/edit`, async () => !(await apiGet(w.api, `/invoicing/orders/${id}`)).order)
  })

  test('deleting a draft customer order asks in the app, and Delete deletes', async ({ page }) => {
    const w = await world()
    const res = await apiPost(w.api, '/invoicing/internal-orders', {
      contactId: w.clientId, issueDate: new Date().toISOString().slice(0, 10),
      lines: [{ productId: w.productId, description: w.product.name, quantity: 3, unit: 'pcs' }],
    })
    const { internalOrder } = await res.json()
    const id = String(internalOrder._id || internalOrder.id)
    await deleteThroughTheDialog(page, `/invoicing/internal-orders/${id}/edit`, async () => !(await apiGet(w.api, `/invoicing/internal-orders/${id}`)).internalOrder)
  })
})

