import { test, expect } from '@playwright/test'
import { startWalk, uxApi, UxWalk } from '../helpers/ux-budget'
import { lineQuantity } from '../helpers/document-form'
import { listGeometry } from '../helpers/list-geometry'

/**
 * P5 — Invoice. The core daily task: a customer at the counter buys three articles and pays by
 * card. Create the invoice, issue it (its real number), print it, and have it show as paid.
 *
 * Products used: PRD-0021..0023 (this agent's share of the acme-corp seed). Customer: Alpha
 * Manufacturing.
 *
 * FR-22 slice 2 route: the form issues, prints and — for a card sale — settles itself in one
 * action, „Издай и печатай" (FR-22.16–.20). It used to be Save (back to the list), the row's
 * „Изпрати", the row's „Запис на плащане" dialog with the card picked a second time, then the
 * invoice reopened for Печат and its print dialog: 22 clicks and 2 dialogs, 20 after slice 1.
 */

type Api = Awaited<ReturnType<typeof uxApi>>
type Loc = ReturnType<UxWalk['page']['locator']>

const CUSTOMER = 'Alpha Manufacturing'
const LINES = [
  { sku: 'PRD-0021', qty: 2 },
  { sku: 'PRD-0022', qty: 1 },
  { sku: 'PRD-0023', qty: 4 },
]

/** FR-22 §3: P5-invoice ≤ 14 clicks · 6 typed · ≤ 1 dialog, and paid with no extra step. */
const BUDGET = { clicks: 14, typed: 6, dialogs: 1 }

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

  const typeFilterText = (await page.locator('.v-field').filter({ hasText: 'Тип документ' }).first().innerText()).replace('Тип документ', '').trim()
  // The list wrote every status and type into its URL as soon as it opened (B-17). Read the URL
  // once its debounced write has had time to land.
  const listUrl = await walk.offTheClock(async () => {
    await page.waitForTimeout(800)
    return page.url()
  })

  // FR-22.23 (uncounted): the list at 1366 px — no sideways scroll, a row one line tall, its
  // actions one menu button.
  const listFit = await walk.offTheClock(() => listGeometry(page))
  walk.note(`Sales list at 1366 px: ${listFit.hidden} px hidden sideways; tallest row ${listFit.tallest} px (a line is ${listFit.lineHeight} px); ${Math.max(...listFit.actionButtons)} button(s) in a row's actions.`)

  // ── 1. New invoice — the list's Create says what it creates (FR-22.50) ──
  await walk.click(page.getByRole('link', { name: 'Нова фактура' }).first(), 'create („Нова фактура")')
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

  // ── 5. „Издай и печатай": saved, issued, paid and printed in one action ──
  const issueAndPrint = page.getByRole('button', { name: 'Издай и печатай' }).first()
  await expect(issueAndPrint).toBeVisible()
  const downloadPromise = page.waitForEvent('download', { timeout: 60000 })
  await walk.click(issueAndPrint, 'issue and print („Издай и печатай")')
  const download = await downloadPromise
  await expect(page.locator('.v-snackbar').filter({ hasText: 'Експортът е генериран' })).toBeVisible()
  // On the issued invoice: its own edit route, its number, paid.
  await page.waitForURL(/\/invoicing\/invoices\/[0-9a-f]{24}\/edit/)
  await expect(page.getByRole('heading', { name: 'Редактиране на фактура' })).toBeVisible()
  await walk.shot('issued-paid-printed')

  // What was stored (uncounted).
  const draft = await findNewDoc(api, { type: 'invoice', contactId: customer._id, productId: products[LINES[0].sku]._id, since })
  const final = (await api.get(`/invoices/${draft._id}`)).invoice
  expect(download.suggestedFilename()).toBe(`${final.invoiceNumber}.pdf`)
  expect(page.url()).toContain(`/invoices/${draft._id}/edit`)
  await expect(page.locator('.doc-banner-meta .text-h6')).toHaveText(final.invoiceNumber)
  await expect(page.locator('.doc-banner-meta .v-chip')).toContainText('Платена')
  const paidShown = (await page.getByTestId('totals-amount-paid').innerText().catch(() => '')).replace(/\s+/g, ' ')
  const smartButtonTexts = (await page.locator('.smart-buttons-row').allInnerTexts()).join(' ')
  if (await page.locator('.v-snackbar').getByRole('button', { name: /^close$/i }).count()) english.push('every snackbar\'s „CLOSE" button')

  walk.note(`„Издай и печатай" saved the draft (${final.draftNumber}), issued it as ${final.invoiceNumber}, settled it by card (${final.payments?.map((p: any) => `${p.amount} ${p.method}/${p.origin}`).join(', ')}) and printed ${download.suggestedFilename()} — one click, no dialog, still on the invoice.`)
  // FR-22.26 (uncounted): the next invoice this user starts — a new tab — opens on card.
  const nextPm = await walk.offTheClock(async () => {
    const next = await page.context().newPage()
    try {
      await next.goto('/invoicing/invoices/new')
      await expect(next.getByRole('heading', { name: 'Нова фактура' })).toBeVisible()
      const field = next.locator('.v-field').filter({ has: next.getByRole('combobox', { name: 'Метод на плащане' }) }).first()
      await expect(field.locator('.v-select__selection-text')).toHaveCount(1)
      return await selectText(field)
    } finally {
      await next.close()
    }
  })
  walk.note(`The payment method field starts as „${pmDefault || 'празно'}" for a user who never saved an invoice; card is chosen once, and the next invoice opens on „${nextPm}" (FR-22.26).`)
  walk.note(`Place of deal: „${final.placeOfTransaction || ''}" — the warehouse's city, filled in by the form (FR-22.27).`)
  if (english.length) walk.note(`English in the bg UI: ${english.join('; ')}.`)

  const result = walk.finish()

  // ── FR-22 §3 budget for P5-invoice ──
  expect(result.clicks).toBeLessThanOrEqual(BUDGET.clicks)
  expect(result.typed).toBeLessThanOrEqual(BUDGET.typed)
  expect(result.dialogs).toBeLessThanOrEqual(BUDGET.dialogs)
  expect(result.hops).toBe(0)
  // Paid with no extra step (FR-22.19, D-3): a card sale is settled when it is issued.
  expect(final).toMatchObject({ status: 'paid', paymentMethod: 'card', amountDue: 0 })
  expect(final.payments).toEqual([expect.objectContaining({ method: 'card', origin: 'card_on_issue', amount: final.total })])
  expect(final.invoiceNumber).not.toMatch(/^DRF-/)

  // ── FR-22 slice 2b guards (each fails on the code 2a shipped) ──
  // FR-22.23: the list fits the laptop — nothing hidden sideways, one line per row, one menu per row.
  expect(listFit.hidden, 'no sideways scroll at 1366 px').toBeLessThanOrEqual(1)
  expect(listFit.tallest, 'one line per row').toBeLessThan(2 * listFit.lineHeight)
  expect(new Set(listFit.actionButtons), 'one menu button per row').toEqual(new Set([1]))
  // FR-22.26: the payment method is remembered for the next invoice.
  expect(nextPm).toBe('С карта')
  // FR-22.27 (D-7): the deal was made where the goods left from — the default warehouse's city.
  expect(final.placeOfTransaction).toBe('Berlin')

  // ── FR-22 slice 1 guards that still apply on this route ──
  // B-13 / FR-22.12: no English smart buttons; what has been paid shows in the totals card.
  expect(smartButtonTexts).not.toMatch(/Journal Entry|Payments|Deliveries/)
  expect(paidShown).toContain('Платена сума')
  // B-17 / FR-22.15: the type filter names what it filters, and the bare list URL stays bare.
  expect(typeFilterText).toBe('Всички типове')
  expect(listUrl).not.toMatch(/[?&](status|type)=/)
})
