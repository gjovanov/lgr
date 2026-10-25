import { test, expect } from '@playwright/test'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { startWalk, signInForUx, uxApi } from '../helpers/ux-budget'

/**
 * P3 — The supplier's invoice for goods already received arrives days later. Enter it as an
 * incoming invoice (bill): same supplier, PRD-0013 ×10 and PRD-0014 ×5, the supplier's invoice
 * number, and take it as far as a user does to book it („Получи").
 *
 * The point: nothing lets the user say "these goods were already received on movement X", so
 * receiving the bill books the stock a second time. Measured with the API before and after.
 *
 * Setup (uncounted, so the walk does not depend on P2): a completed receipt movement for the same
 * goods from the same supplier, made through the API.
 *
 * Products used: PRD-0013, PRD-0014.
 */

const SUPPLIER = 'Global Logistics'
const WAREHOUSE = 'Main Warehouse'

type Api = Awaited<ReturnType<typeof uxApi>>

async function product(api: Api, sku: string) {
  const { products } = await api.get(`/warehouse/product?search=${encodeURIComponent(sku)}&size=5`)
  return (products || []).find((p: any) => p.sku === sku)
}

async function stock(api: Api, productId: string, whId: string): Promise<number> {
  const { stockLevels } = await api.get(`/warehouse/stock-level?productId=${productId}&warehouseId=${whId}&size=5`)
  return stockLevels?.[0]?.quantity ?? 0
}

/** The bill's line table, and a cell input by its header text. */
function lineTable(page: any) {
  return page.locator('table.line-table, .line-table table').first()
}
async function colIndex(page: any, header: string): Promise<number> {
  const heads: string[] = await lineTable(page).locator('thead th').allInnerTexts()
  const i = heads.findIndex(h => h.trim() === header)
  if (i < 0) throw new Error(`no column "${header}" in: ${heads.join(' | ')}`)
  return i
}
function cellInput(page: any, row: number, col: number) {
  return lineTable(page).locator('tbody tr').nth(row).locator('td').nth(col).locator('input').first()
}

/** Uncounted, in its own context: does the received movement offer any way on to a bill (#168)? */
async function probeMovement(browser: any, baseURL: string, movementId: string, movementNumber: string): Promise<string> {
  const ctx = await browser.newContext({ baseURL, viewport: { width: 1366, height: 768 } })
  const p = await ctx.newPage()
  try {
    await signInForUx(p)
    await p.goto(`/inventory/movements/${movementId}`, { waitUntil: 'networkidle' })
    await expect(p.getByRole('heading', { level: 1 })).toBeVisible()
    const actions = (await p.locator('.form-actions-bar').getByRole('button').allInnerTexts()).map(s => s.trim()).filter(Boolean)
    const text = await p.locator('.entity-form-shell').innerText()
    const billPath = /фактур|сметк|покупк/i.test(actions.join(' ')) || /(създай|към) (покупна )?фактур/i.test(text)
    await p.goto('/inventory/movements', { waitUntil: 'networkidle' })
    const row = p.locator('tbody tr').filter({ hasText: movementNumber })
    await expect(row).toBeVisible()
    const rowActions = await row.locator('td').last().locator('a, button').count()
    return billPath
      ? `Movement ${movementNumber}: some bill action exists (${actions.join(', ')}).`
      : `No path from the receipt to a bill (#168): the completed movement ${movementNumber} shows ${actions.length ? `only ${actions.join(', ')}` : 'no action at all'} (Save, Import and Потвърди exist only on drafts), and its list row has ${rowActions} action (the eye that opens it). Nothing turns a stock movement into an incoming invoice, and the bill cannot point back at it.`
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
  const movementNote = await probeMovement(browser, testInfo.project.use.baseURL as string, receiptId, receiptNo)

  const walk = await startWalk(page, testInfo, {
    id: 'P3',
    title: 'Supplier invoice for goods already received — enter the bill and receive it',
    start: '/invoicing/bills',
  })
  walk.note(`Setup (API, uncounted): receipt ${receiptNo} from ${SUPPLIER} into ${WAREHOUSE}, completed — PRD-0013 ${stockBeforeSetup} → ${s0.p13}, PRD-0014 now ${s0.p14}.`)
  walk.note(movementNote)
  await walk.shot('bills-list')
  const typeFilter = (await page.getByRole('combobox', { name: 'Тип документ' }).locator('xpath=ancestor::div[contains(@class,"v-field")][1]').innerText().catch(() => '')).replace(/\s+/g, ' ')
  if (/Всички статуси/.test(typeFilter)) walk.note('Bills list: the „Тип документ" filter reads „Всички статуси" (the status wording, reused).')

  const isSupplierList = (r: any) => /\/invoicing\/contact\?/.test(r.url()) && /type=supplier/.test(r.url()) && r.request().method() === 'GET'
  const suppliersRes = page.waitForResponse(isSupplierList)
  await walk.click(page.getByRole('link', { name: 'Създай' }).first(), 'new bill')
  await page.waitForURL(/\/bills\/new/)
  const offered = ((await (await suppliersRes).json()).contacts || []).map((c: any) => c.companyName)
  const allSuppliers = ((await api.get('/invoicing/contact?type=supplier&size=200')).contacts || []).map((c: any) => c.companyName)
  walk.note(`Доставчик field: server-searched (type=supplier, size=20) — offers ${offered.length} of the ${allSuppliers.length} supplier-capable contacts${offered.includes(SUPPLIER) ? `, ${SUPPLIER} among them` : `; ${SUPPLIER} NOT among them`}.`)
  await expect(page.getByRole('heading', { name: 'Нова покупна фактура' }).first()).toBeVisible()

  // Defaults the user does not have to touch: document type Фактура, dates, currency, the warehouse.
  const whShown = await page.getByRole('combobox', { name: /^Склад/ }).inputValue().catch(() => '')
  const whField = (await page.getByRole('combobox', { name: /^Склад/ }).locator('xpath=ancestor::div[contains(@class,"v-field")][1]').innerText()).trim()
  if (/Main Warehouse/.test(whField + whShown)) walk.note('Bill form preselects the org default warehouse (Main Warehouse) — the receipt form does not.')
  const payShown = (await page.getByRole('combobox', { name: /Метод на плащане/ }).locator('xpath=ancestor::div[contains(@class,"v-field")][1]').innerText()).replace(/\s+/g, ' ').trim()
  if (/В брой/.test(payShown)) walk.note('Метод на плащане starts as „В брой" on a supplier bill: the bill config asks for an empty default, but the form falls back to cash.')
  await walk.shot('bill-form')

  await walk.choose(page, /^Доставчик/, SUPPLIER, `Доставчик: ${SUPPLIER}`)
  await walk.fill(page.getByLabel('Покупна фактура №'), supplierNo, 'supplier invoice number')

  const qtyCol = await colIndex(page, 'Кол.')
  const priceCol = await colIndex(page, 'Единична цена')
  const want: Array<{ sku: string; qty: number; price: number; selling: number }> = [
    { sku: 'PRD-0013', qty: 10, price: p13.purchasePrice, selling: p13.sellingPrice },
    { sku: 'PRD-0014', qty: 5, price: p14.purchasePrice, selling: p14.sellingPrice },
  ]
  const prefills: Array<{ sku: string; prefilled: number; purchase: number }> = []
  for (let i = 0; i < want.length; i++) {
    const w = want[i]
    const search = lineTable(page).locator('tbody tr').nth(i).getByPlaceholder('Търсете продукти...')
    await walk.type(search, w.sku, `line ${i + 1}: search ${w.sku}`)
    const item = page.locator('.pld-overlay .pld-item').filter({ hasText: w.sku }).first()
    await expect(item).toBeVisible()
    await walk.click(item, `line ${i + 1}: pick ${w.sku}`)
    if (i === 0) {
      await expect(lineTable(page).locator('tbody tr')).toHaveCount(2)
      walk.note('Picking an article on the last line adds the next line by itself (the receipt form does not).')
    }
    // The line resolves a price after the pick; wait for it to settle before reading it.
    const price = cellInput(page, i, priceCol)
    await expect.poll(async () => Number(await price.inputValue()), { timeout: 5000 }).toBeGreaterThan(0)
    await page.waitForTimeout(400)
    const prefilled = Number(await price.inputValue())
    prefills.push({ sku: w.sku, prefilled, purchase: w.price })
    await walk.fill(cellInput(page, i, qtyCol), String(w.qty), `line ${i + 1}: quantity ${w.qty}`)
    if (Math.abs(prefilled - w.price) > 0.001) {
      walk.note(`Line ${i + 1} (${w.sku}): the bill pre-fills ${prefilled} as the unit price — ${Math.abs(prefilled - w.selling) < 0.001 ? 'the SELLING price' : 'not the purchase price'} (purchase ${w.price}, selling ${w.selling}). The line resolves the sales price chain (/pricing/resolve) even on a purchase document, so the supplier's price has to be typed over it.`)
      await walk.fill(price, String(w.price), `line ${i + 1}: unit price ${w.price} (supplier's price)`)
    }
  }
  await walk.shot('bill-filled')

  // Anything on the form that could point at the receipt it pays for?
  const labels = (await page.locator('.entity-form-shell .v-label, .entity-form-shell th').allInnerTexts())
    .map(s => s.replace(/\s+/g, ' ').trim()).filter(s => s && !/^№$/.test(s))
  const uniq = labels.filter((l, i) => labels.findIndex(x => x.toLowerCase() === l.toLowerCase()) === i)
  const linkField = uniq.find(l => /движени|разписк|заприход|получен/i.test(l))
  walk.note(linkField
    ? `Bill form shows a field that could reference the receipt: "${linkField}".`
    : `Bill form has no field, picker or link for the earlier receipt movement (${receiptNo}). Its fields: ${uniq.join(', ')}.`)

  const saveRes = page.waitForResponse((r: any) => /\/invoices$/.test(r.url()) && r.request().method() === 'POST')
  await walk.click(page.getByRole('button', { name: 'Запази' }).first(), 'save the bill')
  const saved = await saveRes
  expect(saved.status(), `bill save: ${await saved.text()}`).toBeLessThan(400)
  const bill = (await saved.json()).invoice
  await page.waitForURL(/\/invoicing\/bills(\?.*)?$/)
  walk.note('Save returns to the bills list; the bill form itself has no „Получи" — receiving is an icon on the list row (draft rows only), with no confirmation.')
  const row = page.locator('tbody tr').filter({ hasText: supplierNo })
  await expect(row).toBeVisible()
  await walk.shot('bill-saved-in-list')
  const s1 = { p13: await stock(api, p13._id, wh._id), p14: await stock(api, p14._id, wh._id) }

  await walk.click(row.getByRole('button', { name: 'Получи' }), 'receive the bill (Получи)')
  await expect(page.locator('.v-snackbar .v-snackbar__content')).toContainText('Фактурата е получена')
  await expect(row).toContainText('Получена')
  await walk.shot('bill-received')

  const result = walk.finish()

  // ── Uncounted checks ──
  const s2 = { p13: await stock(api, p13._id, wh._id), p14: await stock(api, p14._id, wh._id) }
  const extra: string[] = []
  extra.push(`Stock (API): PRD-0013 ${stockBeforeSetup} before the goods → ${s0.p13} after receipt ${receiptNo} → ${s1.p13} after saving the draft bill → ${s2.p13} after „Получи"; PRD-0014 ${s0.p14} → ${s2.p14}.`)
  if (s2.p13 - s0.p13 === 10) extra.push(`STOCK BOOKED TWICE: 10 × PRD-0013 and ${s2.p14 - s0.p14} × PRD-0014 were received once (${receiptNo}) and again by the bill — PRD-0013 rose by ${s2.p13 - stockBeforeSetup} for the 10 that arrived. Nothing warned the user; the success message reads „Фактурата е получена — наличността е актуализирана".`)
  const mvs = (await api.get(`/warehouse/movement?productId=${p13._id}&size=50`)).stockMovements || []
  const fromBill = mvs.find((m: any) => String(m.invoiceId || '') === String(bill?._id || bill?.id))
  const issued = await api.get(`/invoices/${bill?._id || bill?.id}`)
  extra.push(`Bill ${issued?.invoice?.invoiceNumber} (status ${issued?.invoice?.status}) created its own receipt ${fromBill?.number || fromBill?.movementNumber || '(not found)'} next to ${receiptNo}; nothing links the two.`)
  result.notes.push(...extra)
  writeFileSync(join(testInfo.project.outputDir, 'ux-budgets', 'P3', 'result.json'), JSON.stringify(result, null, 2))
  console.log(extra.join('\n'))

  expect(result.clicks).toBeGreaterThan(0)

  // ── FR-22 slice 1 guards (each failed on the code the budgets were first measured on) ──
  // B-10 / FR-22.8: a bill line starts at the article's purchase price, never the sales chain.
  for (const p of prefills) expect(p.prefilled, `${p.sku} pre-filled price`).toBeCloseTo(p.purchase, 4)
})
