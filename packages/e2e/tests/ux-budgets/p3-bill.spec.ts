import { test, expect } from '@playwright/test'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { startWalk, signInForUx, uxApi } from '../helpers/ux-budget'

/**
 * P3 — The supplier's invoice for goods already received arrives days later. Enter it as the
 * supplier's bill (PRD-0013 ×10 and PRD-0014 ×5, received on a receipt), with the supplier's
 * invoice number, and receive it.
 *
 * The route since FR-22 slice 3 (FR-22.31, .33, #168) starts on the receipt: „Входяща фактура"
 * makes the bill from it — supplier, warehouse, lines, quantities and unit costs, linked to the
 * receipt — and opens it in invoicing (one page load). The user types the supplier's number and
 * presses „Запази и получи".
 *
 * The B-4 guard: until slice 3 the bill was typed in again and receiving it booked the goods a
 * second time (10 received units raised the stock by 20). Linked to the receipt, it moves no
 * stock; the walk asserts the exact stock before and after, and the links both ways.
 *
 * Setup (uncounted, so the walk does not depend on P2): a completed receipt movement for the
 * goods from the supplier, made through the API.
 *
 * Products used: PRD-0013, PRD-0014.
 */

const SUPPLIER = 'Global Logistics'
const WAREHOUSE = 'Main Warehouse'

/** FR-22 §3: P3 ≤ 4 clicks · 1 typed · ≤ 1 page load · stock unchanged. */
const BUDGET = { clicks: 4, typed: 1, hops: 1 }

type Api = Awaited<ReturnType<typeof uxApi>>

async function product(api: Api, sku: string) {
  const { products } = await api.get(`/warehouse/product?search=${encodeURIComponent(sku)}&size=5`)
  return (products || []).find((p: any) => p.sku === sku)
}

async function stock(api: Api, productId: string, whId: string): Promise<number> {
  const { stockLevels } = await api.get(`/warehouse/stock-level?productId=${productId}&warehouseId=${whId}&size=5`)
  return stockLevels?.[0]?.quantity ?? 0
}

/**
 * Uncounted, in its own context: the slice 1 guards this walk used to carry on its old route, and
 * the bill line's „+ Нов продукт". The bills list's type filter says „Всички типове" (B-17); a new
 * bill's line starts at the article's PURCHASE price (B-10); a bill line offers to create an
 * article its search does not find (FR-22.30); and a new bill's payment method starts empty
 * (FR-22.33).
 */
async function probeBillForm(browser: any, baseURL: string, purchase: number, stamp: string) {
  const ctx = await browser.newContext({ baseURL, viewport: { width: 1366, height: 768 } })
  const p = await ctx.newPage()
  try {
    await signInForUx(p)
    await p.goto('/invoicing/bills', { waitUntil: 'networkidle' })
    const typeFilter = (await p.getByRole('combobox', { name: 'Тип документ' }).locator('xpath=ancestor::div[contains(@class,"v-field")][1]').innerText().catch(() => '')).replace(/\s+/g, ' ')
    await p.goto('/invoicing/bills/new', { waitUntil: 'networkidle' })
    const payment = (await p.getByRole('combobox', { name: /Метод на плащане/ }).inputValue().catch(() => '')).trim()
    const payShown = (await p.getByRole('combobox', { name: /Метод на плащане/ }).locator('xpath=ancestor::div[contains(@class,"v-field")][1]').innerText()).replace(/\s+/g, ' ').trim()
    const table = p.locator('table.line-table, .line-table table').first()
    const search = table.locator('tbody tr').first().getByPlaceholder('Търсете продукти...')
    await search.click()
    await search.pressSequentially('PRD-0013', { delay: 20 })
    const item = p.locator('.pld-overlay .pld-item').filter({ hasText: 'PRD-0013' }).filter({ hasNotText: 'Нов продукт' }).first()
    await expect(item).toBeVisible()
    await item.click()
    const heads: string[] = await table.locator('thead th').allInnerTexts()
    const priceCol = heads.findIndex(h => h.trim() === 'Единична цена')
    const price = table.locator('tbody tr').first().locator('td').nth(priceCol).locator('input').first()
    await expect.poll(async () => Number(await price.inputValue()), { timeout: 5000 }).toBeGreaterThan(0)
    const prefilled = Number(await price.inputValue())
    const second = table.locator('tbody tr').nth(1).getByPlaceholder('Търсете продукти...')
    await second.click()
    await second.pressSequentially(`UX P3 probe ${stamp}`, { delay: 20 })
    const create = p.getByTestId('product-line-create')
    await expect(create).toBeVisible()
    const createText = (await create.innerText()).trim()
    return { typeFilter, payment, payShown, prefilled, purchase, createText }
  } finally {
    await ctx.close()
  }
}

test('P3 bill: the supplier invoice for goods already received', async ({ page, browser }, testInfo) => {
  const api = await uxApi()
  const stamp = new Date().toISOString().replace(/\D/g, '').slice(2, 14)
  const supplierNo = `GL-${stamp}`
  const wh = (await api.get('/warehouse/warehouse?size=100')).warehouses.find((w: any) => w.name === WAREHOUSE)
  const p13 = await product(api, 'PRD-0013')
  const p14 = await product(api, 'PRD-0014')
  const { contacts } = await api.get(`/invoicing/contact?search=${encodeURIComponent(SUPPLIER)}&type=supplier&size=5`)
  const supplier = (contacts || []).find((c: any) => c.companyName === SUPPLIER)

  // ── Setup (uncounted): the goods came first, on a receipt movement ──
  const stockBeforeSetup = await stock(api, p13._id, wh._id)
  const lines = [
    { productId: p13._id, quantity: 10, unitCost: p13.purchasePrice, totalCost: 10 * p13.purchasePrice },
    { productId: p14._id, quantity: 5, unitCost: p14.purchasePrice, totalCost: 5 * p14.purchasePrice },
  ]
  const created = await api.post('/warehouse/movement', {
    type: 'receipt',
    date: new Date().toISOString().split('T')[0],
    toWarehouseId: wh._id,
    contactId: supplier._id,
    lines,
    totalAmount: lines.reduce((s, l) => s + l.totalCost, 0),
    notes: `UX P3 setup — goods received before supplier invoice ${supplierNo}`,
  })
  const receiptId = created.stockMovement._id || created.stockMovement.id
  const receiptNo = created.stockMovement.movementNumber
  const confirmed = await api.post(`/warehouse/movement/${receiptId}/confirm`)
  expect(confirmed.stockMovement?.status ?? confirmed.status).toBe('completed')
  const s0 = { p13: await stock(api, p13._id, wh._id), p14: await stock(api, p14._id, wh._id) }
  expect(s0.p13 - stockBeforeSetup).toBe(10)
  const movementsBefore = (await api.get('/warehouse/movement?size=1')).total
  const probe = await probeBillForm(browser, testInfo.project.use.baseURL as string, p13.purchasePrice, stamp)

  const walk = await startWalk(page, testInfo, {
    id: 'P3',
    title: 'Supplier invoice for goods already received — from the receipt, received without booking the goods again',
    start: `/inventory/movements/${receiptId}`,
  })
  walk.note(`Setup (API, uncounted): receipt ${receiptNo} from ${SUPPLIER} into ${WAREHOUSE}, completed — PRD-0013 ${stockBeforeSetup} → ${s0.p13}, PRD-0014 now ${s0.p14}. The walk starts on it.`)
  await expect(page.locator('.form-header-bar')).toContainText(receiptNo)
  await walk.shot('receipt')

  // ── „Входяща фактура": the bill, made from the receipt, opens in invoicing ──
  await walk.click(page.locator('.form-actions-bar').getByRole('button', { name: 'Входяща фактура' }), '„Входяща фактура" on the receipt')
  await page.waitForURL(/\/invoicing\/bills\/[0-9a-f]{24}\/edit/)
  const billId = page.url().match(/\/bills\/([0-9a-f]{24})\/edit/)![1]
  const banner = page.getByTestId('bill-receipts')
  await expect(banner).toContainText(receiptNo)
  await expect(page.getByLabel('Покупна фактура №')).toBeVisible()
  await walk.shot('bill-from-receipt')

  await walk.fill(page.getByLabel('Покупна фактура №'), supplierNo, 'supplier invoice number')
  await walk.click(page.locator('.form-actions-bar').getByRole('button', { name: 'Запази и получи' }), '„Запази и получи"')
  await expect(page.locator('.v-snackbar .v-snackbar__content')).toContainText('стоката е заприходена с разписката')
  // The bill's CURRENT status (the pipeline in the action bar shows every step, received or not).
  await expect(page.locator('.doc-banner-meta .v-chip')).toHaveText('Получена')
  await expect(page.locator('.form-header-bar')).toContainText(/BILL-\d{4}-\d+/)
  await walk.shot('bill-received')

  const result = walk.finish()

  // ── Uncounted checks ──
  const s1 = { p13: await stock(api, p13._id, wh._id), p14: await stock(api, p14._id, wh._id) }
  const bill = (await api.get(`/invoices/${billId}`)).invoice
  const movementsAfter = (await api.get('/warehouse/movement?size=1')).total
  const receiptHref = await banner.getByTestId('bill-receipt-link').getAttribute('href')
  // The receipt names its bill, as a link into invoicing; the receipts list marks it billed.
  await page.goto(`/inventory/movements/${receiptId}`, { waitUntil: 'networkidle' })
  const backLink = page.getByTestId('receipt-bill-link')
  await expect(backLink).toHaveText(bill.invoiceNumber)
  const billHref = await backLink.getAttribute('href')
  const billingActions = (await page.locator('.form-actions-bar').getByRole('button').allInnerTexts()).map(s => s.trim())
  await page.goto('/inventory/movements?type=receipt', { waitUntil: 'networkidle' })
  const listRow = page.locator('tbody tr').filter({ hasText: receiptNo })
  await expect(listRow.getByTestId('movement-billed')).toBeVisible()

  const extra: string[] = [
    `Stock (API): PRD-0013 ${stockBeforeSetup} before the goods → ${s0.p13} after receipt ${receiptNo} → ${s1.p13} after „Запази и получи"; PRD-0014 ${s0.p14} → ${s1.p14}. Movements: ${movementsBefore} → ${movementsAfter}.`,
    `Bill ${bill.invoiceNumber} (${bill.status}), supplier invoice ${bill.reference}: ${bill.lines.map((l: any) => `${l.description} ×${l.quantity} @ ${l.unitPrice}`).join(', ')}; stockSource ${bill.stockSource?.marker} (${bill.stockSource?.detectedBy}).`,
    `Links: the bill's banner → ${receiptHref}; the receipt's → ${billHref}; the receipt now offers ${billingActions.length ? billingActions.join(', ') : 'no action'}, and its list row reads „Фактурирана".`,
    `Probe (own context): bills list type filter „${probe.typeFilter.trim()}"; a new bill's „Метод на плащане" reads „${probe.payShown}"; a bill line prefills ${probe.prefilled} for PRD-0013 (purchase ${probe.purchase}); an unknown article offers „${probe.createText}".`,
  ]
  result.notes.push(...extra)
  writeFileSync(join(testInfo.project.outputDir, 'ux-budgets', 'P3', 'result.json'), JSON.stringify(result, null, 2))
  console.log(extra.join('\n'))

  // FR-22 §3 budget.
  expect(result.clicks, 'P3 clicks').toBeLessThanOrEqual(BUDGET.clicks)
  expect(result.typed, 'P3 typed').toBeLessThanOrEqual(BUDGET.typed)
  expect(result.hops, 'P3 page loads').toBeLessThanOrEqual(BUDGET.hops)
  // B-4: the bill moved no stock — exactly what the receipt booked, and no movement added.
  expect(s1).toEqual(s0)
  expect(movementsAfter).toBe(movementsBefore)
  expect(bill.status).toBe('received')
  expect(bill.invoiceNumber).toMatch(/^BILL-/)
  expect(bill.reference).toBe(supplierNo)
  expect(bill.stockSource).toMatchObject({ marker: `movement:${receiptId}`, detectedBy: 'manual' })
  expect(bill.lines.map((l: any) => [l.productId, l.quantity, l.unitPrice])).toEqual([
    [p13._id, 10, p13.purchasePrice],
    [p14._id, 5, p14.purchasePrice],
  ])
  // The links, both ways.
  expect(receiptHref).toBe(`/inventory/movements/${receiptId}`)
  expect(billHref).toBe(`/invoicing/bills/${billId}/edit`)
  expect(billingActions, 'a billed receipt offers no second bill').not.toContain('Входяща фактура')
  // Slice 1 guards (B-17, B-10), the bill line's new article (FR-22.30), the empty payment method (FR-22.33).
  expect(probe.typeFilter).toContain('Всички типове')
  expect(probe.prefilled).toBeCloseTo(probe.purchase, 4)
  expect(probe.createText).toBe(`+ Нов продукт „UX P3 probe ${stamp}“`)
  expect(probe.payment).toBe('')
})
