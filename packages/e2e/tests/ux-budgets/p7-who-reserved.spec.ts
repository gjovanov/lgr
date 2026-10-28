import { test, expect } from '@playwright/test'
import { startWalk, uxApi } from '../helpers/ux-budget'

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
  const numbers: Record<string, string> = {}
  for (const [spec, product] of [[ASKED, asked], [OTHER, other]] as const) {
    const l = group.lines.find((x: any) => String(x.productId) === String(product._id))
    for (const hold of spec.holds) {
      const client = await contactByName(api, hold.client)
      const { reservation } = await api.post('/invoicing/reservations', {
        source: 'order', productId: product._id, quantity: hold.qty, contactId: client._id,
        orderId: sent._id, groupId: group._id, lineId: l._id, allocationId: l.allocations[0]._id,
      })
      expect(reservation?.status, `${hold.client} ${hold.qty} × ${spec.sku}`).toBe('active')
      numbers[`${spec.sku}:${hold.client}`] = reservation.reservationNumber
    }
  }
  return { order: sent, asked, other, numbers }
}

/** Screenshots wait out Vuetify's dialog/snackbar transitions. */
async function settledShot(walk: Walk, name: string): Promise<void> {
  await walk.page.waitForTimeout(400)
  await walk.shot(name)
}

test('P7 who reserved: per-client reserved quantity on one line of a supplier order', async ({ page }, testInfo) => {
  const api = await uxApi()
  const supplier = await contactByName(api, SUPPLIER)
  const { order, asked, other, numbers } = await sentOrderWithHolds(api, supplier)
  const ordoNumber: string = order.orderNumber

  const walk = await startWalk(page, testInfo, {
    id: 'P7-who',
    title: 'External order — which client has how much reserved on one line',
    start: '/invoicing/orders',
  })
  // Exact: a draft's „DRF-ORDO-2026-00001" contains „ORDO-2026-00001", and the seed has drafts.
  const ordoLink = page.getByRole('link', { name: ordoNumber, exact: true })
  await expect(ordoLink).toBeVisible()
  await settledShot(walk, 'ordo-list')
  const headers = (await page.locator('thead th').allTextContents()).map((h) => h.trim()).filter(Boolean)
  walk.note(`External-orders list columns: ${headers.join(' · ')} — nothing about reservations (the API already returns a per-order reserving-client count, \`reservationClientCount\`; the list does not show it).`)

  // ── 1. Open the order: the answer is on it ──
  await walk.click(ordoLink, 'open the external order')
  await page.waitForURL(/\/orders\/[0-9a-f]{24}\/edit/)
  const lineRow = (p: any) => page.locator('tbody tr').filter({ has: page.locator('.v-chip').filter({ hasText: p.name }) }).first()
  // #252: a line holding reservations opens its client-reservations grid by itself, the row right
  // under the line; each reservation is a row in it, grouped by allocation — client, number, and the
  // quantity in a field named after the number.
  const editorOf = (p: any) => lineRow(p).locator('xpath=following-sibling::tr[1]')
  for (const [spec, p] of [[ASKED, asked], [OTHER, other]] as const) {
    const editor = editorOf(p)
    for (const hold of spec.holds) {
      const number = numbers[`${spec.sku}:${hold.client}`]
      await expect(editor).toContainText(hold.client)
      await expect(editor.getByRole('spinbutton', { name: new RegExp(number) })).toHaveValue(String(hold.qty))
    }
  }
  // Per line, not per order: Stellar Components holds nothing on the other line.
  await expect(editorOf(other)).not.toContainText(ASKED.holds[0].client)
  await settledShot(walk, 'ordo-form')

  // The line's allocation chip: the total reserved, and the clients in its tooltip.
  const reservedTotal = ASKED.holds.reduce((s, h) => s + h.qty, 0)
  const allocChip = lineRow(asked).locator('.v-chip').filter({ hasText: /·/ })
  await expect(allocChip).toHaveCount(1)
  await expect(allocChip).toContainText(String(reservedTotal))
  for (const hold of ASKED.holds) await expect(allocChip).toHaveAttribute('title', new RegExp(`${hold.client} ${hold.qty}`))
  const allocText = (await allocChip.textContent())!.replace(/\s+/g, ' ').trim()
  walk.note(`Answer read on the ORDO, one click from the list: under the „${asked.name}" line's allocation, ${ASKED.holds.map((h) => `${h.client} ${h.qty}`).join(' and ')} — a row per reservation with its number, client and quantity, changeable in place and saved with the order. The allocation chip reads „${allocText}" (the reserved total; its tooltip names the clients).`)
  walk.note('The Reservations list names the ORDO as a link in „Източник", and the product\'s „Наличност" tab lists the expected delivery with the clients holding it.')

  const result = walk.finish()
  // FR-22.40: 1 click, answered on the supplier order (#252). It was 2 clicks and a second page.
  expect(result.clicks).toBeLessThanOrEqual(1)
})
