import { test, expect } from '@playwright/test'
import { startWalk, uxApi, UxWalk } from '../helpers/ux-budget'
import { lineQuantity } from '../helpers/document-form'

/**
 * P6 — Proforma → invoice. Quote a customer with a proforma; the customer accepts; convert it
 * into an invoice, issue that invoice and print it.
 *
 * Products used: PRD-0024, PRD-0025 (this agent's share of the acme-corp seed). Customer:
 * CityTech GmbH.
 */

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

/** The print dialog is taller than a 768 px window; its Download button sits below the fold. */
async function revealDialogButton(walk: UxWalk, dialog: ReturnType<UxWalk['page']['locator']>, button: ReturnType<UxWalk['page']['locator']>) {
  const box = await button.boundingBox()
  const card = await dialog.boundingBox()
  if (box && card && box.y + box.height > card.y + card.height) {
    await button.scrollIntoViewIfNeeded()
    walk.scrolled('the print dialog down to its Download button')
  }
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
    title: 'Proforma — 2 lines, convert to invoice, issue, print',
    start: '/invoicing/proforma',
  })
  await walk.shot('proforma-list')

  // ── 1. New proforma ──
  await walk.click(page.getByRole('link', { name: /Създай/ }).first(), 'create (list)')
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
  // The proforma's validity date („Валидна до", +30 days by default) — kept? (uncounted)
  const validOnForm = await page.getByLabel('Валидна до', { exact: true }).inputValue().catch(() => '')

  await walk.click(page.getByRole('button', { name: 'Запази' }).first(), 'save')
  await page.waitForURL(/\/invoicing\/proforma(\?|$)/)
  await expect(page.locator('.v-snackbar').filter({ hasText: 'Успешно запазено' })).toBeVisible()

  let proforma: any
  await expect.poll(async () => {
    const { invoices } = await api.get(`/invoices?type=proforma&contactId=${customer._id}&size=10&sortBy=createdAt&sortOrder=desc`)
    proforma = (invoices || []).find((i: any) =>
      new Date(i.createdAt) >= since && (i.lines || []).some((l: any) => String(l.productId) === products[LINES[0].sku]._id))
    return !!proforma
  }, { timeout: 15000 }).toBe(true)
  const savedValid = String(proforma.validUntil || proforma.dueDate || '').split('T')[0]
  if (validOnForm && savedValid !== validOnForm) {
    walk.note(`The proforma form showed its validity as ${validOnForm}; it was saved as ${savedValid || 'nothing'} (validUntil is not stored), so the list's „Валидна до" shows the issue date.`)
  }
  const proformaRow = page.locator('tbody tr').filter({ hasText: proforma.invoiceNumber })
  await expect(proformaRow).toBeVisible()
  const rowShowsValidity = !!validOnForm && (await proformaRow.innerText()).includes(validOnForm)
  await walk.shot('proforma-in-list')

  // What the user can do with the proforma itself (uncounted look).
  const rowActions = await proformaRow.locator('button, a').evaluateAll((els) =>
    els.map((e) => (e.getAttribute('aria-label') || e.getAttribute('title') || (e as HTMLElement).innerText.trim())
      + ((e as HTMLButtonElement).disabled ? ' (disabled)' : '')).filter(Boolean))
  const emailBtn = proformaRow.getByRole('button', { name: 'Изпрати по имейл' })
  const emailDisabled = await emailBtn.isDisabled()
  walk.note(`The proforma is saved as ${proforma.invoiceNumber} (status ${proforma.status}); its row offers [${rowActions.join(', ')}] — nothing issues it, so it keeps the draft number for good${emailDisabled ? ', and email stays disabled ("issue it first") although it never can be issued' : ''}.`)
  const canPrintProforma = await walk.offTheClock(async () => {
    const probe = await page.context().newPage()
    await probe.goto(`/invoicing/proforma/${proforma._id}/edit`, { waitUntil: 'networkidle' })
    await expect(probe.getByRole('heading', { name: 'Редактиране на проформа фактура' })).toBeVisible()
    const visible = await probe.getByRole('button', { name: 'Печат' }).first().isVisible()
    await probe.close()
    return visible
  })
  if (canPrintProforma && /^DRF-/.test(proforma.invoiceNumber)) {
    walk.note(`The proforma's own form offers Печат, so the customer's copy prints with the draft number ${proforma.invoiceNumber}.`)
  }

  // ── 2. The customer accepts: convert (row action) ──
  const nextIssued: string = (await api.get('/invoices/peek-next?type=invoice&direction=outgoing')).next
  await walk.scrollTableToEnd('the row actions')
  await walk.click(proformaRow.getByRole('button', { name: 'Преобразувай във фактура' }), 'convert to invoice (row)')
  await expect(page.locator('.v-snackbar').filter({ hasText: 'Успешно преобразувана във фактура' })).toBeVisible()
  let converted: any
  await expect.poll(async () => {
    const p = (await api.get(`/invoices/${proforma._id}`)).invoice
    if (p?.status !== 'converted' || !p.convertedInvoiceId) return false
    converted = (await api.get(`/invoices/${p.convertedInvoiceId}`)).invoice
    return !!converted
  }, { timeout: 15000 }).toBe(true)
  const convertedNumber: string = converted.invoiceNumber
  await expect(proformaRow.getByRole('link', { name: convertedNumber })).toBeVisible()
  await walk.shot('converted')
  walk.note(`Convert asks nothing and leaves the user on the proforma list; the new invoice is only a link in the row's „Фактура #" column. It is a DRAFT numbered ${convertedNumber}${/^DRF-/.test(convertedNumber) ? ' from the draft series' : ' from the ISSUED series (not a DRF- number)'}.`)
  const carried: string[] = []
  if (proforma.paymentMethod && !converted.paymentMethod) carried.push(`payment method („${proforma.paymentMethod}") dropped`)
  if (carried.length) walk.note(`Convert: ${carried.join('; ')}.`)

  // B-15: the form used to snapshot itself 500 ms after it mounted, not once the document had
  // loaded. Probe that in a second tab (uncounted): leave the untouched invoice the moment it renders.
  const raceDialog = await walk.offTheClock(async () => {
    const race = await page.context().newPage()
    await race.goto(`/invoicing/invoices/${converted._id}/edit`)
    await expect(race.getByRole('heading', { name: 'Редактиране на фактура' })).toBeVisible()
    await race.getByTestId('form-back').click()
    const shown = await race.getByRole('dialog').filter({ hasText: 'Незапазени промени' })
      .waitFor({ state: 'visible', timeout: 2000 }).then(() => true, () => false)
    await race.close()
    return shown
  })
  if (raceDialog) {
    walk.note('Leaving the untouched invoice right after it renders raises „Незапазени промени" (unsaved changes): the form took its clean snapshot on a 500 ms timer, not when the document had loaded, so any load slower than that hits a person too.')
  }

  // ── 3. Look at the new invoice ──
  await walk.click(proformaRow.getByRole('link', { name: convertedNumber }), 'open the new invoice (row link)')
  await page.waitForURL(new RegExp(`/invoices/${converted._id}/edit`))
  await expect(page.getByRole('heading', { name: 'Редактиране на фактура' })).toBeVisible()
  const draftCanPrint = await page.getByRole('button', { name: 'Печат' }).first().isVisible()
  const hasIssue = await page.getByRole('button', { name: /^(Изпрати|Издай)$/ }).count()
  await walk.shot('converted-invoice-form')
  walk.note(`The converted invoice's form has no Issue button${draftCanPrint ? ` but does offer Печат — it prints the draft as ${convertedNumber}, a number it loses on issue` : ''}; issuing is only on the sales list row.`)
  expect(hasIssue).toBe(0)

  // ── 4. Back to the sales list and issue it there ──
  // The user reads the page before leaving it. (The probe above leaves at once; B-15 raised a
  // false „Незапазени промени" there.)
  await page.waitForLoadState('networkidle')
  await page.waitForTimeout(1000)
  await walk.click(page.getByTestId('form-back'), 'back to the sales list')
  const leaveDialog = page.getByRole('dialog').filter({ hasText: 'Незапазени промени' })
  const outcome = await Promise.race([
    page.waitForURL(/\/invoicing\/invoices(\?|$)/, { timeout: 10000 }).then(() => 'left', () => 'stuck'),
    leaveDialog.waitFor({ state: 'visible', timeout: 10000 }).then(() => 'dialog', () => 'stuck'),
  ])
  if (outcome === 'dialog') {
    walk.dialog('„Незапазени промени" on leaving an untouched invoice')
    walk.note('Leaving the untouched converted invoice raised „Незапазени промени" (unsaved changes) — nothing was edited.')
    await walk.click(leaveDialog.getByRole('button', { name: 'Потвърди' }), 'confirm leaving')
  }
  await page.waitForURL(/\/invoicing\/invoices(\?|$)/)
  const draftRow = page.locator('tbody tr').filter({ hasText: convertedNumber })
  await expect(draftRow).toBeVisible()
  await walk.scrollTableToEnd('the row actions')
  await walk.click(draftRow.getByRole('button', { name: 'Изпрати', exact: true }), 'issue (row „Изпрати")')
  await expect(page.locator('.v-snackbar').filter({ hasText: 'Фактурата е изпратена успешно' })).toBeVisible()
  let issued: any
  await expect.poll(async () => {
    issued = (await api.get(`/invoices/${converted._id}`)).invoice
    return issued?.status
  }, { timeout: 15000 }).toMatch(/^(sent|paid)$/)
  const issuedRow = page.locator('tbody tr').filter({ hasText: issued.invoiceNumber })
  await expect(issuedRow).toBeVisible()
  await walk.shot('issued-in-list')

  // ── 5. Open it and print ──
  await walk.scrollTableToEnd('the row actions')
  await walk.click(issuedRow.getByRole('link', { name: 'Редактирай' }), 'open the issued invoice (row pencil)')
  await page.waitForURL(new RegExp(`/invoices/${converted._id}/edit`))
  await expect(page.getByRole('heading', { name: 'Редактиране на фактура' })).toBeVisible()
  await walk.click(page.getByRole('button', { name: 'Печат' }).first(), 'print')
  const printDialog = page.locator('.v-overlay--active .v-card').filter({ hasText: 'Печат' })
  await expect(printDialog).toBeVisible()
  walk.dialog('print options (format / mode / columns / companion documents)')
  const downloadBtn = printDialog.getByRole('button', { name: /Download|Изтегли/ })
  await expect(downloadBtn).toBeVisible()
  await walk.shot('print-dialog')
  await revealDialogButton(walk, printDialog, downloadBtn)
  const downloadPromise = page.waitForEvent('download', { timeout: 60000 })
  await walk.click(downloadBtn, 'download the PDF')
  const download = await downloadPromise
  expect(download.suggestedFilename()).toBe(`${issued.invoiceNumber}.pdf`)
  await expect(page.locator('.v-snackbar').filter({ hasText: 'Експортът е генериран' })).toBeVisible()
  await walk.shot('printed')

  // ── The numbers (uncounted) ──
  const { invoices: holders } = await api.get(`/invoices?search=${encodeURIComponent(convertedNumber)}&size=20`)
  const stillHeld = (holders || []).some((d: any) => d.invoiceNumber === convertedNumber)
  if (issued.invoiceNumber !== convertedNumber && !stillHeld && !/^DRF-/.test(convertedNumber)) {
    walk.note(`Number skipped: Convert drew ${convertedNumber} from the issued invoice counter for the draft, Issue drew ${issued.invoiceNumber}; ${convertedNumber} now belongs to no document (kept only as the invoice's draftNumber ${issued.draftNumber}) — a gap in the sales series.`)
  } else {
    walk.note(`Numbers: proforma ${proforma.invoiceNumber}, converted draft ${convertedNumber}, issued ${issued.invoiceNumber}.`)
  }

  const result = walk.finish()

  // ── FR-22 slice 1 guards (each failed on the code the budgets were first measured on) ──
  // B-11 / FR-22.9: the validity on the form is the validity stored, and the list shows it.
  expect(validOnForm).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  expect(savedValid).toBe(validOnForm)
  expect(rowShowsValidity).toBe(true)
  // B-5 / FR-22.3: the converted invoice is a draft with a draft number, and issuing it takes the
  // very next number of the sales series — none is burned.
  expect(convertedNumber).toMatch(/^DRF-/)
  expect(issued.invoiceNumber).toBe(nextIssued)
  // B-15 / FR-22.13 (fixed by #249, which re-snapshots the form once `loadDocument` finishes):
  // leaving an untouched document raises no unsaved-changes prompt.
  expect(raceDialog).toBe(false)
  expect(outcome).toBe('left')
  expect(result.clicks).toBeGreaterThan(0)
})
