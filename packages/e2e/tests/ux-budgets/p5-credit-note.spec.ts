import { test, expect } from '@playwright/test'
import { startWalk, uxApi, UxWalk } from '../helpers/ux-budget'
import { lineQuantity } from '../helpers/document-form'

/**
 * P5 — Credit note. The customer brings back one article from an invoice issued earlier: issue a
 * credit note for that one piece.
 *
 * Setup (uncounted, API): an issued invoice for Nordic Wholesale with two lines — PRD-0024 ×3
 * sold by the box („кут.") at 10 % off, and PRD-0025 ×2. The customer returns ONE box of
 * PRD-0024. The discount and the unit are there on purpose: they show whether the credit note
 * copies what was actually sold.
 *
 * Products used: PRD-0024, PRD-0025 (this agent's share of the acme-corp seed).
 */

type Api = Awaited<ReturnType<typeof uxApi>>

const CUSTOMER = 'Nordic Wholesale'
const RETURNED = { sku: 'PRD-0024', soldQty: 3, unit: 'box', discount: 10 }
const KEPT = { sku: 'PRD-0025', soldQty: 2 }

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

async function mainWarehouse(api: Api) {
  const { warehouses } = await api.get('/warehouse/warehouse?size=100')
  return (warehouses || []).find((w: any) => w.isDefault) || warehouses?.[0]
}

/** Keep the walk re-runnable: top the default warehouse up when a product runs low. */
async function ensureStock(api: Api, products: Record<string, any>, needs: Record<string, number>) {
  const main = await mainWarehouse(api)
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
    notes: 'ux-budget P5-credit top-up',
  })
  await api.post(`/warehouse/movement/${stockMovement._id || stockMovement.id}/confirm`, {})
}

const round2 = (n: number) => Math.round(n * 100) / 100

/**
 * A credit note edits its price in a plain number field (`priceEditor: 'plain'`), not the invoice's
 * PriceCombobox, so `lineUnitPrice` (the row's last combobox) would land on the unit. The price cell is
 * the 5th: №, description, qty, unit, unit price.
 */
function creditUnitPrice(row: ReturnType<UxWalk['page']['locator']>) {
  return row.locator('td').nth(4).locator('input').last()
}

/** The issued invoice the customer brings back (uncounted setup). */
async function issueSourceInvoice(api: Api, products: Record<string, any>, contactId: string) {
  const main = await mainWarehouse(api)
  const r = products[RETURNED.sku]
  const k = products[KEPT.sku]
  const raw = [
    { p: r, quantity: RETURNED.soldQty, unit: RETURNED.unit, discount: RETURNED.discount },
    { p: k, quantity: KEPT.soldQty, unit: 'pcs', discount: 0 },
  ]
  const lines = raw.map(({ p, quantity, unit, discount }) => {
    const gross = quantity * p.sellingPrice
    const disc = gross * discount / 100
    const tax = (gross - disc) * (p.taxRate ?? 18) / 100
    return {
      productId: p._id,
      description: p.name,
      quantity,
      unit,
      unitPrice: p.sellingPrice,
      discount,
      taxRate: p.taxRate ?? 18,
      taxAmount: round2(tax),
      lineTotal: round2(gross - disc + tax),
      warehouseId: main._id,
    }
  })
  const subtotal = round2(raw.reduce((s, x) => s + x.quantity * x.p.sellingPrice, 0))
  const discountTotal = round2(raw.reduce((s, x) => s + x.quantity * x.p.sellingPrice * x.discount / 100, 0))
  const taxTotal = round2(lines.reduce((s, l) => s + l.taxAmount, 0))
  const today = new Date().toISOString().split('T')[0]
  const { invoice } = await api.post('/invoices', {
    type: 'invoice',
    direction: 'outgoing',
    contactId,
    issueDate: today,
    dueDate: today,
    currency: 'EUR',
    exchangeRate: 1,
    paymentMethod: 'cash',
    lines,
    subtotal,
    discountTotal,
    taxTotal,
    total: round2(subtotal - discountTotal + taxTotal),
  })
  expect(invoice?._id || invoice?.id, 'setup invoice created').toBeTruthy()
  const id = invoice._id || invoice.id
  const sent = await api.post(`/invoices/${id}/send`, {})
  // A cash invoice is settled on issue (`syncCashSettlement`), so it comes back `paid`.
  expect(['sent', 'paid'], `setup invoice issued: ${JSON.stringify(sent).slice(0, 200)}`).toContain(sent?.invoice?.status)
  return sent.invoice
}

test('P5 credit note: one returned article from an issued invoice', async ({ page }, testInfo) => {
  const api = await uxApi()
  const products = await productsBySku(api, [RETURNED.sku, KEPT.sku])
  await ensureStock(api, products, { [RETURNED.sku]: RETURNED.soldQty, [KEPT.sku]: KEPT.soldQty })
  const { contacts } = await api.get(`/invoicing/contact?search=${encodeURIComponent(CUSTOMER)}&size=5`)
  const customer = (contacts || []).find((c: any) => c.companyName === CUSTOMER)
  expect(customer, CUSTOMER).toBeTruthy()
  const source = await issueSourceInvoice(api, products, customer._id)
  const sourceLine = source.lines.find((l: any) => String(l.productId) === products[RETURNED.sku]._id)
  const netUnit = round2(sourceLine.unitPrice * (1 - RETURNED.discount / 100))
  const since = new Date(Date.now() - 1000)

  const walk = await startWalk(page, testInfo, {
    id: 'P5-credit',
    title: 'Credit note — one returned article from an issued invoice, issued',
    start: '/invoicing/invoices',
  })
  const sourceRow = page.locator('tbody tr').filter({ hasText: source.invoiceNumber })
  await expect(sourceRow).toBeVisible()
  await walk.shot('sales-list-with-invoice')

  // Can the user start from the invoice? Look, without counting: the row's actions, and the
  // opened invoice in a second tab.
  const rowActions = await sourceRow.locator('button, a').evaluateAll((els) =>
    els.map((e) => e.getAttribute('aria-label') || e.getAttribute('title') || (e as HTMLElement).innerText.trim()).filter(Boolean))
  const formButtons = await walk.offTheClock(async () => {
    const probe = await page.context().newPage()
    await probe.goto(`/invoicing/invoices/${source._id || source.id}/edit`, { waitUntil: 'networkidle' })
    await expect(probe.getByRole('heading', { name: 'Редактиране на фактура' })).toBeVisible()
    const names = await probe.getByRole('button').evaluateAll((els) =>
      els.map((e) => ((e as HTMLElement).innerText || e.getAttribute('aria-label') || '').trim()).filter(Boolean))
    await probe.close()
    return names
  })
  const creditFromInvoice = [...rowActions, ...formButtons].filter((t) => /кредит|сторн|върн/i.test(t))
  if (!creditFromInvoice.length) {
    walk.note(`No way to start from the invoice: its list row offers only [${rowActions.join(', ')}] and the opened invoice has no credit-note action. The user starts a new document (Създай → Кредитно известие) and finds the invoice again in „Свързана фактура".`)
  }

  // ── 1. New credit note ──
  await walk.click(page.getByRole('link', { name: /Създай/ }).first(), 'create (list)')
  await page.waitForURL(/\/invoicing\/invoices\/new/)
  await walk.click(page.getByRole('button', { name: 'Кредитно известие' }), 'type: Кредитно известие')
  await expect(page.getByRole('heading', { name: 'Ново кредитно известие' })).toBeVisible()

  // ── 2. Customer ──
  await walk.type(page.getByRole('combobox', { name: /Клиент/ }), 'Nordic', 'search the customer')
  const clientOption = page.locator('.v-overlay--active .v-list-item').filter({ hasText: CUSTOMER }).first()
  await expect(clientOption).toBeVisible()
  await walk.click(clientOption, 'pick the customer')

  // ── 3. The invoice being credited ──
  // Narrowed to this customer's issued invoices once the customer is chosen; the newest first.
  const relInput = page.getByRole('combobox', { name: /Свързана фактура/ })
  await relInput.scrollIntoViewIfNeeded()
  await walk.click(relInput.locator('xpath=ancestor::div[contains(@class,"v-field")][1]'), 'related invoice: open the list')
  const relOptions = page.locator('.v-overlay--active .v-list-item')
  await expect(relOptions.filter({ hasText: source.invoiceNumber }).first()).toBeVisible()
  const relTexts = (await relOptions.allInnerTexts()).map((t) => t.trim()).filter(Boolean)
  if (relTexts.every((t) => /^[A-ZА-Я-]+-\d{4}-\d+$/.test(t))) {
    walk.note(`„Свързана фактура" lists the customer's invoices as bare numbers (${relTexts.slice(0, 3).join(', ')}, …) — no date or amount to recognise the one being returned by.`)
  }
  await walk.click(relOptions.filter({ hasText: source.invoiceNumber }).first(), `related invoice: pick ${source.invoiceNumber}`)
  const rows = page.locator('.line-table tbody tr')
  await expect(rows).toHaveCount(source.lines.length)
  await expect(page.locator('.v-overlay--active .v-list-item')).toHaveCount(0)
  await rows.first().evaluate((el) => el.scrollIntoView({ block: 'center' }))
  await walk.shot('lines-copied')

  // What the copy kept (uncounted). The unit price is the list price whether or not the discount
  // came along (the discount sits in its own column, hidden by default), so the line's net amount
  // — „Междинна сума", qty × price less the discount — is what tells.
  const copied = rows.filter({ hasText: products[RETURNED.sku].name }).first()
  const copiedPrice = Number((await creditUnitPrice(copied).inputValue()).replace(',', '.'))
  const unitCell = (await copied.locator('td').nth(3).innerText()).trim()
  const headers = await page.locator('.line-table thead th').allInnerTexts()
  const netCol = headers.findIndex((h) => h.trim() === 'Междинна сума')
  const copiedNet = netCol < 0 ? NaN : money(await copied.locator('td').nth(netCol).innerText())
  const discountKept = Math.abs(copiedNet - round2(RETURNED.soldQty * sourceLine.unitPrice * (1 - RETURNED.discount / 100))) < 0.011
  const copyNotes: string[] = []
  copyNotes.push(`all ${source.lines.length} invoice lines are copied (the user deletes the ones not returned)`)
  copyNotes.push(discountKept
    ? `the 10 % discount comes along (the line nets ${copiedNet.toFixed(2)} at the list price ${copiedPrice.toFixed(2)})`
    : `the 10 % discount is dropped — the line comes in at the list price ${copiedPrice.toFixed(2)}, so it would credit ${copiedPrice.toFixed(2)} instead of the ${netUnit.toFixed(2)} charged`)
  copyNotes.push(/кут/i.test(unitCell) ? 'the unit „кут." comes along' : `the unit is lost — „кут." (box) came in as „${unitCell || 'empty'}"`)
  walk.note(`Related-invoice copy: ${copyNotes.join('; ')}.`)

  // ── 4. Keep only the returned article, one box ──
  const keptRow = rows.filter({ hasText: products[KEPT.sku].name }).first()
  const removeBtn = keptRow.locator('td').last().getByRole('button')
  const removeLabel = (await removeBtn.getAttribute('aria-label')) || ''
  if (removeLabel === 'common.remove') walk.note('The line delete button\'s tooltip / accessible name is the raw key „common.remove" (missing translation).')
  await walk.click(removeBtn, `remove the line not returned (${KEPT.sku})`)
  await expect(rows).toHaveCount(source.lines.length - 1)
  const line = rows.first()
  await walk.fill(lineQuantity(line), '1', 'quantity 1')

  // The price the customer actually paid — typed only when the discount did not come along.
  if (!discountKept) {
    await walk.fill(creditUnitPrice(line), String(netUnit), `unit price ${netUnit} (list price less the 10 % the invoice gave)`)
  }
  // The unit the article was sold in.
  if (!/кут/i.test(unitCell)) {
    const unitInput = line.locator('td').nth(3).locator('input[role="combobox"]')
    await walk.type(unitInput, 'кут', 'unit: search „кут"')
    const unitOption = page.locator('.v-overlay--active .v-list-item').filter({ hasText: /кут/i }).first()
    await expect(unitOption).toBeVisible()
    await walk.click(unitOption, 'unit: pick „кут."')
  }

  // ── 5. Reason ──
  // Not required by the form, but a credit note states why it was issued.
  await walk.fill(page.getByLabel('Причина'), `Върната 1 кут. ${products[RETURNED.sku].name} по фактура ${source.invoiceNumber}`, 'reason')
  await walk.shot('ready-to-save')

  // ── 6. Save — back to the list ──
  await walk.click(page.getByRole('button', { name: 'Запази' }).first(), 'save')
  await page.waitForURL(/\/invoicing\/invoices(\?|$)/)
  await expect(page.locator('.v-snackbar').filter({ hasText: 'Успешно запазено' })).toBeVisible()

  let draft: any
  await expect.poll(async () => {
    const { invoices } = await api.get(`/invoices?type=credit_note&contactId=${customer._id}&size=10&sortBy=createdAt&sortOrder=desc`)
    draft = (invoices || []).find((i: any) => new Date(i.createdAt) >= since && String(i.relatedInvoiceId) === String(source._id || source.id))
    return !!draft
  }, { timeout: 15000 }).toBe(true)
  const draftRow = page.locator('tbody tr').filter({ hasText: draft.invoiceNumber })
  await expect(draftRow).toBeVisible()
  await walk.shot('draft-in-list')

  // ── 7. Issue (row action) ──
  await walk.scrollTableToEnd('the row actions')
  await walk.click(draftRow.getByRole('button', { name: 'Изпрати', exact: true }), 'issue (row „Изпрати")')
  await expect(page.locator('.v-snackbar').filter({ hasText: 'Фактурата е изпратена успешно' })).toBeVisible()
  let issued: any
  await expect.poll(async () => {
    issued = (await api.get(`/invoices/${draft._id}`)).invoice
    return issued?.status
  }, { timeout: 15000 }).toBe('sent')
  await expect(page.locator('tbody tr').filter({ hasText: issued.invoiceNumber })).toBeVisible()
  await walk.shot('credit-note-issued')

  // What was issued (uncounted).
  const cl = issued.lines?.[0] || {}
  walk.note(`Issued ${issued.invoiceNumber} (draft ${draft.invoiceNumber}), crediting ${cl.quantity} × ${cl.unitPrice} ${cl.unit}, total ${issued.total}; the success message says „Фактурата е изпратена успешно" (invoice sent) for a credit note.`)
  expect(issued.lines).toHaveLength(1)
  expect(cl.quantity).toBe(1)

  const result = walk.finish()
  expect(result.clicks).toBeGreaterThan(0)

  // ── FR-22 slice 1 guards (each failed on the code the budgets were first measured on) ──
  // B-6 / FR-22.4: the copy keeps the invoice's discount and unit, and the note credits the
  // discounted price — not the list price.
  expect(discountKept).toBe(true)
  expect(unitCell).toMatch(/кут/i)
  expect(cl).toMatchObject({ unit: RETURNED.unit, discount: RETURNED.discount, unitPrice: sourceLine.unitPrice })
  const charged = sourceLine.unitPrice * (1 - RETURNED.discount / 100)
  expect(cl.lineTotal).toBeCloseTo(round2(charged * (1 + sourceLine.taxRate / 100)), 2)
})

/** An amount as the bg UI prints it („1 234,56 €") as a number. */
function money(text: string): number {
  return Number(text.replace(/[^\d,.-]/g, '').replace(',', '.'))
}
