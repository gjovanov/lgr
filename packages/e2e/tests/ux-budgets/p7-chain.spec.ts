import { test, expect } from '@playwright/test'
import { startWalk, uxApi } from '../helpers/ux-budget'

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
  // FR-22.50: the list's Create says what it creates.
  await walk.click(page.getByRole('link', { name: 'Нова входяща поръчка' }).first(), 'create internal order („Нова входяща поръчка")')
  await page.waitForURL(/\/internal-orders\/new/)
  await expect(page.getByRole('heading', { name: 'Нова входяща поръчка' })).toBeVisible()

  // A new document starts in its first field (FR-22.52): the customer search.
  const customerField = page.getByRole('combobox', { name: /Клиент/ })
  await expect(customerField).toBeFocused()
  await walk.type(customerField, 'Nordic', 'search the customer', { focused: true })
  const clientOption = page.locator('.v-overlay--active .v-list-item').filter({ hasText: CUSTOMER }).first()
  await expect(clientOption).toBeVisible()
  await walk.click(clientOption, 'pick the customer')

  await walk.fill(page.getByLabel('Желана доставка'), delivery, 'requested delivery date')

  const rows = page.locator('tbody tr').filter({ has: page.getByPlaceholder('Търсете продукти...') })
  for (let i = 0; i < LINES.length; i++) {
    const { p, qty } = LINES[i]
    const row = rows.nth(i)
    await walk.type(row.getByPlaceholder('Търсете продукти...'), p.sku, `line ${i + 1}: search ${p.sku}`)
    const option = page.locator('.pld-overlay .pld-item').filter({ hasText: p.sku }).first()
    await expect(option).toBeVisible()
    await walk.click(option, `line ${i + 1}: pick ${p.sku}`)
    await expect(row.locator('.v-chip').filter({ hasText: p.name })).toBeVisible()
    // FR-22.43: the article opens the next line, and the cursor waits in this line's quantity,
    // which picking the product set to 1 — the user types over it.
    await expect(rows).toHaveCount(i + 2)
    const quantity = row.getByRole('spinbutton', { name: 'Кол.' })
    await expect(quantity).toBeFocused()
    await walk.fill(quantity, String(qty), `line ${i + 1}: quantity ${qty}`, { focused: true })
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
  // FR-22.43: the message names what stock could not cover.
  const reservedSnack = snackbar(walk, /Създадени резервации/)
  await expect(reservedSnack).toBeVisible()
  await expect(reservedSnack).toContainText(`${p28.name} (липсват ${SHORTAGE})`)
  await expect(page.locator('tbody tr').filter({ hasText: p28.name }).getByText(`${free28}/${shortQty}`)).toBeVisible()
  await settledShot(walk, 'reserved')

  // ── 3. External order for the shortage ──
  await walk.click(page.getByRole('button', { name: 'Създай изходяща поръчка' }), 'generate external order')
  const genDialog = page.locator('.v-overlay--active .v-card').filter({ hasText: 'Създава чернова на изходяща поръчка' })
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
  const ordoSnack = snackbar(walk, /Създадена е изходяща поръчка/)
  await expect(ordoSnack).toBeVisible()
  const draftOrdo = ((await ordoSnack.innerText()).match(/поръчка\s+(\S+)/) || [])[1]
  expect(draftOrdo).toMatch(/ORDO-/)
  await settledShot(walk, 'ordo-generated')

  // The new ORDO on the ORDI page (#252): its number is a link, under the short line and in the
  // reservations table.
  const ordoLink = page.getByRole('link', { name: draftOrdo }).first()
  await expect(ordoLink).toBeVisible()
  const coverageChip = (await page.locator('.form-paper-header .v-chip').last().innerText()).trim()
  walk.note(`After the external order is generated (still a draft) the ORDI header reads „${coverageChip}" and the short line „${shortQty}/${shortQty}" reserved: units that are only on an unsent ORDO count as covered, the same as stock on the shelf.`)
  walk.note(`ORDO ${draftOrdo}: its number is a link under the short line and in the ORDI's reservations table, so the order is one click away — no menu, no list.`)

  // ── 4. Send the external order ──
  await walk.click(ordoLink, 'open the external order (its number under the short line)')
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
  // The ORDI number links from the reservation under the allocation (the line opens by itself,
  // #252) and from the reservations card below.
  const ordiLink = page.getByRole('link', { name: ordiNumber }).first()
  await ordiLink.scrollIntoViewIfNeeded()
  await settledShot(walk, 'ordo-reservations')
  await walk.click(ordiLink, 'open the internal order (link on the reservation under the allocation)')
  await page.waitForURL(/\/internal-orders\/[0-9a-f]{24}\/edit/)
  const ordiId = page.url().match(/internal-orders\/([0-9a-f]{24})/)![1]
  const convertBtn = page.locator('.form-actions-bar').getByRole('button', { name: 'Преобразувай във фактура' })
  await expect(convertBtn).toBeVisible()
  await walk.click(convertBtn, 'convert to invoice')
  const invSnack = snackbar(walk, /Създадена е фактура/)
  await expect(invSnack).toBeVisible()
  const invSnackText = await invSnack.innerText()
  const draftInvoice = (invSnackText.match(/фактура\s+(\S+)/) || [])[1]
  expect(draftInvoice).toBeTruthy()
  // FR-22.5: the message says what Convert left reserved, and on which external order.
  expect(invSnackText).toContain(ordoNumber)
  await settledShot(walk, 'converted')

  const invLinks = await page.getByRole('link', { name: draftInvoice! }).count()
  walk.note(`Invoice ${draftInvoice}: its number is shown only in the snackbar; the ORDI page ${invLinks ? 'links it' : 'shows no link to it (the API returns it in lookup.invoices, the form does not render it)'} — the user goes through the menu to the sales list.`)

  // What Convert put on the invoice (uncounted) — the B-7 guard: what is on the shelf, and NOT the
  // reservation on the external order just sent, whose goods have not arrived (FR-22.5).
  const { invoices } = await api.get(`/invoices?search=${encodeURIComponent(draftInvoice!)}&size=5`)
  const inv = (invoices || []).find((i: any) => i.invoiceNumber === draftInvoice)
  const draft = (await api.get(`/invoices/${inv._id}`)).invoice
  const onOrderRes = ((await api.get(`/invoicing/internal-orders/${ordiId}`)).reservations || [])
    .find((r: any) => r.source === 'order' && r.status === 'active')
  expect(onOrderRes?.quantity, 'the shortage is reserved on the external order').toBe(SHORTAGE)
  expect(draft.lines.filter((l: any) => l.orderRef?.orderId || String(l.orderRef?.reservationId) === String(onOrderRes._id)),
    'Convert leaves the reservation on the unreceived external order off the invoice').toEqual([])
  const p28Qty = draft.lines.filter((l: any) => String(l.productId) === String(p28._id)).reduce((s: number, l: any) => s + l.quantity, 0)
  expect(p28Qty).toBe(free28)
  // The list's Issue runs this pre-check first: nothing short, so no transfer dialog.
  const precheck = await api.post('/invoicing/stock-availability/check', {
    lines: draft.lines.map((l: any) => ({ productId: l.productId, warehouseId: l.warehouseId, quantity: l.quantity, reservationId: l.orderRef?.reservationId })),
  })
  expect(precheck.sufficient).toBe(true)
  walk.note(`Convert invoiced what is on the shelf (${free28} of ${shortQty} × „${p28.name}") and left the ${SHORTAGE} units on ${ordoNumber}, sent but not received, reserved for a later invoice; the snackbar says so (FR-22.5). Before, it invoiced them too and Issue dispatched them: PRD-0028 on-hand 404 → −10 and the ORDI „Доставена" — the walk had to open the draft, remove that line and save it (3 clicks).`)

  // ── 6. Issue it from the sales list ──
  await walk.menu('Изходящи документи', 'Документи за продажба')
  await page.waitForURL(/\/invoicing\/invoices(\?|$)/)
  const invRow = page.locator('tbody tr').filter({ hasText: draftInvoice! })
  await expect(invRow).toBeVisible()
  await settledShot(walk, 'invoice-list')
  walk.note('The ORDI page does not link the draft invoice (FR-22.35, slice 4), so it is issued from the sales list: its row menu ⋮ → „Издай". FR-22.23 put a row\'s actions in one menu — one click more than the old row icon „Изпрати".')
  await walk.click(invRow.getByTestId('row-actions'), 'the row\'s menu (⋮)')
  await walk.click(page.getByTestId('row-action-issue'), 'issue (row menu „Издай")')
  await expect(snackbar(walk, 'Фактурата е изпратена успешно')).toBeVisible()
  await settledShot(walk, 'issued')

  // What the walk did (uncounted), and the rest of the B-7 guard: nothing left the warehouse that
  // was not in it, and the client order is not „Доставена" for units still on order.
  let issued: any
  await expect.poll(async () => {
    issued = (await api.get(`/invoices/${inv._id}`)).invoice
    return issued?.status
  }, { timeout: 15000 }).toBe('sent')
  expect(issued.lines.some((l: any) => l.orderRef?.orderId)).toBe(false)
  const onHand28After = await onHand(api, p28._id)
  expect(onHand28After).toBe(onHand28Before - free28)
  expect(onHand28After, 'stock never goes below zero').toBeGreaterThanOrEqual(0)
  const ordiAfter = await api.get(`/invoicing/internal-orders/${ordiId}`)
  expect(ordiAfter.internalOrder.status).toBe('partially_delivered')
  const p28Line = ordiAfter.internalOrder.lines.find((l: any) => String(l.productId) === String(p28._id))
  expect(p28Line.deliveredQuantity).toBe(free28)
  const onOrderAfter = (ordiAfter.reservations || []).find((r: any) => String(r._id) === String(onOrderRes._id))
  expect(onOrderAfter).toMatchObject({ status: 'active', quantity: SHORTAGE, invoicedQuantity: 0, dispatchedQuantity: 0 })
  const ordoAfter = (await api.get(`/invoicing/orders?search=${ordoNumber}&size=5`)).orders?.[0]
  expect(ordoAfter?.status).toBe('sent')
  walk.note(`End state: ${issued.invoiceNumber} issued (draft ${draftInvoice}, renumbered on issue); ${ordiNumber} partially delivered (${free28}/${shortQty}) with the ${SHORTAGE} units still reserved on ${ordoNumber} (sent). ORDO and ORDI link each other; ORDI → invoice is not a link.`)

  const result = walk.finish()
  // FR-22.5 took the walk from 30 clicks to 27 and the ORDO number as a link on the ORDI (#252,
  // part of FR-22.35) to 26. FR-22.23 (one row menu) cost the issue step a click: 27. FR-22.43 takes
  // 5 off: an article opens the next line (no „Добави ред" twice) and leaves the cursor in its quantity
  // (three clicks). The customer field a new order starts in (FR-22.52) saves one the walk had not
  // taken. FR-22's target is ≤ 22.
  expect(result.clicks).toBeLessThanOrEqual(21)
})
