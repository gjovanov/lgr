import { test, expect } from '@playwright/test'
import { signInForUx, startWalk, uxApi } from '../helpers/ux-budget'

/**
 * P7 — Who reserved what. "On this supplier order, which client has how much reserved?" — for
 * one line of an external order (ORDO) that is out to the supplier, find each client's quantity.
 *
 * Products used: PRD-0030 (the line in question) and PRD-0029 (a second line, see below) — this
 * walk's share of the acme-corp seed. Clients: Stellar Components, Nordic Wholesale. Supplier:
 * Quality Materials.
 *
 * The ORDO carries a second line on purpose: a real supplier order has several, and with only
 * one line the question answers itself on the ORDO page. Nordic Wholesale holds stock on both
 * lines, as a client ordering two articles from the same supplier would.
 */

type Api = Awaited<ReturnType<typeof uxApi>>
type Walk = Awaited<ReturnType<typeof startWalk>>

const SUPPLIER = 'Quality Materials'
const ASKED = { sku: 'PRD-0030', qty: 20, holds: [{ client: 'Stellar Components', qty: 8 }, { client: 'Nordic Wholesale', qty: 5 }] }
const OTHER = { sku: 'PRD-0029', qty: 10, holds: [{ client: 'Nordic Wholesale', qty: 4 }] }

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

/**
 * Setup (uncounted): an ORDO sent to the supplier with two lines allocated to the default
 * warehouse, and client reservations on the allocations — what „Резервирай за клиент" on the
 * ORDO form makes. Earlier runs' orders are cancelled first, which releases their reservations.
 */
async function sentOrderWithHolds(api: Api, supplier: any): Promise<any> {
  const asked = await productBySku(api, ASKED.sku)
  const other = await productBySku(api, OTHER.sku)
  const { orders } = await api.get('/invoicing/orders?size=100&status=draft,sent')
  for (const o of orders || []) {
    const mine = (o.supplierGroups || []).some((g: any) => String(g.supplierId) === String(supplier._id)
      && (g.lines || []).some((l: any) => String(l.productId) === String(asked._id)))
    if (mine) await api.post(`/invoicing/orders/${o._id}/cancel`)
  }
  const { warehouses } = await api.get('/warehouse/warehouse?size=100')
  const main = (warehouses || []).find((w: any) => w.isDefault) || warehouses?.[0]
  const line = (p: any, qty: number) => ({
    productId: p._id, description: p.name, sku: p.sku, quantity: qty, unit: p.unit || 'pcs',
    expectedUnitPrice: p.purchasePrice, allocations: [{ warehouseId: main._id, quantity: qty }],
  })
  const { order } = await api.post('/invoicing/orders', {
    issueDate: new Date().toISOString().split('T')[0],
    expectedDate: new Date(Date.now() + 10 * 86400000).toISOString().split('T')[0],
    supplierGroups: [{ supplierId: supplier._id, lines: [line(asked, ASKED.qty), line(other, OTHER.qty)] }],
  })
  expect(order?._id, 'external order created').toBeTruthy()
  const sent = (await api.post(`/invoicing/orders/${order._id}/send`)).order
  expect(sent?.status).toBe('sent')
  const group = sent.supplierGroups[0]
  for (const [spec, product] of [[ASKED, asked], [OTHER, other]] as const) {
    const l = group.lines.find((x: any) => String(x.productId) === String(product._id))
    for (const hold of spec.holds) {
      const client = await contactByName(api, hold.client)
      const { reservation } = await api.post('/invoicing/reservations', {
        source: 'order', productId: product._id, quantity: hold.qty, contactId: client._id,
        orderId: sent._id, groupId: group._id, lineId: l._id, allocationId: l.allocations[0]._id,
      })
      expect(reservation?.status, `${hold.client} ${hold.qty} × ${spec.sku}`).toBe('active')
    }
  }
  return { order: sent, asked, other }
}

/** Screenshots wait out Vuetify's dialog/snackbar transitions. */
async function settledShot(walk: Walk, name: string): Promise<void> {
  await walk.page.waitForTimeout(400)
  await walk.shot(name)
}

/**
 * Uncounted check in a separate tab, before the walk: would expanding the line's allocations
 * (the chevron) have shown who holds what? A user exploring might try it; the shortest route
 * does not.
 */
async function allocationEditorNote(page: any, testInfo: any, orderId: string, productName: string, clients: string[]): Promise<string> {
  const probe = await page.context().newPage()
  await signInForUx(probe)
  await probe.goto(`/invoicing/orders/${orderId}/edit`, { waitUntil: 'networkidle' })
  const row = probe.locator('tbody tr').filter({ has: probe.locator('.v-chip').filter({ hasText: productName }) }).first()
  await row.getByRole('button', { name: 'Складови разпределения' }).click()
  const editor = probe.locator('tbody tr .v-sheet').first()
  await expect(editor).toBeVisible()
  await probe.waitForTimeout(400)
  await probe.screenshot({ path: testInfo.outputPath('probe-allocation-expanded.png') })
  const text = await editor.innerText()
  await probe.close()
  return clients.some((c) => text.includes(c))
    ? ''
    : 'Expanding the line\'s allocations (chevron) shows the warehouse, quantity, „Получено к-во", „Свободно" and „Резервирай за клиент" — still no client names (checked outside the walk).'
}

test('P7 who reserved: per-client reserved quantity on one line of a supplier order', async ({ page }, testInfo) => {
  const api = await uxApi()
  const supplier = await contactByName(api, SUPPLIER)
  const { order, asked } = await sentOrderWithHolds(api, supplier)
  const ordoNumber: string = order.orderNumber
  const editorNote = await allocationEditorNote(page, testInfo, order._id, asked.name, ASKED.holds.map((h) => h.client))

  const walk = await startWalk(page, testInfo, {
    id: 'P7-who',
    title: 'External order — which client has how much reserved on one line',
    start: '/invoicing/orders',
  })
  const ordoRow = page.locator('tbody tr').filter({ hasText: ordoNumber })
  await expect(ordoRow).toBeVisible()
  await settledShot(walk, 'ordo-list')
  const headers = (await page.locator('thead th').allTextContents()).map((h) => h.trim()).filter(Boolean)
  walk.note(`External-orders list columns: ${headers.join(' · ')} — nothing about reservations (the API already returns a per-order reserving-client count, \`reservationClientCount\`; the list does not show it).`)

  // ── 1. Open the order ──
  await walk.click(ordoRow.getByRole('link', { name: ordoNumber }), 'open the external order')
  await page.waitForURL(/\/orders\/[0-9a-f]{24}\/edit/)
  const askedRow = page.locator('tbody tr').filter({ has: page.locator('.v-chip').filter({ hasText: asked.name }) }).first()
  await expect(askedRow).toBeVisible()
  await settledShot(walk, 'ordo-form')

  // The line's allocation chip: total reserved, no client names — and at 1366 px it sits in a
  // horizontally scrolled table, partly out of view.
  const allocChip = askedRow.locator('.v-chip').filter({ hasText: /R\)/ })
  await expect(allocChip).toHaveCount(1)
  const allocText = (await allocChip.textContent())!.replace(/\s+/g, ' ').trim()
  const reservedTotal = ASKED.holds.reduce((s, h) => s + h.qty, 0)
  expect(allocText).toContain(`(${reservedTotal}R)`)
  const box = await allocChip.boundingBox()
  const scroller = await askedRow.locator('xpath=ancestor::div[contains(@style,"overflow-x")][1]').boundingBox()
  const clipped = !!(box && scroller && box.x + box.width > scroller.x + scroller.width + 1)
  walk.note(`ORDO line „${asked.name}": the allocation chip reads „${allocText}" — the reserved total with an unexplained „R", no client names${clipped ? '; at 1366 px the „Складови разпределения" column is cut off at the right edge of a horizontally scrolling table, so even that chip is only partly visible' : ''}.`)

  // ── 2. The reservations card under the lines ──
  const resCard = page.locator('.v-card').filter({ has: page.locator('.v-card-title').filter({ hasText: 'Резервации' }) }).last()
  await resCard.scrollIntoViewIfNeeded() // the mouse wheel — not counted
  const cardHeaders = (await resCard.locator('thead th').allTextContents()).map((h) => h.trim()).filter(Boolean)
  const cardRows = resCard.locator('tbody tr')
  await expect(cardRows).toHaveCount(ASKED.holds.length + OTHER.holds.length)
  await settledShot(walk, 'ordo-reservations-card')
  const nordicRows = await cardRows.filter({ hasText: 'Nordic Wholesale' }).count()
  walk.note(`ORDO reservations card columns: ${cardHeaders.join(' · ')} — no product or line column. With two lines, „Nordic Wholesale" appears ${nordicRows}× (5 and 4) and the card cannot say which line each belongs to; only arithmetic against the chip (${reservedTotal}R = 8 + 5) would.`)

  // ── 3. The Reservations list: product + client + source on one row ──
  await walk.menu('Поръчки', 'Резервации')
  await page.waitForURL(/\/invoicing\/reservations(\?|$)/)
  const listRows = page.locator('tbody tr').filter({ has: page.locator('.v-chip').filter({ hasText: ordoNumber }) })
  await expect(listRows).toHaveCount(ASKED.holds.length + OTHER.holds.length)
  const askedRows = listRows.filter({ hasText: asked.sku })
  await expect(askedRows).toHaveCount(ASKED.holds.length)
  for (const hold of ASKED.holds) {
    await expect(askedRows.filter({ hasText: hold.client })).toContainText(`${hold.qty} / 0 / 0`)
  }
  await settledShot(walk, 'reservations-list')
  walk.note(`Answer read on the Reservations list (product, client, source ${ordoNumber} and quantity on one row): Stellar Components ${ASKED.holds[0].qty}, Nordic Wholesale ${ASKED.holds[1].qty} on ${ASKED.sku}. The rows are found by eye — they are on page 1 only because they are the newest.`)

  // What the list cannot do (uncounted, via the same API the search box calls).
  const byOrder = await api.get(`/invoicing/reservations?search=${encodeURIComponent(ordoNumber)}&size=5`)
  const byProduct = await api.get(`/invoicing/reservations?search=${encodeURIComponent(ASKED.sku)}&size=5`)
  walk.note(`Reservations search matches only the RES number or the client name: searching „${ordoNumber}" finds ${byOrder.total}, „${ASKED.sku}" finds ${byProduct.total}; there is no filter by external order or product (the API has orderId/productId filters, the page does not offer them). The ORDO number in the „Източник" column is a chip, not a link.`)
  walk.note('Alternative without leaving the ORDO: „Експорт" → „Вътрешен (разпределения + резервации)" → Excel/PDF (2 clicks) downloads a sheet listing each allocation\'s client reservations — the answer, but in a file outside the app.')

  if (editorNote) walk.note(editorNote)

  const result = walk.finish()
  expect(result.clicks).toBeGreaterThan(0)
})
