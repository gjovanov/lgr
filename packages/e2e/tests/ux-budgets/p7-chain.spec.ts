import { test, expect } from '@playwright/test'
import { startWalk, uxApi } from '../helpers/ux-budget'
import { lineQuantity } from '../helpers/document-form'

/**
 * P7 — Orders chain. One client order, end to end: an internal order (ORDI) for the client,
 * reserve what stock covers, put the shortage on an external order (ORDO) to a supplier, send
 * that ORDO, then turn the ORDI's reservations into a sales invoice and issue it.
 *
 * Products used: PRD-0026..0028 (this walk's share of the acme-corp seed). Customer: Nordic
 * Wholesale. Supplier: Luxor Imports.
 */

type Api = Awaited<ReturnType<typeof uxApi>>
type Walk = Awaited<ReturnType<typeof startWalk>>

const CUSTOMER = 'Nordic Wholesale'
const SUPPLIER = 'Luxor Imports'
/** How many units of the short line stock cannot cover. */
const SHORTAGE = 10

async function productBySku(api: Api, sku: string): Promise<any> {
  const { products } = await api.get(`/warehouse/product?search=${encodeURIComponent(sku)}&size=5`)
  const p = (products || []).find((x: any) => x.sku === sku)
  expect(p, `seed product ${sku}`).toBeTruthy()
  return p
}

async function contactByName(api: Api, name: string): Promise<any> {
  const { contacts } = await api.get(`/invoicing/contact?search=${encodeURIComponent(name)}&size=5`)
  const c = (contacts || []).find((x: any) => x.companyName === name)
  expect(c, name).toBeTruthy()
  return c
}

async function stockLevels(api: Api, productId: string): Promise<any[]> {
  const { stockLevels } = await api.get(`/warehouse/stock-level?productId=${productId}&size=50`)
  return stockLevels || []
}

/** Sellable stock over all warehouses, computed the way „Резервирай от склад" computes it. */
async function freeStock(api: Api, productId: string): Promise<number> {
  return (await stockLevels(api, productId)).reduce((s, sl) => s + Math.max(0, (sl.quantity || 0) - (sl.reservedQuantity || 0)), 0)
}

async function onHand(api: Api, productId: string): Promise<number> {
  return (await stockLevels(api, productId)).reduce((s, sl) => s + (sl.quantity || 0), 0)
}

/**
 * Re-runnability (uncounted): a run that failed half-way leaves a confirmed ORDI whose
 * reservations hold this walk's stock. Cancel those (and any draft invoice converted from them).
 */
async function clearLeftovers(api: Api, shortProductId: string): Promise<void> {
  const { internalOrders } = await api.get('/invoicing/internal-orders?size=100&status=draft,confirmed')
  for (const o of internalOrders || []) {
    if (!(o.lines || []).some((l: any) => String(l.productId) === shortProductId)) continue
    const { internalOrder, lookup } = await api.get(`/invoicing/internal-orders/${o._id}`)
    for (const [id, inv] of Object.entries<any>(lookup?.invoices || {})) {
      if (inv.status === 'draft') await api.del(`/invoices/${id}`)
    }
    await api.post(`/invoicing/internal-orders/${internalOrder._id}/cancel`)
  }
  const { orders } = await api.get('/invoicing/orders?size=100&status=draft')
  for (const o of orders || []) {
    if ((o.supplierGroups || []).some((g: any) => (g.lines || []).some((l: any) => String(l.productId) === shortProductId))) {
      await api.post(`/invoicing/orders/${o._id}/cancel`)
    }
  }
}

/**
 * The generate dialog pre-fills the supplier of the most recent external order that carried the
 * product. Regal re-orders the same articles from the same suppliers, so the walk measures that
 * daily case: if no external order ever carried the product (a fresh database), record one,
 * uncounted, so every run starts from the same history.
 */
async function ensureSupplierHistory(api: Api, product: any, supplierId: string): Promise<void> {
  const { orders } = await api.get('/invoicing/orders?size=200')
  const carried = (orders || []).some((o: any) => (o.supplierGroups || []).some((g: any) =>
    (g.lines || []).some((l: any) => String(l.productId) === String(product._id))))
  if (carried) return
  const { order } = await api.post('/invoicing/orders', {
    issueDate: new Date().toISOString().split('T')[0],
    supplierGroups: [{ supplierId, lines: [{ productId: product._id, description: product.name, quantity: 1, unit: 'pcs', allocations: [] }] }],
  })
  await api.post(`/invoicing/orders/${order._id}/cancel`)
}

/**
 * Every run dispatches all the free stock of the short article, so top the default warehouse up
 * (uncounted) when it runs low: the short line then always has some stock to reserve and
 * {@link SHORTAGE} units to order.
 */
async function topUp(api: Api, product: any, minFree: number, qty: number): Promise<void> {
  if (await freeStock(api, product._id) >= minFree) return
  const { warehouses } = await api.get('/warehouse/warehouse?size=100')
  const main = (warehouses || []).find((w: any) => w.isDefault) || warehouses?.[0]
  const cost = product.purchasePrice || 0
  const { stockMovement } = await api.post('/warehouse/movement', {
    type: 'receipt',
    date: new Date().toISOString(),
    toWarehouseId: main._id,
    lines: [{ productId: product._id, quantity: qty, unitCost: cost, totalCost: qty * cost }],
    totalAmount: qty * cost,
    notes: 'ux-budget P7 top-up',
  })
  await api.post(`/warehouse/movement/${stockMovement._id || stockMovement.id}/confirm`, {})
}

const snackbar = (walk: Walk, text: string | RegExp) => walk.page.locator('.v-snackbar').filter({ hasText: text })

/** Screenshots wait out Vuetify's dialog/snackbar transitions. */
async function settledShot(walk: Walk, name: string): Promise<void> {
  await walk.page.waitForTimeout(400)
  await walk.shot(name)
}

test('P7 chain: client order → reserve → external order → send → invoice → issue', async ({ page }, testInfo) => {
  const api = await uxApi()
  const [p26, p27, p28] = await Promise.all(['PRD-0026', 'PRD-0027', 'PRD-0028'].map((s) => productBySku(api, s)))
  const supplier = await contactByName(api, SUPPLIER)
  await clearLeftovers(api, p28._id)
  await ensureSupplierHistory(api, p28, supplier._id)
  await topUp(api, p28, 20, 50)
  const free28 = await freeStock(api, p28._id)
  expect(free28).toBeGreaterThan(0)
  const shortQty = free28 + SHORTAGE
  const onHand28Before = await onHand(api, p28._id)
  const delivery = new Date(Date.now() + 14 * 86400000).toISOString().split('T')[0]
  const LINES = [
    { p: p26, qty: 5 },
    { p: p27, qty: 5 },
    { p: p28, qty: shortQty },
  ]

  const walk = await startWalk(page, testInfo, {
    id: 'P7-chain',
    title: 'Orders chain — ORDI (3 lines, 1 short) → reserve → ORDO → send → invoice → issue',
    start: '/invoicing/internal-orders',
  })
  await walk.shot('ordi-list')

  // ── 1. New internal order ──
  await walk.click(page.getByRole('link', { name: /Създай/ }).first(), 'create internal order (list)')
  await page.waitForURL(/\/internal-orders\/new/)
  await expect(page.getByRole('heading', { name: 'Нова вътрешна поръчка' })).toBeVisible()

  await walk.type(page.getByRole('combobox', { name: /Клиент/ }), 'Nordic', 'search the customer')
  const clientOption = page.locator('.v-overlay--active .v-list-item').filter({ hasText: CUSTOMER }).first()
  await expect(clientOption).toBeVisible()
  await walk.click(clientOption, 'pick the customer')

  await walk.fill(page.getByLabel('Желана доставка'), delivery, 'requested delivery date')

  const rows = page.locator('tbody tr').filter({ has: page.getByPlaceholder('Търсете продукти...') })
  for (let i = 0; i < LINES.length; i++) {
    const { p, qty } = LINES[i]
    if (i > 0) {
      await walk.click(page.getByRole('button', { name: 'Добави ред' }), `add line ${i + 1}`)
      await expect(rows).toHaveCount(i + 1)
    }
    const row = rows.nth(i)
    await walk.type(row.getByPlaceholder('Търсете продукти...'), p.sku, `line ${i + 1}: search ${p.sku}`)
    const option = page.locator('.pld-overlay .pld-item').filter({ hasText: p.sku }).first()
    await expect(option).toBeVisible()
    await walk.click(option, `line ${i + 1}: pick ${p.sku}`)
    await expect(row.locator('.v-chip').filter({ hasText: p.name })).toBeVisible()
    // Picking the product puts 1 in the quantity; the user types over it.
    await walk.fill(row.locator('input[type="number"]').first(), String(qty), `line ${i + 1}: quantity ${qty}`)
  }
  await settledShot(walk, 'ordi-filled')

  await walk.click(page.locator('.form-actions-bar').getByRole('button', { name: 'Запази' }), 'save')
  await page.waitForURL(/\/internal-orders\/[0-9a-f]{24}\/edit/)
  await expect(snackbar(walk, 'Успешно запазено')).toBeVisible()
  const confirmBtn = page.locator('.form-actions-bar').getByRole('button', { name: 'Потвърди' })
  await expect(confirmBtn).toBeVisible()

  await walk.click(confirmBtn, 'confirm the order')
  await expect(snackbar(walk, 'Поръчката е потвърдена')).toBeVisible()
  const reserveBtn = page.getByRole('button', { name: 'Резервирай от склад' })
  await expect(reserveBtn).toBeVisible()
  const ordiNumber = (await page.locator('.form-paper-header .text-h6').innerText()).trim()
  expect(ordiNumber).toMatch(/^ORDI-/)
  await settledShot(walk, 'ordi-confirmed')

  // ── 2. Reserve what stock covers ──
  await walk.click(reserveBtn, 'reserve from stock')
  await expect(snackbar(walk, /Създадени резервации/)).toBeVisible()
  await expect(page.locator('tbody tr').filter({ hasText: p28.name }).getByText(`${free28}/${shortQty}`)).toBeVisible()
  await settledShot(walk, 'reserved')

  // ── 3. External order for the shortage ──
  await walk.click(page.getByRole('button', { name: 'Създай външна поръчка' }), 'generate external order')
  const genDialog = page.locator('.v-overlay--active .v-card').filter({ hasText: 'Създава чернова на външна поръчка' })
  await expect(genDialog).toBeVisible()
  walk.dialog('generate external order (one row per short line)')
  const supplierField = genDialog.getByRole('combobox', { name: /Доставчик/ })
  const supplierBox = supplierField.locator('xpath=ancestor::div[contains(@class,"v-field")][1]')
  await expect(supplierBox).toContainText(SUPPLIER)
  await expect(genDialog.getByRole('spinbutton', { name: 'Кол.' })).toHaveValue(String(SHORTAGE))
  await settledShot(walk, 'generate-dialog')
  walk.note(`Generate dialog: quantity (${SHORTAGE}) and supplier („${SUPPLIER}", from the last external order that carried the article) come pre-filled; on an article never ordered before the supplier is blank and costs a search + pick (+2 clicks, +1 typed).`)
  walk.note('Generate dialog: „Склад" is blank and optional — the external order silently goes to the default warehouse (Main Warehouse); nothing says so.')
  walk.note('Generate dialog always creates a NEW draft ORDO: the API can append to an existing draft (`orderId`), the dialog offers no choice — two client orders short on articles from the same supplier become two supplier orders.')
  await walk.click(genDialog.getByRole('button', { name: 'Създай', exact: true }), 'create the external order')
  const ordoSnack = snackbar(walk, /Създадена е външна поръчка/)
  await expect(ordoSnack).toBeVisible()
  const draftOrdo = ((await ordoSnack.innerText()).match(/поръчка\s+(\S+)/) || [])[1]
  expect(draftOrdo).toMatch(/ORDO-/)
  await settledShot(walk, 'ordo-generated')

  // The new ORDO on the ORDI page: a chip in the reservations table, not a link.
  const ordoChip = page.locator('.v-chip').filter({ hasText: draftOrdo })
  await expect(ordoChip).toBeVisible()
  const coverageChip = (await page.locator('.form-paper-header .v-chip').last().innerText()).trim()
  walk.note(`After the external order is generated (still a draft) the ORDI header reads „${coverageChip}" and the short line „${shortQty}/${shortQty}" reserved: units that are only on an unsent ORDO count as covered, the same as stock on the shelf.`)
  const ordoLinks = await page.getByRole('link', { name: draftOrdo }).count()
  walk.note(`ORDO ${draftOrdo}: its number appears in a 3-second snackbar and as a chip in the ORDI's reservations table — the chip is ${ordoLinks ? 'a link' : 'not a link'}; the user goes through the menu and the list to open it.`)

  // ── 4. Send the external order ──
  await walk.menu('Поръчки', 'Външни поръчки')
  await page.waitForURL(/\/invoicing\/orders(\?|$)/)
  const ordoRow = page.locator('tbody tr').filter({ hasText: draftOrdo })
  await expect(ordoRow).toBeVisible()
  await settledShot(walk, 'ordo-list')
  await walk.click(ordoRow.getByRole('link', { name: draftOrdo }), 'open the external order')
  await page.waitForURL(/\/orders\/[0-9a-f]{24}\/edit/)
  const sendBtn = page.locator('.form-actions-bar').getByRole('button', { name: 'Изпрати поръчката' })
  await expect(sendBtn).toBeVisible()
  await settledShot(walk, 'ordo-form')
  await walk.click(sendBtn, 'send the external order')
  await expect(snackbar(walk, 'Поръчката е изпратена')).toBeVisible()
  await expect(page.locator('.form-paper-header .text-h6')).not.toHaveText(draftOrdo)
  const ordoNumber = (await page.locator('.form-paper-header .text-h6').innerText()).trim()
  await settledShot(walk, 'ordo-sent')
  walk.note(`Sending renumbers the external order: ${draftOrdo} (the number the snackbar gave) becomes ${ordoNumber}.`)

  // ── 5. Back to the client order and convert ──
  const ordiLink = page.getByRole('link', { name: ordiNumber })
  await ordiLink.scrollIntoViewIfNeeded()
  await settledShot(walk, 'ordo-reservations')
  await walk.click(ordiLink, 'open the internal order (link in the ORDO reservations card)')
  await page.waitForURL(/\/internal-orders\/[0-9a-f]{24}\/edit/)
  const convertBtn = page.locator('.form-actions-bar').getByRole('button', { name: 'Преобразувай във фактура' })
  await expect(convertBtn).toBeVisible()
  await walk.click(convertBtn, 'convert to invoice')
  const invSnack = snackbar(walk, /Създадена е фактура/)
  await expect(invSnack).toBeVisible()
  const draftInvoice = ((await invSnack.innerText()).match(/фактура\s+(\S+)/) || [])[1]
  expect(draftInvoice).toBeTruthy()
  await settledShot(walk, 'converted')

  const invLinks = await page.getByRole('link', { name: draftInvoice! }).count()
  walk.note(`Invoice ${draftInvoice}: its number is shown only in the 3-second snackbar; the ORDI page ${invLinks ? 'links it' : 'shows no link to it (the API returns it in lookup.invoices, the form does not render it)'} — the user goes through the menu to the sales list.`)

  // What Convert put on the invoice (uncounted): one line per open reservation — including the
  // reservation on the external order just sent, whose goods have not arrived.
  const { invoices } = await api.get(`/invoices?search=${encodeURIComponent(draftInvoice!)}&size=5`)
  const inv = (invoices || []).find((i: any) => i.invoiceNumber === draftInvoice)
  const draft = (await api.get(`/invoices/${inv._id}`)).invoice
  const onOrderIdx = draft.lines.findIndex((l: any) => l.orderRef?.orderId)
  expect(onOrderIdx, 'Convert put the ORDO-backed reservation on the invoice').toBeGreaterThanOrEqual(0)
  expect(draft.lines[onOrderIdx].quantity).toBe(SHORTAGE)
  // Would Issue stop it? The list's Issue runs this same pre-check first.
  const precheck = await api.post('/invoicing/stock-availability/check', {
    lines: draft.lines.map((l: any) => ({ productId: l.productId, warehouseId: l.warehouseId, quantity: l.quantity, reservationId: l.orderRef?.reservationId })),
  })
  walk.note(`Convert has no line choice: it invoices EVERY open reservation of the ORDI, including the ${SHORTAGE} units reserved on ${ordoNumber}, which is sent but not received. Issue's stock pre-check ${precheck.sufficient ? 'passes it (the ORDO reservation exempts the line)' : 'flags it'}, so issued as converted the invoice dispatches ${SHORTAGE} units the warehouse does not have — seen while building this walk: PRD-0028 on-hand 404 → −10 and the ORDI „Доставена" 424/424. The walk removes that line before issuing, the only way the UI offers to invoice just what is in stock.`)
  walk.note('Converting BEFORE generating the external order avoids the trap (the ORDO reservation does not exist yet) — the UI gives no hint that the order of the two steps matters.')

  // ── 6. The invoice: open it, take off the line still on order, save, issue ──
  await walk.menu('Изходящи документи', 'Документи за продажба')
  await page.waitForURL(/\/invoicing\/invoices(\?|$)/)
  const invRow = page.locator('tbody tr').filter({ hasText: draftInvoice! })
  await expect(invRow).toBeVisible()
  await settledShot(walk, 'invoice-list')
  await walk.click(invRow.getByRole('link', { name: draftInvoice! }), 'open the draft invoice')
  await page.waitForURL(/\/invoices\/[0-9a-f]{24}\/edit/)
  const lineRows = page.locator('.line-table tbody tr').filter({ has: page.getByPlaceholder('Търсете продукти...') })
  await expect(lineRows.nth(draft.lines.length - 1)).toBeVisible()
  const onOrderRow = lineRows.nth(onOrderIdx)
  await expect(onOrderRow.locator('.v-chip').filter({ hasText: p28.name })).toBeVisible()
  await expect(lineQuantity(onOrderRow)).toHaveValue(String(SHORTAGE))
  await onOrderRow.scrollIntoViewIfNeeded() // the mouse wheel — not counted
  await settledShot(walk, 'invoice-draft')
  const invoiceLinksBack = await page.locator('.v-main').getByRole('link', { name: new RegExp(`${ordiNumber}|${ordoNumber}`) }).count()
  const p28Lines = draft.lines.filter((l: any) => String(l.productId) === String(p28._id)).length
  walk.note(`Invoice form: ${p28Lines} line(s) of „${p28.name}"; nothing marks which one is still on order (no source / reservation / ORDO column) — the user recognises it by the quantity (${SHORTAGE}).`)
  const removeBtn = onOrderRow.getByRole('button', { name: 'common.remove' })
  if (await removeBtn.count()) walk.note('Line remove buttons are labelled „common.remove" (title + aria-label): the i18n key is missing from bg.json and en.json.')
  await walk.click(onOrderRow.locator('td').last().getByRole('button'), `remove the line still on order (×${SHORTAGE})`)
  await expect(lineRows.filter({ has: page.locator('.v-chip').filter({ hasText: p28.name }) })).toHaveCount(p28Lines - 1)
  await walk.click(page.locator('.form-actions-bar').getByRole('button', { name: 'Запази' }), 'save the invoice')
  await page.waitForURL(/\/invoicing\/invoices(\?|$)/)
  await expect(snackbar(walk, /успешно/i)).toBeVisible()
  walk.note('The invoice form has no Issue button: Save returns to the list, and the draft is issued from the row icon „Изпрати".')

  await expect(invRow).toBeVisible()
  await walk.click(invRow.getByRole('button', { name: 'Изпрати', exact: true }), 'issue (row „Изпрати")')
  await expect(snackbar(walk, 'Фактурата е изпратена успешно')).toBeVisible()
  await settledShot(walk, 'issued')

  // What the walk did (uncounted).
  let issued: any
  await expect.poll(async () => {
    issued = (await api.get(`/invoices/${inv._id}`)).invoice
    return issued?.status
  }, { timeout: 15000 }).toBe('sent')
  expect(issued.lines.some((l: any) => l.orderRef?.orderId)).toBe(false)
  const onHand28After = await onHand(api, p28._id)
  expect(onHand28After).toBe(onHand28Before - free28)
  const ordiAfter = (await api.get(`/invoicing/internal-orders?search=${ordiNumber}&size=5`)).internalOrders?.[0]
  expect(ordiAfter?.status).toBe('partially_delivered')
  const ordoAfter = (await api.get(`/invoicing/orders?search=${ordoNumber}&size=5`)).orders?.[0]
  expect(ordoAfter?.status).toBe('sent')
  walk.note(`End state: ${issued.invoiceNumber} issued (draft ${draftInvoice}, renumbered on issue); ${ordiNumber} partially delivered with the ${SHORTAGE} units still reserved on ${ordoNumber} (sent). Of the hand-offs on this path only ORDO → ORDI is a link; ORDI → ORDO, ORDI → invoice and invoice → ORDI/ORDO ${invoiceLinksBack ? '(the invoice does link back)' : 'are not'}.`)

  const result = walk.finish()
  expect(result.clicks).toBeGreaterThan(0)
})
