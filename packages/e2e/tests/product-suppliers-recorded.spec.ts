import { test, expect } from '@playwright/test'
import { loginForApp } from './helpers/login'
import { apiDelete, apiGet, apiLogin, apiPost } from './helpers/api'
import { okJson } from './helpers/bills'

/**
 * FR-28 slice 7 (FR-28.9) — the suppliers a person RECORDS about an article, on its Suppliers tab.
 *
 * One article of this spec's own (`E2E-RS-<stamp>`), one received bill for it from supplier A (so A is a supplier
 * the DOCUMENTS name), and three more suppliers that no document names: B and C are recorded from the tab, D is
 * recorded and then deactivated.
 *
 * What it pins, as the person at the tab sees it: a supplier recorded with no document behind it is listed, with a
 * badge; the code, the lead time and the note are edited in the row (Enter saves, Escape cancels, a rejected value
 * keeps the row open); the star marks ONE preferred supplier per article and moves it; clearing what is recorded
 * leaves a supplier the documents name listed with its facts, and removes one only a person recorded; a recorded
 * supplier that is no longer an active one says so; and a role that may not read bills is offered no tab. What the
 * server decides is `integration/product-suppliers-recorded.flow`.
 *
 * Serial: the cases build on one another's rows.
 */
test.describe.configure({ mode: 'serial' })
test.use({ viewport: { width: 1920, height: 900 } })

const stamp = Date.now().toString(36)
const sku = `E2E-RS-${stamp}`
const nameOf = (key: string) => `E2E Rec Supplier ${key} ${stamp}`

const API = process.env.BASE_URL || 'http://localhost:4001'

let admin: Awaited<ReturnType<typeof apiLogin>>
const ids: { product: string; bill?: string; suppliers: Record<string, string> } = { product: '', suppliers: {} }

const apiPut = (path: string, body: unknown) =>
  fetch(`${API}/api/org/${admin.orgId}${path}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${admin.token}` },
    body: JSON.stringify(body),
  })
const recordedOf = async () => (await apiGet(admin, `/warehouse/product-supplier/${ids.product}`)).recorded as any[]

test.beforeAll(async () => {
  admin = await apiLogin()
  const warehouses = (await apiGet(admin, '/warehouse/warehouse?size=100')).warehouses || []
  const warehouse = warehouses.find((w: any) => w.isDefault) || warehouses[0]
  expect(warehouse, 'the seed has a warehouse').toBeTruthy()

  for (const key of ['A', 'B', 'C', 'D']) {
    const { contact } = await okJson(await apiPost(admin, '/invoicing/contact', { type: 'supplier', companyName: nameOf(key) }))
    ids.suppliers[key] = contact._id || contact.id
  }
  const { product } = await okJson(await apiPost(admin, '/warehouse/product', {
    sku, name: `E2E recorded suppliers ${stamp}`, category: 'General', type: 'goods', unit: 'pcs',
    purchasePrice: 2.5, sellingPrice: 4, taxRate: 20,
  }))
  ids.product = product._id || product.id

  // Supplier A is bought from, on a received bill: a fact the documents state.
  const { invoice } = await okJson(await apiPost(admin, '/invoices', {
    type: 'invoice', direction: 'incoming', contactId: ids.suppliers.A, issueDate: new Date().toISOString().slice(0, 10), currency: 'EUR',
    lines: [{ productId: ids.product, warehouseId: warehouse._id, description: `E2E recorded suppliers ${stamp}`, quantity: 10, unit: 'pcs', unitPrice: 2.5, taxRate: 20 }],
    subtotal: 25, total: 30,
  }))
  ids.bill = invoice.id || invoice._id
  await okJson(await apiPost(admin, `/invoices/${ids.bill}/receive`, {}))
})

// Everything this spec made, undone: the recorded links first (a deactivated article or contact leaves them
// behind), then the bill is voided and the article and the contacts deactivate.
test.afterAll(async () => {
  for (const id of Object.values(ids.suppliers)) {
    await apiDelete(admin, `/warehouse/product/${ids.product}/suppliers/${id}`).catch(() => null)
  }
  if (ids.bill) await apiPost(admin, `/invoices/${ids.bill}/void`, {}).catch(() => null)
  if (ids.product) await apiDelete(admin, `/warehouse/product/${ids.product}`).catch(() => null)
  for (const id of Object.values(ids.suppliers)) await apiDelete(admin, `/invoicing/contact/${id}`).catch(() => null)
})

async function openTab(page: any) {
  await page.goto(`/inventory/products/${ids.product}/suppliers`)
  const tab = page.getByTestId('product-suppliers-tab')
  await expect(tab.getByTestId('product-supplier-row').first()).toBeVisible({ timeout: 15000 })
  return tab
}
const rowOf = (tab: any, key: string) => tab.getByTestId('product-supplier-row').filter({ hasText: nameOf(key) })
const input = (row: any, testId: string) => row.getByTestId(testId).locator('input')
const preferredOf = (row: any) => row.getByTestId('recorded-preferred')

/** Record a supplier through the field under the table: type its name, choose the option. */
async function recordThroughTheField(page: any, tab: any, key: string) {
  const field = tab.getByTestId('recorded-add')
  await field.locator('.v-field').click()
  await field.locator('input').fill(nameOf(key))
  const option = page.getByRole('option', { name: nameOf(key) })
  await expect(option).toBeVisible({ timeout: 10000 })
  await option.click()
}

test('a supplier recorded with no document behind it is listed with a badge, and its code, lead time and note are saved in the row', async ({ page }) => {
  await loginForApp(page)
  const tab = await openTab(page)

  // Supplier A is named by a bill, and nothing is recorded: one row, no badge, an empty star.
  await expect(tab.getByTestId('product-supplier-row')).toHaveCount(1)
  await expect(rowOf(tab, 'A')).toBeVisible()
  await expect(tab.getByTestId('recorded-no-documents')).toHaveCount(0)
  await expect(preferredOf(rowOf(tab, 'A'))).toHaveAttribute('aria-pressed', 'false')

  await recordThroughTheField(page, tab, 'B')
  const rowB = rowOf(tab, 'B')
  await expect(rowB).toBeVisible()
  await expect(tab.getByTestId('product-supplier-row')).toHaveCount(2)
  await expect(rowB.getByTestId('recorded-no-documents')).toBeVisible()
  // The new row opens for editing, and the field lets go of the choice: the supplier is not offered a second time.
  await expect(input(rowB, 'recorded-sku-input')).toBeVisible()
  await expect(tab.getByTestId('recorded-add').locator('input')).toHaveValue('')

  await input(rowB, 'recorded-sku-input').fill('B-100')
  await input(rowB, 'recorded-lead-input').fill('14')
  await input(rowB, 'recorded-note-input').fill('Ships on Tuesdays')
  await input(rowB, 'recorded-note-input').press('Enter')

  await expect(rowB.getByTestId('recorded-sku')).toHaveText('B-100')
  await expect(rowB.getByTestId('recorded-lead')).toHaveText('14')
  await expect(rowB.getByTestId('recorded-note')).toHaveText('Ships on Tuesdays')
  // No documents behind it: the fact columns are dashes.
  await expect(rowB.getByTestId('recorded-no-documents')).toBeVisible()

  // The server holds it, and a reload shows the same.
  expect(await recordedOf()).toEqual([expect.objectContaining({ supplierId: ids.suppliers.B, supplierSku: 'B-100', leadTimeDays: 14, note: 'Ships on Tuesdays', preferred: false })])
  await page.reload()
  const again = page.getByTestId('product-suppliers-tab')
  await expect(rowOf(again, 'B').getByTestId('recorded-sku')).toHaveText('B-100')

  // A supplier already in the table (A, named by the bill; B, recorded) is not offered again by the field. The stamp
  // is in all four names, so the others are offered: that is what says the search has answered.
  const field = again.getByTestId('recorded-add')
  await field.locator('.v-field').click()
  await field.locator('input').fill(stamp)
  await expect(page.getByRole('option', { name: nameOf('C') })).toBeVisible({ timeout: 10000 })
  await expect(page.getByRole('option', { name: nameOf('D') })).toBeVisible()
  await expect(page.getByRole('option', { name: nameOf('A') })).toHaveCount(0)
  await expect(page.getByRole('option', { name: nameOf('B') })).toHaveCount(0)
  await page.keyboard.press('Escape')
})

test('the star marks ONE preferred supplier per article: choosing another moves it, and the preferred one is listed first', async ({ page }) => {
  // C is recorded the way the tab would (nothing to learn from a second pass through the field).
  expect((await apiPut(`/warehouse/product/${ids.product}/suppliers/${ids.suppliers.C}`, { preferred: false })).status).toBe(200)

  await loginForApp(page)
  const tab = await openTab(page)
  await expect(tab.getByTestId('product-supplier-row')).toHaveCount(3)
  // The documents' supplier first, then the ones only a person recorded, by name.
  await expect(tab.getByTestId('product-supplier-row').nth(0)).toContainText(nameOf('A'))
  await expect(tab.getByTestId('product-supplier-row').nth(1)).toContainText(nameOf('B'))
  await expect(tab.getByTestId('product-supplier-row').nth(2)).toContainText(nameOf('C'))

  // Nobody preferred yet. Star C: it is the preferred one and moves to the top.
  for (const key of ['A', 'B', 'C']) await expect(preferredOf(rowOf(tab, key))).toHaveAttribute('aria-pressed', 'false')
  await preferredOf(rowOf(tab, 'C')).click()
  await expect(preferredOf(rowOf(tab, 'C'))).toHaveAttribute('aria-pressed', 'true')
  await expect(tab.getByTestId('product-supplier-row').first()).toContainText(nameOf('C'))

  // Star A, a supplier with no recorded details yet (the star records it): C lets go, A is the one.
  await preferredOf(rowOf(tab, 'A')).click()
  await expect(preferredOf(rowOf(tab, 'A'))).toHaveAttribute('aria-pressed', 'true')
  await expect(preferredOf(rowOf(tab, 'C'))).toHaveAttribute('aria-pressed', 'false')
  await expect(tab.getByTestId('product-supplier-row').first()).toContainText(nameOf('A'))
  let recorded = await recordedOf()
  expect(recorded.filter((r) => r.preferred).map((r) => r.supplierId)).toEqual([ids.suppliers.A])

  // The details recorded on B before are kept when another supplier is starred.
  await expect(rowOf(tab, 'B').getByTestId('recorded-sku')).toHaveText('B-100')

  // The star again takes the preference away: nobody is preferred, and nothing else is lost.
  await preferredOf(rowOf(tab, 'A')).click()
  await expect(preferredOf(rowOf(tab, 'A'))).toHaveAttribute('aria-pressed', 'false')
  recorded = await recordedOf()
  expect(recorded.filter((r) => r.preferred)).toHaveLength(0)
  expect(recorded.map((r) => r.supplierId).sort()).toEqual([ids.suppliers.A, ids.suppliers.B, ids.suppliers.C].sort())
})

test('the pencil edits the code and the lead time in the row: Escape cancels, Enter and the check save, a rejected value keeps the row open', async ({ page }) => {
  await loginForApp(page)
  const tab = await openTab(page)
  const rowB = rowOf(tab, 'B')

  // Escape drops what was typed.
  await rowB.getByTestId('recorded-edit').click()
  await expect(input(rowB, 'recorded-sku-input')).toHaveValue('B-100')
  await expect(input(rowB, 'recorded-lead-input')).toHaveValue('14')
  await input(rowB, 'recorded-sku-input').fill('B-DISCARDED')
  await input(rowB, 'recorded-sku-input').press('Escape')
  await expect(rowB.getByTestId('recorded-sku')).toHaveText('B-100')
  await expect(rowB.getByTestId('recorded-sku-input')).toHaveCount(0)

  // The cancel button does the same.
  await rowB.getByTestId('recorded-edit').click()
  await input(rowB, 'recorded-lead-input').fill('99')
  await rowB.getByTestId('recorded-cancel').click()
  await expect(rowB.getByTestId('recorded-lead')).toHaveText('14')

  // Enter saves.
  await rowB.getByTestId('recorded-edit').click()
  await input(rowB, 'recorded-sku-input').fill('B-200')
  await input(rowB, 'recorded-lead-input').fill('21')
  await input(rowB, 'recorded-lead-input').press('Enter')
  await expect(rowB.getByTestId('recorded-sku')).toHaveText('B-200')
  await expect(rowB.getByTestId('recorded-lead')).toHaveText('21')
  // …and keeps what the row did not touch.
  await expect(rowB.getByTestId('recorded-note')).toHaveText('Ships on Tuesdays')

  // The check saves too; an emptied code and lead time are cleared, not stored as blanks.
  await rowB.getByTestId('recorded-edit').click()
  await input(rowB, 'recorded-sku-input').fill('')
  await input(rowB, 'recorded-lead-input').fill('')
  await rowB.getByTestId('recorded-save').click()
  await expect(rowB.getByTestId('recorded-sku')).toHaveText('—')
  await expect(rowB.getByTestId('recorded-lead')).toHaveText('—')
  const stored = (await recordedOf()).find((r) => r.supplierId === ids.suppliers.B)
  expect(stored).toBeTruthy()
  expect(stored).not.toHaveProperty('supplierSku')
  expect(stored).not.toHaveProperty('leadTimeDays')

  // A value the server refuses (a lead time is whole days) is said, and the row stays open with what was typed.
  await rowB.getByTestId('recorded-edit').click()
  await input(rowB, 'recorded-lead-input').fill('2.5')
  await input(rowB, 'recorded-lead-input').press('Enter')
  await expect(page.getByText('The lead time is a whole number of days, 0 to 3650.')).toBeVisible()
  await expect(input(rowB, 'recorded-lead-input')).toHaveValue('2.5')
  await rowB.getByTestId('recorded-cancel').click()
  await expect(rowB.getByTestId('recorded-lead')).toHaveText('—')
})

test('clearing what is recorded leaves a supplier the documents name listed with its facts, and removes one only a person recorded', async ({ page }) => {
  await loginForApp(page)
  const tab = await openTab(page)
  const rowA = rowOf(tab, 'A')

  // A: record a code and a lead time on the supplier of the bill.
  await rowA.getByTestId('recorded-edit').click()
  await input(rowA, 'recorded-sku-input').fill('A-1')
  await input(rowA, 'recorded-lead-input').fill('3')
  await input(rowA, 'recorded-lead-input').press('Enter')
  await expect(rowA.getByTestId('recorded-sku')).toHaveText('A-1')
  // It has documents behind it: no badge.
  await expect(rowA.getByTestId('recorded-no-documents')).toHaveCount(0)
  const documentsBefore = await rowA.locator('td').nth(8).innerText()

  // Clear: the row stays (the bill names the supplier) with its facts, and the recorded cells are dashes.
  await rowA.getByTestId('recorded-clear').click()
  await expect(rowA.getByTestId('recorded-sku')).toHaveText('—')
  await expect(rowA.getByTestId('recorded-clear')).toHaveCount(0)
  await expect(tab.getByTestId('product-supplier-row')).toHaveCount(3)
  await expect(tab.getByTestId('product-supplier-document')).toHaveCount(1)
  expect(await rowA.locator('td').nth(8).innerText()).toBe(documentsBefore)
  expect((await recordedOf()).map((r) => r.supplierId)).not.toContain(ids.suppliers.A)

  // B and C were only ever recorded by a person: clearing them removes their rows.
  await rowOf(tab, 'B').getByTestId('recorded-clear').click()
  await expect(rowOf(tab, 'B')).toHaveCount(0)
  await rowOf(tab, 'C').getByTestId('recorded-clear').click()
  await expect(rowOf(tab, 'C')).toHaveCount(0)
  await expect(tab.getByTestId('product-supplier-row')).toHaveCount(1)
  expect(await recordedOf()).toEqual([])
  // Clearing what is not recorded any more is harmless: the server says it deleted nothing.
  const again = await apiDelete(admin, `/warehouse/product/${ids.product}/suppliers/${ids.suppliers.B}`)
  expect(await again.json()).toEqual({ deleted: false })
})

test('the Products list names a recorded supplier too: an article the Supplier filter finds through a recorded link is not a dash', async ({ page }) => {
  expect((await apiPut(`/warehouse/product/${ids.product}/suppliers/${ids.suppliers.C}`, { preferred: false })).status).toBe(200)
  await loginForApp(page)
  // Found by the Supplier filter through the recorded link alone (no document names C).
  await page.goto(`/inventory/products?q=${sku}&supplier=${ids.suppliers.C}`)
  const cell = page.locator('.v-data-table tbody tr').filter({ hasText: sku }).getByTestId('product-suppliers')
  await expect(cell).toContainText(nameOf('C'), { timeout: 15000 })
  await expect(cell).not.toHaveText('—')
  // The documents' supplier is listed first, and the tooltip says the recorded one has no purchase.
  await page.goto(`/inventory/products?q=${sku}`)
  await expect(cell).toContainText(nameOf('A'), { timeout: 15000 })
  await expect(cell).toContainText(nameOf('C'))
  await cell.hover()
  await expect(page.getByRole('tooltip')).toContainText('Recorded, no documents')
  await apiDelete(admin, `/warehouse/product/${ids.product}/suppliers/${ids.suppliers.C}`)
})

test('a recorded supplier that is no longer an active one is listed with a warning', async ({ page }) => {
  expect((await apiPut(`/warehouse/product/${ids.product}/suppliers/${ids.suppliers.D}`, { preferred: false, supplierSku: 'D-9' })).status).toBe(200)
  expect((await apiDelete(admin, `/invoicing/contact/${ids.suppliers.D}`)).ok).toBe(true)

  await loginForApp(page)
  const tab = await openTab(page)
  const rowD = rowOf(tab, 'D')
  await expect(rowD).toBeVisible()
  await expect(rowD.getByTestId('recorded-inactive')).toBeVisible()
  await expect(rowD.getByTestId('recorded-sku')).toHaveText('D-9')
  // It can still be cleared.
  await rowD.getByTestId('recorded-clear').click()
  await expect(rowOf(tab, 'D')).toHaveCount(0)
})

test('a role that may not read bills is offered no Suppliers tab, and the server refuses the tab', async ({ page }) => {
  // The seeded warehouse manager edits articles (and so may record a supplier through the API) but reads no bill:
  // who we buy from is not part of its role, so the tab is not offered.
  await loginForApp(page, 'acme-corp', 'warehouse', 'test123')
  await page.goto(`/inventory/products/${ids.product}/stock`)
  await expect(page.getByRole('tab', { name: 'Stock' })).toBeVisible()
  await expect(page.getByRole('tab', { name: 'Suppliers' })).toHaveCount(0)

  const warehouse = await apiLogin('acme-corp', 'warehouse', 'test123')
  const res = await fetch(`${API}/api/org/${warehouse.orgId}/warehouse/product-supplier/${ids.product}`, { headers: { Authorization: `Bearer ${warehouse.token}` } })
  expect(res.status).toBe(403)
  expect(await res.text()).not.toContain('E2E Rec Supplier')
})
