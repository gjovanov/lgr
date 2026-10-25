import { test, expect } from '@playwright/test'
import { startWalk, uxApi, UxWalk } from '../helpers/ux-budget'
import { lineQuantity } from '../helpers/document-form'

/**
 * P5 — Invoice. The core daily task: a customer at the counter buys three articles and pays by
 * card. Create the invoice, issue it (its real number), print it, and have it show as paid.
 *
 * Products used: PRD-0021..0023 (this agent's share of the acme-corp seed). Customer: Alpha
 * Manufacturing.
 */

type Api = Awaited<ReturnType<typeof uxApi>>
type Loc = ReturnType<UxWalk['page']['locator']>

const CUSTOMER = 'Alpha Manufacturing'
const LINES = [
  { sku: 'PRD-0021', qty: 2 },
  { sku: 'PRD-0022', qty: 1 },
  { sku: 'PRD-0023', qty: 4 },
]

/** Product records by SKU (uncounted setup). */
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

/**
 * Keep the walk re-runnable: every run dispatches stock, so top the default warehouse up with a
 * receipt when a product runs low. Uncounted — the user never sees it.
 */
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
    notes: 'ux-budget P5 top-up',
  })
  await api.post(`/warehouse/movement/${stockMovement._id || stockMovement.id}/confirm`, {})
}

/** The document the walk just saved: newest of its type for the customer, holding our first product. */
async function findNewDoc(api: Api, opts: { type: string; contactId: string; productId: string; since: Date }) {
  let doc: any
  await expect.poll(async () => {
    const { invoices } = await api.get(`/invoices?type=${opts.type}&contactId=${opts.contactId}&size=10&sortBy=createdAt&sortOrder=desc`)
    doc = (invoices || []).find((i: any) =>
      new Date(i.createdAt) >= opts.since && (i.lines || []).some((l: any) => String(l.productId) === opts.productId))
    return !!doc
  }, { timeout: 15000 }).toBe(true)
  return doc
}

/** The print dialog is taller than a 768 px window; its Download button sits below the fold. */
async function revealDialogButton(walk: UxWalk, dialog: Loc, button: Loc) {
  const box = await button.boundingBox()
  const card = await dialog.boundingBox()
  if (box && card && box.y + box.height > card.y + card.height) {
    await button.scrollIntoViewIfNeeded()
    walk.scrolled('the print dialog down to its Download button')
  }
}

/** The text a v-select shows (its selection), without its label. */
async function selectText(field: Loc): Promise<string> {
  return (await field.locator('.v-select__selection-text').allInnerTexts()).join(', ').trim()
}

test('P5 invoice: create, issue, print and mark paid a card sale', async ({ page }, testInfo) => {
  const api = await uxApi()
  const products = await productsBySku(api, LINES.map((l) => l.sku))
  await ensureStock(api, products, Object.fromEntries(LINES.map((l) => [l.sku, l.qty])))
  const { contacts } = await api.get(`/invoicing/contact?search=${encodeURIComponent(CUSTOMER)}&size=5`)
  const customer = (contacts || []).find((c: any) => c.companyName === CUSTOMER)
  expect(customer, CUSTOMER).toBeTruthy()
  const since = new Date(Date.now() - 1000)
  const english: string[] = []

  const walk = await startWalk(page, testInfo, {
    id: 'P5-invoice',
    title: 'Invoice — 3 lines, card payment, issue, print, mark paid',
    start: '/invoicing/invoices',
  })
  await walk.shot('sales-list')

  // What the starting page looks like at 1366×768 (uncounted).
  const wrapGeom = await page.locator('.v-table__wrapper').first().evaluate((el) => {
    const r = el.getBoundingClientRect()
    const heights = [...el.querySelectorAll('tbody tr')].map((tr) => Math.round(tr.getBoundingClientRect().height))
    return { hidden: el.scrollWidth - el.clientWidth, bottom: Math.round(r.bottom + window.scrollY), top: Math.round(r.top), minH: Math.min(...heights), maxH: Math.max(...heights) }
  })
  if (wrapGeom.hidden > 0) {
    walk.note(`List at 1366×768: the Actions column (Изпрати / Запис на плащане / Редактирай) is ${wrapGeom.hidden}px past the table's right edge, and the table's sideways scrollbar is at its bottom (${wrapGeom.bottom}px down a 768px window). The row icons stack vertically, so rows are ${wrapGeom.minH}–${wrapGeom.maxH}px tall and the table starts ${wrapGeom.top}px down: about two rows fit on screen.`)
  }
  const typeFilterText = (await page.locator('.v-field').filter({ hasText: 'Тип документ' }).first().innerText()).replace('Тип документ', '').trim()
  if (/статус/i.test(typeFilterText)) walk.note(`The „Тип документ" (document type) filter reads „${typeFilterText}" (all statuses).`)

  // How the customer list opens before anything is typed (uncounted look, second tab) — why the
  // walk types the name instead of picking from the list.
  const { opened, supplierList } = await walk.offTheClock(async () => {
    const look = await page.context().newPage()
    await look.goto('/invoicing/invoices/new', { waitUntil: 'networkidle' })
    await expect(look.getByRole('heading', { name: 'Нова фактура' })).toBeVisible()
    await look.getByRole('combobox', { name: /Клиент/ }).locator('xpath=ancestor::div[contains(@class,"v-field")][1]').click()
    await expect(look.locator('.v-overlay--active .v-list-item').first()).toBeVisible()
    const items = (await look.locator('.v-overlay--active .v-list-item').allInnerTexts()).map((t) => t.trim()).filter(Boolean)
    await look.close()
    const { contacts: sup } = await api.get('/invoicing/contact?type=supplier&size=100')
    return { opened: items, supplierList: sup }
  })
  const suppliersShown = opened.filter((n) => (supplierList || []).some((c: any) => c.type === 'supplier' && c.companyName === n))
  const pos = opened.indexOf(CUSTOMER) + 1
  walk.note(`The „Клиент" list opens with ${opened.length - 1} contacts in no useful order (${CUSTOMER} is no. ${pos || '—'}, below the menu's fold)${suppliersShown.length ? ` and includes suppliers (${suppliersShown.slice(0, 3).join(', ')}…)` : ''}, so the user types the name.`)

  // ── 1. New invoice ──
  await walk.click(page.getByRole('link', { name: /Създай/ }).first(), 'create (list)')
  await page.waitForURL(/\/invoicing\/invoices\/new/)
  await expect(page.getByRole('heading', { name: 'Нова фактура' })).toBeVisible()
  // The type toggle already says „Фактура"; nothing to choose.

  // ── 2. Customer ──
  await walk.type(page.getByRole('combobox', { name: /Клиент/ }), 'Alpha', 'search the customer')
  const clientOption = page.locator('.v-overlay--active .v-list-item').filter({ hasText: CUSTOMER }).first()
  await expect(clientOption).toBeVisible()
  await walk.click(clientOption, 'pick the customer')
  await walk.shot('customer-picked')

  // ── 3. Payment method (header, right column) ──
  const pmField = page.locator('.v-field').filter({ has: page.getByRole('combobox', { name: 'Метод на плащане' }) }).first()
  const pmDefault = await selectText(pmField)
  await walk.choose(page, /Метод на плащане/, 'С карта', 'payment method: card')

  // ── 4. Lines ──
  const rows = page.locator('.line-table tbody tr')
  for (let i = 0; i < LINES.length; i++) {
    const { sku, qty } = LINES[i]
    const row = rows.nth(i)
    const search = row.getByPlaceholder('Търсете продукти...')
    // A mouse user wheels the line table up before typing (not counted), or the results list
    // opens below the bottom edge of the window.
    await search.evaluate((el) => el.scrollIntoView({ block: 'center' }))
    await walk.type(search, sku, `line ${i + 1}: search ${sku}`)
    const option = page.locator('.pld-overlay .pld-item').filter({ hasText: sku }).first()
    await expect(option).toBeVisible()
    await walk.click(option, `line ${i + 1}: pick ${sku}`)
    await expect(row.locator('.v-chip').filter({ hasText: products[sku].name })).toBeVisible()
    if (qty !== 1) await walk.fill(lineQuantity(row), String(qty), `line ${i + 1}: quantity ${qty}`)
  }
  // Picking a product on the last row appends an empty row: 4 rows, the last one blank.
  await expect(rows).toHaveCount(LINES.length + 1)
  await walk.shot('lines-entered')

  // Place of deal: the form shows „Място на сделката: —" and offers no field to fill it.
  const placeText = await page.locator('.signature-footer').innerText().catch(() => '')
  if (/Място на сделката:\s*—/.test(placeText)) {
    walk.note('„Място на сделката" is display-only on the form („—"): no field and no org default, so the printed invoice has none.')
  }
  const peeked = (await page.locator('.doc-banner-meta .text-h6').innerText()).trim()

  // ── 5. Save — returns to the list ──
  await walk.click(page.getByRole('button', { name: 'Запази' }).first(), 'save')
  await page.waitForURL(/\/invoicing\/invoices(\?|$)/)
  const saved = page.locator('.v-snackbar').filter({ hasText: 'Успешно запазено' })
  await expect(saved).toBeVisible()
  if (await saved.getByRole('button', { name: /^close$/i }).count()) english.push('every snackbar\'s „CLOSE" button')

  const draft = await findNewDoc(api, { type: 'invoice', contactId: customer._id, productId: products[LINES[0].sku]._id, since })
  expect(draft.status).toBe('draft')
  expect(draft.paymentMethod).toBe('card')
  const draftRow = page.locator('tbody tr').filter({ hasText: draft.invoiceNumber })
  await expect(draftRow).toBeVisible()
  await walk.shot('draft-in-list')
  walk.note(`Save returns to the list with the invoice still a draft (${peeked}); the form has no Issue button — issuing is the list row's „Изпрати" (send) icon.`)
  // Does the draft offer Print? (uncounted look, second tab)
  const draftPrint = await walk.offTheClock(async () => {
    const probe = await page.context().newPage()
    await probe.goto(`/invoicing/invoices/${draft._id}/edit`, { waitUntil: 'networkidle' })
    await expect(probe.getByRole('heading', { name: 'Редактиране на фактура' })).toBeVisible()
    const visible = await probe.getByRole('button', { name: 'Печат' }).first().isVisible()
    await probe.close()
    return visible
  })
  if (draftPrint) walk.note(`The draft's own form offers Печат too: printed before issuing, the customer's invoice would carry ${draft.invoiceNumber}.`)

  // ── 6. Issue (row action) ──
  await walk.scrollTableToEnd('the row actions')
  await walk.click(draftRow.getByRole('button', { name: 'Изпрати', exact: true }), 'issue (row „Изпрати")')
  await expect(page.locator('.v-snackbar').filter({ hasText: 'Фактурата е изпратена успешно' })).toBeVisible()
  let issued: any
  await expect.poll(async () => {
    issued = (await api.get(`/invoices/${draft._id}`)).invoice
    return issued?.status
  }, { timeout: 15000 }).toBe('sent')
  const issuedRow = page.locator('tbody tr').filter({ hasText: issued.invoiceNumber })
  await expect(issuedRow).toBeVisible()
  await walk.shot('issued-in-list')

  // ── 7. Record the card payment (row action) ──
  await walk.scrollTableToEnd('the row actions')
  await walk.click(issuedRow.getByRole('button', { name: 'Запис на плащане' }), 'record payment (row)')
  const payDialog = page.locator('.v-overlay--active .v-card').filter({ hasText: 'Запис на плащане' })
  await expect(payDialog).toBeVisible()
  walk.dialog('record payment')
  const amount = Number(await payDialog.getByLabel('Сума').inputValue())
  expect(amount).toBeCloseTo(issued.total, 2)
  const methodShown = await selectText(payDialog.locator('.v-field').filter({ has: page.getByRole('combobox', { name: 'Метод на плащане' }) }).first())
  walk.note(`Card at the counter is not settled on issue — only „В брой" is (cash-settlement rule; ${pmDefault ? `the form defaults to „${pmDefault}"` : 'no default'}): a card sale stays „Изпратена" until a payment is recorded on the list row.`)
  if (!/карта/i.test(methodShown)) {
    walk.note(`Record-payment dialog: the amount is prefilled (${amount}) but the method defaults to „${methodShown}" although the invoice says „С карта" — card is picked a second time.`)
    await walk.choose(payDialog, /Метод на плащане/, 'С карта', 'payment method: card (again)')
  }
  await walk.shot('payment-dialog')
  await walk.click(payDialog.getByRole('button', { name: 'Запази' }), 'save payment')
  await expect(page.locator('.v-snackbar').filter({ hasText: 'Плащането е записано успешно' })).toBeVisible()
  await expect(issuedRow.getByText('Платена')).toBeVisible()
  await walk.shot('paid-in-list')

  // ── 8. Open it and print ──
  await walk.scrollTableToEnd('the row actions')
  await walk.click(issuedRow.getByRole('link', { name: 'Редактирай' }), 'open the issued invoice (row pencil)')
  await page.waitForURL(new RegExp(`/invoices/${draft._id}/edit`))
  await expect(page.getByRole('heading', { name: 'Редактиране на фактура' })).toBeVisible()
  walk.note('Print is only on the opened document, so the user reopens the invoice after issuing it; the list\'s „Експорт" is a list export, not the invoice.')
  if (await page.locator('.smart-buttons-row').getByText('Payments', { exact: true }).count()) english.push('the „Payments" smart button on the paid invoice')

  await walk.click(page.getByRole('button', { name: 'Печат' }).first(), 'print')
  const printDialog = page.locator('.v-overlay--active .v-card').filter({ hasText: 'Печат' })
  await expect(printDialog).toBeVisible()
  walk.dialog('print options (format / mode / columns / companion documents)')
  const downloadBtn = printDialog.getByRole('button', { name: /Download|Изтегли/ })
  await expect(downloadBtn).toBeVisible()
  await walk.shot('print-dialog')
  if (await printDialog.getByRole('button', { name: 'Download' }).count()) english.push('the print dialog\'s „Download" button (`common.download` missing from bg.json)')
  const enCols = (await printDialog.locator('.v-checkbox label').allInnerTexts()).filter((t) => /^(Qty|Unit)$/.test(t.trim()))
  if (enCols.length) english.push(`print column names ${enCols.map((t) => `„${t.trim()}"`).join(' and ')}`)
  await revealDialogButton(walk, printDialog, downloadBtn)
  const downloadPromise = page.waitForEvent('download', { timeout: 60000 })
  await walk.click(downloadBtn, 'download the PDF')
  const download = await downloadPromise
  expect(download.suggestedFilename()).toBe(`${issued.invoiceNumber}.pdf`)
  await expect(page.locator('.v-snackbar').filter({ hasText: 'Експортът е генериран' })).toBeVisible()
  await walk.shot('printed')

  // What was stored (uncounted).
  const final = (await api.get(`/invoices/${draft._id}`)).invoice
  expect(final.status).toBe('paid')
  expect(final.paymentMethod).toBe('card')
  expect(final.payments?.[0]?.method).toBe('card')
  walk.note(`Draft ${draft.invoiceNumber} was issued as ${issued.invoiceNumber}, printed as ${download.suggestedFilename()}, paid by card.`)
  if (english.length) walk.note(`English in the bg UI: ${english.join('; ')}.`)

  const result = walk.finish()
  expect(result.clicks).toBeGreaterThan(0)
})
