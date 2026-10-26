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
 *
 * FR-22 slice 2 route: the issued invoice offers „Кредитно известие" (FR-22.21), which opens the
 * note already holding the invoice's customer, the invoice itself and its lines; „Запази и издай"
 * issues it from its form (FR-22.17). It used to be Създай → Кредитно известие, the customer
 * searched, the invoice picked from a list of bare numbers, the reason typed, Save back to the
 * list and the row's „Изпрати": 14 clicks, 11 after slice 1.
 */

/** FR-22 §3: P5-credit ≤ 6 clicks · 1 typed. */
const BUDGET = { clicks: 6, typed: 1 }

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
  const sourceId = String(source._id || source.id)
  const sourceLine = source.lines.find((l: any) => String(l.productId) === products[RETURNED.sku]._id)
  const since = new Date(Date.now() - 1000)

  const walk = await startWalk(page, testInfo, {
    id: 'P5-credit',
    title: 'Credit note — one returned article from an issued invoice, issued',
    start: '/invoicing/invoices',
  })
  // By its number link, exactly: a draft number such as DRF-INV-2026-00002 contains INV-2026-00002.
  const sourceRow = page.locator('tbody tr').filter({ has: page.getByRole('link', { name: source.invoiceNumber, exact: true }) })
  await expect(sourceRow).toBeVisible()
  await walk.shot('sales-list-with-invoice')

  // FR-22.24 (uncounted): the row's ⋮ offers the credit note, Печат and Копирай, and — issued —
  // no Изтрий (FR-22.23). The walk still goes through the invoice: the same 2 clicks.
  const rowMenu = await walk.offTheClock(async () => {
    await sourceRow.getByTestId('row-actions').click()
    const items = page.getByTestId('row-actions-list').filter({ visible: true })
    await expect(items).toBeVisible()
    const texts = (await items.locator('.v-list-item-title').allInnerTexts()).map((x) => x.trim())
    await page.keyboard.press('Escape')
    await expect(items).toHaveCount(0)
    return texts
  })
  walk.note(`The issued invoice's row menu: ${rowMenu.join(' · ')}.`)

  // ── 1. Open the invoice the goods came back from ──
  await walk.click(sourceRow.getByRole('link', { name: source.invoiceNumber }), `open ${source.invoiceNumber} (its number)`)
  await page.waitForURL(new RegExp(`/invoices/${sourceId}/edit`))
  await expect(page.getByRole('heading', { name: 'Редактиране на фактура' })).toBeVisible()

  // ── 2. „Кредитно известие" on the invoice (FR-22.21) ──
  await walk.click(page.getByRole('button', { name: 'Кредитно известие' }).first(), 'credit note from the invoice')
  await page.waitForURL(/\/invoicing\/invoices\/new\?.*type=credit_note/)
  expect(new URL(page.url()).searchParams.get('relatedInvoiceId')).toBe(sourceId)
  await expect(page.getByRole('heading', { name: 'Ново кредитно известие' })).toBeVisible()
  const rows = page.locator('.line-table tbody tr')
  await expect(rows).toHaveCount(source.lines.length)
  await rows.first().evaluate((el) => el.scrollIntoView({ block: 'center' }))
  await walk.shot('note-started-from-invoice')

  // What the note started with (uncounted): the invoice's customer, the invoice itself, and its lines.
  const relatedShown = await page.locator('.v-field').filter({ has: page.getByRole('combobox', { name: /Свързана фактура/ }) }).first().innerText()
  const customerShown = await page.locator('.doc-banner-party').innerText()
  // The unit price is the list price whether or not the discount came along (the discount sits in
  // its own column, hidden by default), so the line's net amount — „Междинна сума", qty × price less
  // the discount — is what tells.
  const copied = rows.filter({ hasText: products[RETURNED.sku].name }).first()
  const copiedPrice = Number((await creditUnitPrice(copied).inputValue()).replace(',', '.'))
  const unitCell = (await copied.locator('td').nth(3).innerText()).trim()
  const headers = await page.locator('.line-table thead th').allInnerTexts()
  const netCol = headers.findIndex((h) => h.trim() === 'Междинна сума')
  const copiedNet = netCol < 0 ? NaN : money(await copied.locator('td').nth(netCol).innerText())
  const discountKept = Math.abs(copiedNet - round2(RETURNED.soldQty * sourceLine.unitPrice * (1 - RETURNED.discount / 100))) < 0.011
  walk.note(`The note opened on ${CUSTOMER}, invoice ${source.invoiceNumber} and its ${source.lines.length} lines: the 10 % discount ${discountKept ? `came along (the line nets ${copiedNet.toFixed(2)} at the list price ${copiedPrice.toFixed(2)})` : 'was DROPPED'}, the unit reads „${unitCell}".`)

  // ── 3. Keep only the returned article, one box ──
  const keptRow = rows.filter({ hasText: products[KEPT.sku].name }).first()
  await walk.click(keptRow.locator('td').last().getByRole('button'), `remove the line not returned (${KEPT.sku})`)
  await expect(rows).toHaveCount(source.lines.length - 1)
  await walk.fill(lineQuantity(rows.first()), '1', 'quantity 1')
  await walk.shot('ready-to-issue')

  // ── 4. „Запази и издай": saved and issued from its own form (FR-22.17) ──
  await walk.click(page.getByRole('button', { name: 'Запази и издай' }).first(), 'save and issue („Запази и издай")')
  // Either wording, so the walk measures the old code too; the guard at the end wants the right one.
  const issuedMessage = page.locator('.v-snackbar').filter({ hasText: /(Фактурата е изпратена|Кредитното известие е издадено) успешно/ })
  await expect(issuedMessage).toBeVisible()
  const issuedMessageText = (await issuedMessage.locator('.v-snackbar__content').innerText()).trim()
  await page.waitForURL(/\/invoicing\/invoices\/[0-9a-f]{24}\/edit/)
  await expect(page.getByRole('heading', { name: 'Редактиране на кредитно известие' })).toBeVisible()
  await walk.shot('credit-note-issued')

  // What was issued (uncounted).
  let issued: any
  await expect.poll(async () => {
    const { invoices } = await api.get(`/invoices?type=credit_note&contactId=${customer._id}&size=10&sortBy=createdAt&sortOrder=desc`)
    issued = (invoices || []).find((i: any) => new Date(i.createdAt) >= since && String(i.relatedInvoiceId) === sourceId)
    return issued?.status
  }, { timeout: 15000 }).toBe('sent')
  const cl = issued.lines?.[0] || {}
  walk.note(`Issued ${issued.invoiceNumber} (draft ${issued.draftNumber}), crediting ${cl.quantity} × ${cl.unitPrice} ${cl.unit} at ${cl.discount || 0} % off, total ${issued.total}; the success message says „${issuedMessageText}".`)

  const result = walk.finish()

  // ── FR-22 §3 budget for P5-credit ──
  expect(result.clicks).toBeLessThanOrEqual(BUDGET.clicks)
  expect(result.typed).toBeLessThanOrEqual(BUDGET.typed)
  expect(result.hops).toBe(0)
  // FR-22.21: the note started as the invoice — its customer and the invoice it corrects.
  expect(relatedShown).toContain(source.invoiceNumber)
  expect(customerShown).toContain(CUSTOMER)
  expect(String(issued.contactId)).toBe(String(customer._id))
  expect(page.url()).toContain(`/invoices/${issued._id}/edit`)
  expect(issued.lines).toHaveLength(1)
  expect(cl.quantity).toBe(1)

  // FR-22.23 / .24: the row menu of an issued invoice.
  expect(rowMenu).toEqual(expect.arrayContaining(['Кредитно известие', 'Дебитно известие', 'Печат', 'Копирай']))
  expect(rowMenu).not.toContain('Изтрий')

  // ── FR-22 slice 1 guards (each failed on the code the budgets were first measured on) ──
  // B-6 / FR-22.4: the copy keeps the invoice's discount and unit, and the note credits the
  // discounted price — not the list price.
  expect(discountKept).toBe(true)
  expect(unitCell).toMatch(/кут/i)
  expect(cl).toMatchObject({ unit: RETURNED.unit, discount: RETURNED.discount, unitPrice: sourceLine.unitPrice })
  const charged = sourceLine.unitPrice * (1 - RETURNED.discount / 100)
  expect(cl.lineTotal).toBeCloseTo(round2(charged * (1 + sourceLine.taxRate / 100)), 2)
  // B-16 / FR-22.14: issuing a credit note says so.
  expect(issuedMessageText).toContain('Кредитното известие е издадено')
})

/** An amount as the bg UI prints it („1 234,56 €") as a number. */
function money(text: string): number {
  return Number(text.replace(/[^\d,.-]/g, '').replace(',', '.'))
}
