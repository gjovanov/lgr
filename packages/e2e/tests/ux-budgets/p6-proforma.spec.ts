import { test, expect } from '@playwright/test'
import { startWalk, uxApi } from '../helpers/ux-budget'
import { lineQuantity } from '../helpers/document-form'

/**
 * P6 — Proforma → invoice. Quote a customer with a proforma; the customer accepts; convert it
 * into an invoice, issue that invoice and print it.
 *
 * Products used: PRD-0024, PRD-0025 (this agent's share of the acme-corp seed). Customer:
 * CityTech GmbH.
 *
 * FR-22 slice 2 route: the proforma is issued and printed from its own form („Издай и печатай",
 * FR-22.22 gives it its PRF number), „Преобразувай във фактура" on the same form opens the new
 * invoice, and „Издай и печатай" there finishes the job. It used to be Save (to the list), the
 * row's Convert (the list again), the row's link to the invoice, back to the list to issue it,
 * the row's pencil to reopen it and the print dialog: 17 clicks and a dialog — and the proforma
 * itself could never be issued.
 */

/** FR-22 §3: P6 ≤ 12 clicks · 5 typed (and no more dialogs than the 1 it had). */
const BUDGET = { clicks: 12, typed: 5, dialogs: 1 }

type Api = Awaited<ReturnType<typeof uxApi>>

const CUSTOMER = 'CityTech GmbH'
const LINES = [
  { sku: 'PRD-0024', qty: 2 },
  { sku: 'PRD-0025', qty: 3 },
]

async function productsBySku(api: Api, skus: string[]): Promise<Record<string, any>> {
  const out: Record<string, any> = {}
  for (const sku of skus) {
    const { products } = await api.get(`/warehouse/product?search=${encodeURIComponent(sku)}&size=5`)
    const p = (products || []).find((x: any) => x.sku === sku)
    expect(p, `seed product ${sku}`).toBeTruthy()
    out[sku] = p
  }
  return out
}

/** Keep the walk re-runnable: top the default warehouse up when a product runs low. */
async function ensureStock(api: Api, products: Record<string, any>, needs: Record<string, number>) {
  const { warehouses } = await api.get('/warehouse/warehouse?size=100')
  const main = (warehouses || []).find((w: any) => w.isDefault) || warehouses?.[0]
  const lines: any[] = []
  for (const [sku, need] of Object.entries(needs)) {
    const p = products[sku]
    const res = await api.get(`/warehouse/stock-level?productId=${p._id}&warehouseId=${main._id}&size=5`)
    const sl = (res.stockLevels || [])[0]
    const available = sl ? Number(sl.availableQuantity ?? (sl.quantity - (sl.reservedQuantity || 0))) : 0
    if (available < need + 10) {
      lines.push({ productId: p._id, quantity: 50, unitCost: p.purchasePrice || 0, totalCost: 50 * (p.purchasePrice || 0) })
    }
  }
  if (!lines.length) return
  const { stockMovement } = await api.post('/warehouse/movement', {
    type: 'receipt',
    date: new Date().toISOString(),
    toWarehouseId: main._id,
    lines,
    totalAmount: lines.reduce((s, l) => s + l.totalCost, 0),
    notes: 'ux-budget P6 top-up',
  })
  await api.post(`/warehouse/movement/${stockMovement._id || stockMovement.id}/confirm`, {})
}

test('P6 proforma: quote, convert to an invoice, issue and print it', async ({ page }, testInfo) => {
  const api = await uxApi()
  const products = await productsBySku(api, LINES.map((l) => l.sku))
  await ensureStock(api, products, Object.fromEntries(LINES.map((l) => [l.sku, l.qty])))
  const { contacts } = await api.get(`/invoicing/contact?search=${encodeURIComponent(CUSTOMER)}&size=5`)
  const customer = (contacts || []).find((c: any) => c.companyName === CUSTOMER)
  expect(customer, CUSTOMER).toBeTruthy()
  const since = new Date(Date.now() - 1000)

  const walk = await startWalk(page, testInfo, {
    id: 'P6',
    title: 'Proforma — 2 lines, issued and printed, converted, the invoice issued and printed',
    start: '/invoicing/proforma',
  })
  await walk.shot('proforma-list')

  // ── 1. New proforma ──
  // FR-22.50: the list's Create says what it creates.
  await walk.click(page.getByRole('link', { name: 'Нова проформа фактура' }).first(), 'create („Нова проформа фактура")')
  await page.waitForURL(/\/invoicing\/proforma\/new/)
  await expect(page.getByRole('heading', { name: 'Нова проформа фактура' })).toBeVisible()

  await walk.type(page.getByRole('combobox', { name: /Клиент/ }), 'City', 'search the customer')
  const clientOption = page.locator('.v-overlay--active .v-list-item').filter({ hasText: CUSTOMER }).first()
  await expect(clientOption).toBeVisible()
  await walk.click(clientOption, 'pick the customer')

  const rows = page.locator('.line-table tbody tr')
  for (let i = 0; i < LINES.length; i++) {
    const { sku, qty } = LINES[i]
    const row = rows.nth(i)
    const search = row.getByPlaceholder('Търсете продукти...')
    // The user wheels the line table up first, or the results open below the window's edge.
    await search.evaluate((el) => el.scrollIntoView({ block: 'center' }))
    await walk.type(search, sku, `line ${i + 1}: search ${sku}`)
    const option = page.locator('.pld-overlay .pld-item').filter({ hasText: sku }).first()
    await expect(option).toBeVisible()
    await walk.click(option, `line ${i + 1}: pick ${sku}`)
    await expect(row.locator('.v-chip').filter({ hasText: products[sku].name })).toBeVisible()
    if (qty !== 1) await walk.fill(lineQuantity(row), String(qty), `line ${i + 1}: quantity ${qty}`)
  }
  await walk.shot('proforma-filled')
  // FR-22.26 (uncounted): a proforma quotes the customer's last price too — the line table offers it.
  const lastPriceOffered = await page.getByTestId('last-price-checkbox').count()
  // The proforma's validity date („Валидна до", +30 days by default) — kept? (uncounted)
  const validOnForm = await page.getByLabel('Валидна до', { exact: true }).inputValue().catch(() => '')

  // ── 2. The proforma goes to the customer: issued (its PRF number) and printed (FR-22.22) ──
  const prfDownload = page.waitForEvent('download', { timeout: 60000 })
  await walk.click(page.getByRole('button', { name: 'Издай и печатай' }).first(), 'issue and print the proforma')
  const prfFile = await prfDownload
  await expect(page.getByRole('heading', { name: 'Редактиране на проформа фактура' })).toBeVisible()
  // „Проформата е издадена успешно", then the print's own message replaces it.
  await expect(page.locator('.v-snackbar').filter({ hasText: 'Експортът е генериран' })).toBeVisible()
  let proforma: any
  await expect.poll(async () => {
    const { invoices } = await api.get(`/invoices?type=proforma&contactId=${customer._id}&size=10&sortBy=createdAt&sortOrder=desc`)
    proforma = (invoices || []).find((i: any) =>
      new Date(i.createdAt) >= since && (i.lines || []).some((l: any) => String(l.productId) === products[LINES[0].sku]._id))
    return proforma?.status
  }, { timeout: 15000 }).toBe('sent')
  await walk.shot('proforma-issued')
  const savedValid = String(proforma.dueDate || '').split('T')[0]

  // ── 3. The customer accepts: convert, on the proforma's own form ──
  const nextIssued: string = (await api.get('/invoices/peek-next?type=invoice&direction=outgoing')).next
  await walk.click(page.getByRole('button', { name: 'Преобразувай във фактура' }).first(), 'convert to invoice (the form)')
  await expect(page.locator('.v-snackbar').filter({ hasText: 'Успешно преобразувана във фактура' })).toBeVisible()
  // Lands on the new invoice — no list, no link to find.
  await page.waitForURL(/\/invoicing\/invoices\/[0-9a-f]{24}\/edit/)
  await expect(page.getByRole('heading', { name: 'Редактиране на фактура' })).toBeVisible()
  const convertedId = page.url().match(/\/invoices\/([0-9a-f]{24})\/edit/)![1]
  const converted = (await api.get(`/invoices/${convertedId}`)).invoice
  expect(String(converted.proformaId)).toBe(String(proforma._id))
  const convertedNumber: string = converted.invoiceNumber
  await walk.shot('converted-invoice-form')

  // B-15: the form used to snapshot itself 500 ms after it mounted, not once the document had
  // loaded. Probe that in a second tab (uncounted): leave the untouched invoice the moment it renders.
  const raceDialog = await walk.offTheClock(async () => {
    const race = await page.context().newPage()
    await race.goto(`/invoicing/invoices/${convertedId}/edit`)
    await expect(race.getByRole('heading', { name: 'Редактиране на фактура' })).toBeVisible()
    await race.getByTestId('form-back').click()
    const shown = await race.getByRole('dialog').filter({ hasText: 'Незапазени промени' })
      .waitFor({ state: 'visible', timeout: 2000 }).then(() => true, () => false)
    await race.close()
    return shown
  })

  // ── 4. Issue and print the invoice ──
  const invDownload = page.waitForEvent('download', { timeout: 60000 })
  await walk.click(page.getByRole('button', { name: 'Издай и печатай' }).first(), 'issue and print the invoice')
  const invFile = await invDownload
  await expect(page.locator('.v-snackbar').filter({ hasText: 'Експортът е генериран' })).toBeVisible()
  let issued: any
  await expect.poll(async () => {
    issued = (await api.get(`/invoices/${convertedId}`)).invoice
    return issued?.status
  }, { timeout: 15000 }).toMatch(/^(sent|paid)$/)
  await expect(page.locator('.doc-banner-meta .text-h6')).toHaveText(issued.invoiceNumber)
  await walk.shot('invoice-issued-printed')

  walk.note(`Numbers: proforma ${proforma.draftNumber} → ${proforma.invoiceNumber} (printed ${prfFile.suggestedFilename()}), converted draft ${convertedNumber}, issued ${issued.invoiceNumber} (printed ${invFile.suggestedFilename()}).`)

  const result = walk.finish()

  // ── FR-22 §3 budget for P6 ──
  expect(result.clicks).toBeLessThanOrEqual(BUDGET.clicks)
  expect(result.typed).toBeLessThanOrEqual(BUDGET.typed)
  expect(result.dialogs).toBeLessThanOrEqual(BUDGET.dialogs)
  expect(result.hops).toBe(0)
  // FR-22.22: the proforma is issued from its own series and printed under that number; converting
  // it lands on the invoice, which carries the proforma's validity as its due date.
  expect(proforma.invoiceNumber).toMatch(/^PRF-\d{4}-\d+$/)
  expect(prfFile.suggestedFilename()).toBe(`${proforma.invoiceNumber}.pdf`)
  expect(invFile.suggestedFilename()).toBe(`${issued.invoiceNumber}.pdf`)
  expect(String(converted.dueDate || '').slice(0, 10)).toBe(savedValid)
  // FR-22.27 → FR-22.22: the proforma states where the deal is made (the warehouse's city), and
  // the invoice it becomes carries it over.
  expect(proforma.placeOfTransaction).toBe('Berlin')
  expect(converted.placeOfTransaction).toBe('Berlin')
  // FR-22.26: „Последна цена за клиента" on a proforma as on an invoice.
  expect(lastPriceOffered).toBe(1)

  // ── FR-22 slice 1 guards (each failed on the code the budgets were first measured on) ──
  // B-11 / FR-22.9: the validity on the form is the validity stored.
  expect(validOnForm).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  expect(savedValid).toBe(validOnForm)
  // B-5 / FR-22.3: the converted invoice is a draft with a draft number, and issuing it takes the
  // very next number of the sales series — none is burned.
  expect(convertedNumber).toMatch(/^DRF-/)
  expect(issued.invoiceNumber).toBe(nextIssued)
  // B-15 / FR-22.13: leaving an untouched document raises no unsaved-changes prompt.
  expect(raceDialog).toBe(false)
})
