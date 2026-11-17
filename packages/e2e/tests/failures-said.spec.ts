import { test, expect } from '@playwright/test'
import { loginForApp } from './helpers/login'
import { activeContact, apiGet, apiLogin, apiPost } from './helpers/api'
import { answerIssuePayment } from './helpers/document-form'

/**
 * FR-31.6 to .8 (#796): a failure is said on the screen, and stays.
 *  - A document that could not be loaded used to look like an empty draft: „Edit Invoice", a Draft chip, an empty
 *    form and enabled Issue and Save (reproduced with an id that does not exist).
 *  - A list whose request was refused looked like a list without rows.
 *  - A refused save was said by a toast that went after five seconds.
 */

const NOBODY = '0123456789abcdef01234567'
const loadError = (page: any) => page.getByTestId('form-load-error')
const saveButtons = (page: any) => page.getByRole('button', { name: /^save$/i })

test.describe('a record that did not load says so (FR-31.6)', () => {
  test('an invoice id that does not exist: not found, Back and Retry, and no Save or Issue', async ({ page }) => {
    await loginForApp(page)
    await page.goto(`/invoicing/invoices/${NOBODY}/edit`)
    await expect(loadError(page)).toBeVisible({ timeout: 15000 })
    await expect(loadError(page)).toHaveAttribute('data-failure', 'not_found')
    await expect(loadError(page)).toContainText('Not found')
    await expect(page.getByTestId('form-load-error-back')).toBeVisible()
    await expect(page.getByTestId('form-load-error-retry')).toBeVisible()
    await expect(saveButtons(page)).toHaveCount(0)
    await expect(page.getByRole('button', { name: /issue/i })).toHaveCount(0)
    // No form fields: no party picker, no line table.
    await expect(page.locator('.form-paper .v-autocomplete')).toHaveCount(0)
    await expect(page.locator('.v-table')).toHaveCount(0)
  })

  test('a warehouse that could not be loaded says so, and Retry loads it', async ({ page }) => {
    const api = await apiLogin()
    const s = `${Date.now()}`
    const res = await apiPost(api, '/warehouse/warehouse', { code: `F${s.slice(-6)}`, name: `E2E Склад F ${s}`, type: 'warehouse' })
    const { warehouse } = await res.json()
    const id = String(warehouse._id || warehouse.id)
    await loginForApp(page)

    // The first read fails on the server's side; the next one answers.
    let failed = false
    await page.route(`**/warehouse/warehouse/${id}`, async (route) => {
      if (!failed && route.request().method() === 'GET') {
        failed = true
        await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ message: 'Internal server error (ref 0)' }) })
        return
      }
      await route.continue()
    })
    await page.goto(`/inventory/warehouses/${id}/edit`)
    await expect(loadError(page)).toHaveAttribute('data-failure', 'failed', { timeout: 15000 })
    await expect(saveButtons(page)).toHaveCount(0)

    await page.getByTestId('form-load-error-retry').click()
    await expect(loadError(page)).toHaveCount(0)
    await expect(page.getByRole('textbox', { name: 'Name', exact: true })).toHaveValue(`E2E Склад F ${s}`)
    await expect(saveButtons(page).first()).toBeVisible()
  })
})

test.describe('a list that did not load says so (FR-31.7)', () => {
  test('a refused movements list shows a sentence and Retry, never "no data"', async ({ page }) => {
    await loginForApp(page)
    let refuse = true
    await page.route('**/warehouse/movement?*', async (route) => {
      if (refuse) {
        await route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ message: 'Forbidden' }) })
        return
      }
      await route.continue()
    })
    await page.goto('/inventory/movements')
    const error = page.getByTestId('list-load-error')
    await expect(error).toBeVisible({ timeout: 15000 })
    await expect(error).toHaveAttribute('data-failure', 'forbidden')
    await expect(page.getByText('No data available')).toHaveCount(0)

    refuse = false
    await page.getByTestId('list-load-error-retry').click()
    await expect(error).toHaveCount(0)
  })

  test('a sales invoices list whose request failed says so, with Retry', async ({ page }) => {
    await loginForApp(page)
    let fail = true
    await page.route(/\/api\/org\/[^/]+\/invoices\?/, async (route) => {
      if (fail && route.request().method() === 'GET') {
        await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ message: 'Internal server error (ref 0)' }) })
        return
      }
      await route.continue()
    })
    await page.goto('/invoicing/invoices')
    const error = page.getByTestId('list-load-error')
    await expect(error).toBeVisible({ timeout: 15000 })
    await expect(error).toHaveAttribute('data-failure', 'failed')
    fail = false
    await page.getByTestId('list-load-error-retry').click()
    await expect(error).toHaveCount(0)
  })
})

test.describe('a refusal stays (FR-31.8)', () => {
  test('a refused save is said at the top of the form, still there later, and gone after the next save', async ({ page }) => {
    const api = await apiLogin()
    const s = `${Date.now()}`
    const res = await apiPost(api, '/warehouse/warehouse', { code: `R${s.slice(-6)}`, name: `E2E Склад R ${s}`, type: 'warehouse' })
    const { warehouse } = await res.json()
    const id = String(warehouse._id || warehouse.id)
    await loginForApp(page)
    let refuse = true
    await page.route(`**/warehouse/warehouse/${id}`, async (route) => {
      if (refuse && route.request().method() === 'PUT') {
        await route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ message: 'Refused for the test' }) })
        return
      }
      await route.continue()
    })
    await page.goto(`/inventory/warehouses/${id}/edit`)
    const name = page.getByRole('textbox', { name: 'Name', exact: true })
    await expect(name).toHaveValue(`E2E Склад R ${s}`, { timeout: 15000 })
    await name.fill(`E2E Склад R ${s} renamed`)
    await saveButtons(page).first().click()
    const refusal = page.getByTestId('form-refusal')
    await expect(refusal).toContainText('Refused for the test')
    // A toast went after five seconds; the refusal is still on the form after six.
    await page.waitForTimeout(6000)
    await expect(refusal).toContainText('Refused for the test')

    refuse = false
    await saveButtons(page).first().click()
    await expect(refusal).toHaveCount(0)
  })

  test('a refused issue names the line it is about, until that line changes', async ({ page }) => {
    const api = await apiLogin()
    const customer = await activeContact(api, 'customer')
    const { warehouses } = await apiGet(api, '/warehouse/warehouse?size=50')
    const wh = warehouses.find((w: any) => w.code === 'WH-01') || warehouses[0]
    const warehouseId = String(wh.id || wh._id)
    const { products } = await apiGet(api, `/trade/pos/catalog?warehouseId=${warehouseId}&type=goods&size=1`)
    expect(customer && products?.length, 'an active customer and an article — is the DB seeded?').toBeTruthy()
    const p = products[0]
    const res = await apiPost(api, '/invoices', {
      type: 'invoice', direction: 'outgoing', contactId: customer.id || customer._id,
      issueDate: new Date().toISOString().slice(0, 10), currency: 'EUR',
      lines: [
        // A service line first: the refusal is about the second line only.
        { description: `E2E service ${Date.now()}`, unit: 'pcs', quantity: 1, unitPrice: 1, discount: 0, taxRate: 20 },
        { productId: p.productId, warehouseId, description: p.productName, unit: p.unit || 'pcs', quantity: 999999, unitPrice: 1, discount: 0, taxRate: p.taxRate || 0 },
      ],
      subtotal: 1000000, taxTotal: 0, total: 1000000,
    })
    expect(res.ok, `draft → ${res.status}`).toBe(true)
    const draft = (await res.json()).invoice

    await loginForApp(page)
    await page.goto(`/invoicing/invoices/${draft.id || draft._id}/edit`)
    await page.locator('[data-action="issue"]').first().getByRole('button').click()
    await answerIssuePayment(page)
    // Nothing holds 999,999: the transfer dialog cannot cover it, and is closed without confirming.
    const dialog = page.locator('.v-dialog').filter({ hasText: /Stock Transfer Required/i })
    await expect(dialog).toBeVisible({ timeout: 10000 })
    await dialog.getByRole('button', { name: /cancel/i }).click()
    await expect(dialog).toBeHidden()

    await expect(page.getByTestId('issue-error')).toBeVisible()
    const rows = page.locator('.line-table tbody tr')
    const marked = page.getByTestId('line-refusal')
    await expect(marked).toHaveCount(1)
    await expect(rows.nth(1).getByTestId('line-refusal')).toContainText(/not enough stock/i)
    await expect(rows.nth(1).getByTestId('line-refusal')).toContainText('999999')
    await expect(rows.nth(0).getByTestId('line-refusal')).toHaveCount(0)
    // Still there after the toasts would have gone.
    await page.waitForTimeout(6000)
    await expect(marked).toHaveCount(1)

    // A new quantity on that line: what was refused is no longer what the line says.
    const qty = rows.nth(1).locator('td').nth(2).locator('input')
    await qty.fill('1')
    await expect(marked).toHaveCount(0)
  })

  test('an error message outside a form stays until it is closed', async ({ page }) => {
    await loginForApp(page)
    // A server error on a list: the client says it on the message line (5xx).
    await page.route('**/warehouse/warehouse?*', async (route) => {
      await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ message: 'Internal server error (ref 1)' }) })
    })
    await page.goto('/inventory/warehouses')
    const message = page.locator('.v-snackbar--active').filter({ hasText: 'Internal server error (ref 1)' })
    await expect(message).toBeVisible({ timeout: 15000 })
    await page.waitForTimeout(6000)
    await expect(message).toBeVisible()
    await message.getByRole('button', { name: /close/i }).click()
    await expect(message).toHaveCount(0)
  })
})
