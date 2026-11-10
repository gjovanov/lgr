import { test, expect } from '@playwright/test'
import { loginForApp } from './helpers/login'

/**
 * FR-28.45 / FR-28.46 (slice 6b) — a reservation's page says where the reservation sits.
 *
 * The page is five panels (the client and quantity, where the goods come from, the customer order, the
 * invoices, the history), and the second one draws the supply the reservation hangs on as the same tree
 * the supplier order shows: the line, the warehouses it was given and every reservation on them, this one
 * shaded. A stock reservation shows its warehouse and the active reservations on it. The numbers are links
 * that name the line they mean, so a click lands on that line, open and marked.
 *
 * Strict-mode choices that other specs rely on, asserted here too: a link named by the client's name is
 * exactly one (the first panel's), this reservation's own number is plain text, every other row links only
 * its reservation number, and the customer order of another row is plain text, so that the ORDO and the
 * ORDI number are each one link on the page (`reservations-page.spec`, walk P7-new).
 */

const apiBase = process.env.BASE_URL || 'http://localhost:4001'

async function session() {
  const res = await fetch(`${apiBase}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ orgSlug: 'acme-corp', username: 'admin', password: 'test123' }),
  })
  const data = await res.json()
  const orgId = (data.org?.id || data.org?._id) as string
  const call = async (method: string, path: string, body?: any) => {
    const r = await fetch(`${apiBase}/api/org/${orgId}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${data.token}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    return r.json()
  }
  return { orgId, call }
}

type Api = Awaited<ReturnType<typeof session>>
type World = Awaited<ReturnType<typeof world>>

/** An article with 20 on the shelf of the default warehouse, a second warehouse, two clients and a supplier. */
async function world(api: Api) {
  const ts = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
  const { product } = await api.call('POST', '/warehouse/product', {
    sku: `E2E-SUP-${ts}`, name: `E2E supply article ${ts}`, category: 'Test', type: 'goods', unit: 'pcs', sellingPrice: 3, purchasePrice: 1, taxRate: 20,
  })
  const productId = (product.id || product._id) as string
  const contact = async (type: string, companyName: string) => {
    const { contact: c } = await api.call('POST', '/invoicing/contact', { type, companyName })
    return { id: (c.id || c._id) as string, name: companyName }
  }
  const clientA = await contact('customer', `E2E supply client A ${ts}`)
  const clientB = await contact('customer', `E2E supply client B ${ts}`)
  const supplier = await contact('supplier', `E2E supply supplier ${ts}`)
  const warehouses = ((await api.call('GET', '/warehouse/warehouse?size=100')).warehouses || []).filter((w: any) => w.isActive !== false)
  const main = warehouses.find((w: any) => w.isDefault) || warehouses[0]
  const other = warehouses.find((w: any) => w._id !== main._id)
  const { stockMovement } = await api.call('POST', '/warehouse/movement', {
    type: 'receipt', date: new Date().toISOString(), toWarehouseId: main._id,
    lines: [{ productId, quantity: 20, unitCost: 1, totalCost: 20 }], totalAmount: 20,
  })
  await api.call('POST', `/warehouse/movement/${stockMovement._id || stockMovement.id}/confirm`, {})
  return { ts, product, productId, clientA, clientB, supplier, main, other }
}

/**
 * A sent supplier order for 10: six into the default warehouse, four into the other. Client A holds 3 of
 * the first (for a confirmed customer order), client B 2 of the first and 1 of the second.
 */
async function orderSupply(api: Api, w: World) {
  const today = new Date().toISOString().slice(0, 10)
  const { order } = await api.call('POST', '/invoicing/orders', {
    issueDate: today, expectedDate: '2026-12-20', currency: 'EUR', tags: [],
    supplierGroups: [{ supplierId: w.supplier.id, lines: [{
      productId: w.productId, description: w.product.name, quantity: 10, unit: 'pcs',
      allocations: [{ warehouseId: w.main._id, quantity: 6 }, { warehouseId: w.other._id, quantity: 4 }],
    }] }],
  })
  await api.call('POST', `/invoicing/orders/${order._id}/send`)
  const sent = (await api.call('GET', `/invoicing/orders/${order._id}`)).order
  const group = sent.supplierGroups[0]
  const line = group.lines[0]
  const { internalOrder } = await api.call('POST', '/invoicing/internal-orders', {
    contactId: w.clientA.id, issueDate: today, requestedDeliveryDate: '2026-12-10',
    lines: [{ productId: w.productId, description: w.product.name, quantity: 3, unit: 'pcs' }],
  })
  const ordi = (await api.call('POST', `/invoicing/internal-orders/${internalOrder._id}/confirm`)).internalOrder
  const ordiLine = ordi.lines[0]
  const at = (i: number) => ({ orderId: sent._id, groupId: group._id, lineId: line._id, allocationId: line.allocations[i]._id })
  const reserve = async (body: any) => (await api.call('POST', '/invoicing/reservations', { productId: w.productId, source: 'order', ...body })).reservation
  const rA = await reserve({ contactId: w.clientA.id, quantity: 3, ...at(0), internalOrderId: ordi._id, internalOrderLineId: ordiLine._id })
  const rB1 = await reserve({ contactId: w.clientB.id, quantity: 2, ...at(0) })
  const rB2 = await reserve({ contactId: w.clientB.id, quantity: 1, ...at(1) })
  return { order: sent, line, alloc0: String(line.allocations[0]._id), alloc1: String(line.allocations[1]._id), ordi, ordiLine, rA, rB1, rB2 }
}

/** Client A holds 2 and client B 3 of the default warehouse's shelf. */
async function stockSupply(api: Api, w: World) {
  const reserve = async (contactId: string, quantity: number) =>
    (await api.call('POST', '/invoicing/reservations', { productId: w.productId, source: 'stock', warehouseId: w.main._id, contactId, quantity })).reservation
  return { sA: await reserve(w.clientA.id, 2), sB: await reserve(w.clientB.id, 3) }
}

/** What the browser kept for a screen's panels. */
async function keptPanels(page: any, screen: string): Promise<Record<string, boolean>> {
  return page.evaluate((s: string) => {
    for (const [k, v] of Object.entries(localStorage)) {
      if (new RegExp(`^lgr:ui:panels:[^:]+:[^:]+:${s.replace('.', '\\.')}$`).test(k)) return JSON.parse(v as string)
    }
    return {}
  }, screen)
}

const PANELS = ['who', 'source', 'order', 'invoices', 'history']

async function openReservation(page: any, reservation: any) {
  await page.goto(`/invoicing/reservations/${reservation._id}`, { waitUntil: 'networkidle' })
  await expect(page.getByTestId('reservation-number')).toHaveText(reservation.reservationNumber, { timeout: 15000 })
}

const supplyOf = (page: any) => page.getByTestId('reservation-supply')
const treeRows = (page: any, kind: string) => supplyOf(page).locator(`tr[data-testid="tree-row"][data-kind="${kind}"]`)
const cell = (page: any, nodeId: string, col: string) => supplyOf(page).locator(`tr[data-node-id="${nodeId}"] td[data-col="${col}"]`)
const selfRow = (page: any) => supplyOf(page).locator('tr.order-tree__row--self')

test.describe('The reservation page — where the reservation sits (FR-28.45)', () => {
  test('an order reservation shows its line, the warehouses and every reservation on them, this one shaded', async ({ page }) => {
    const api = await session()
    const w = await world(api)
    const s = await orderSupply(api, w)

    await loginForApp(page)
    await openReservation(page, s.rA)

    // Five panels, every one open to begin with.
    for (const id of PANELS) {
      await expect(page.getByTestId(`reservation-panel-${id}`).getByTestId('panel-toggle'), id).toHaveAttribute('aria-expanded', 'true')
    }
    await expect(supplyOf(page)).toBeVisible()

    // The line, its two warehouses and the three reservations; the tree is open, nothing hides in it.
    await expect(treeRows(page, 'line')).toHaveCount(1)
    await expect(treeRows(page, 'allocation')).toHaveCount(2)
    await expect(treeRows(page, 'reservation')).toHaveCount(3)

    // The figures of the line and of each warehouse: ordered, reserved by clients, free (not yet given to a warehouse / not reserved).
    const lineId = `l:${s.line._id}`
    for (const [col, value] of [['qty', '10'], ['reserved', '6'], ['free', '0']]) await expect(cell(page, lineId, col), `line ${col}`).toHaveText(value)
    for (const [col, value] of [['qty', '6'], ['reserved', '5'], ['free', '1']]) await expect(cell(page, `a:${s.alloc0}`, col), `first warehouse ${col}`).toHaveText(value)
    for (const [col, value] of [['qty', '4'], ['reserved', '1'], ['free', '3']]) await expect(cell(page, `a:${s.alloc1}`, col), `second warehouse ${col}`).toHaveText(value)
    await expect(treeRows(page, 'allocation').nth(0)).toContainText(w.main.name)
    await expect(treeRows(page, 'allocation').nth(1)).toContainText(w.other.name)

    // Exactly one row is this reservation's: shaded, marked, and not a link to itself.
    await expect(selfRow(page)).toHaveCount(1)
    await expect(selfRow(page)).toHaveAttribute('data-node-id', `r:${s.rA._id}`)
    await expect(supplyOf(page).getByTestId('reservation-this')).toHaveCount(1)
    await expect(selfRow(page).getByTestId('reservation-this')).toBeVisible()
    await expect(selfRow(page)).toContainText(w.clientA.name)
    await expect(selfRow(page)).toContainText(s.rA.reservationNumber)
    await expect(selfRow(page).getByRole('link')).toHaveCount(0)
    await expect(cell(page, `r:${s.rA._id}`, 'qty')).toHaveText('3')

    // The other reservations name their client in plain text and link their own number.
    const b1 = supplyOf(page).locator(`tr[data-node-id="r:${s.rB1._id}"]`)
    await expect(b1).toContainText(w.clientB.name)
    await expect(b1.getByRole('link')).toHaveCount(1)
    await expect(b1.getByRole('link', { name: s.rB1.reservationNumber })).toBeVisible()
    await expect(cell(page, `r:${s.rB1._id}`, 'qty')).toHaveText('2')
    await expect(supplyOf(page).locator(`tr[data-node-id="r:${s.rB2._id}"]`).getByRole('link', { name: s.rB2.reservationNumber })).toBeVisible()
    await expect(cell(page, `r:${s.rB2._id}`, 'qty')).toHaveText('1')

    // Strict-mode choices other specs depend on: one link named by the client, one by the ORDO number, one by the ORDI number.
    await expect(page.getByRole('link', { name: w.clientA.name })).toHaveCount(1)
    await expect(page.getByRole('link', { name: w.clientB.name })).toHaveCount(0)
    await expect(page.getByRole('link', { name: s.order.orderNumber })).toHaveCount(1)
    await expect(page.getByRole('link', { name: s.ordi.orderNumber })).toHaveCount(1)
    await expect(page.getByRole('link', { name: s.rA.reservationNumber })).toHaveCount(0)

    // The reservation's late flag shows on the Source panel's header (the order comes after the date the customer asked for).
    await expect(page.getByTestId('reservation-panel-source').getByTestId('panel-flag')).toHaveText('Late')
  })

  test('another reservation of the tree opens on its own page, and there it is the shaded one', async ({ page }) => {
    const api = await session()
    const w = await world(api)
    const s = await orderSupply(api, w)

    await loginForApp(page)
    await openReservation(page, s.rA)
    await supplyOf(page).locator(`tr[data-node-id="r:${s.rB1._id}"]`).getByRole('link', { name: s.rB1.reservationNumber }).click()
    await page.waitForURL(new RegExp(`/invoicing/reservations/${s.rB1._id}$`))
    await expect(page.getByTestId('reservation-number')).toHaveText(s.rB1.reservationNumber, { timeout: 15000 })

    // The same supply, read from the other reservation: now B's first row is shaded and A's row is the one with a link.
    await expect(supplyOf(page)).toBeVisible()
    await expect(treeRows(page, 'reservation')).toHaveCount(3)
    await expect(selfRow(page)).toHaveCount(1)
    await expect(selfRow(page)).toHaveAttribute('data-node-id', `r:${s.rB1._id}`)
    await expect(selfRow(page).getByRole('link')).toHaveCount(0)
    const a = supplyOf(page).locator(`tr[data-node-id="r:${s.rA._id}"]`)
    await expect(a.getByRole('link', { name: s.rA.reservationNumber })).toBeVisible()
    // A's customer order is a number in the row, not a link: the one link to it is the order panel's, and B has none.
    await expect(a).toContainText(s.ordi.orderNumber)
    await expect(a.getByRole('link', { name: s.ordi.orderNumber })).toHaveCount(0)
    await expect(page.getByRole('link', { name: s.ordi.orderNumber })).toHaveCount(0)
    await expect(page.getByTestId('reservation-panel-order')).toContainText('Not for a customer order')
    // This is not a late reservation: B asked for no date.
    await expect(page.getByTestId('reservation-panel-source').getByTestId('panel-flag')).toHaveCount(0)
  })

  test('a stock reservation shows its warehouse and the active reservations on it', async ({ page }) => {
    const api = await session()
    const w = await world(api)
    const { sA, sB } = await stockSupply(api, w)

    await loginForApp(page)
    await openReservation(page, sA)
    await expect(supplyOf(page)).toBeVisible()
    await expect(page.getByTestId('reservation-panel-source')).toContainText(w.main.name)

    // The warehouse is the only level: on the shelf 20, reserved 5 (2 and 3), free 15; the two reservations under it.
    await expect(treeRows(page, 'line')).toHaveCount(0)
    await expect(treeRows(page, 'allocation')).toHaveCount(1)
    await expect(treeRows(page, 'reservation')).toHaveCount(2)
    const warehouse = `a:stock:${w.main._id}`
    for (const [col, value] of [['qty', '20'], ['reserved', '5'], ['free', '15']]) await expect(cell(page, warehouse, col), `warehouse ${col}`).toHaveText(value)
    await expect(selfRow(page)).toHaveCount(1)
    await expect(selfRow(page)).toHaveAttribute('data-node-id', `r:${sA._id}`)
    await expect(selfRow(page).getByTestId('reservation-this')).toBeVisible()
    await expect(selfRow(page).getByRole('link')).toHaveCount(0)
    const other = supplyOf(page).locator(`tr[data-node-id="r:${sB._id}"]`)
    await expect(other).toContainText(w.clientB.name)
    await expect(other.getByRole('link', { name: sB.reservationNumber })).toBeVisible()
    await expect(page.getByRole('link', { name: w.clientA.name })).toHaveCount(1)
    await expect(page.getByRole('link', { name: w.clientB.name })).toHaveCount(0)

    // Only the ACTIVE ones are on the shelf's tree: release the other client's and it is gone, the figures follow.
    await api.call('POST', `/invoicing/reservations/${sB._id}/cancel`, {})
    await page.reload({ waitUntil: 'networkidle' })
    await expect(supplyOf(page)).toBeVisible()
    await expect(treeRows(page, 'reservation')).toHaveCount(1)
    await expect(supplyOf(page).locator(`tr[data-node-id="r:${sB._id}"]`)).toHaveCount(0)
    for (const [col, value] of [['qty', '20'], ['reserved', '2'], ['free', '18']]) await expect(cell(page, warehouse, col), `warehouse ${col} after`).toHaveText(value)

    // This page's own reservation stays when it is the one cancelled: struck through, flagged, holding nothing.
    await api.call('POST', `/invoicing/reservations/${sA._id}/cancel`, {})
    await page.reload({ waitUntil: 'networkidle' })
    await expect(supplyOf(page)).toBeVisible()
    await expect(treeRows(page, 'reservation')).toHaveCount(1)
    await expect(selfRow(page)).toHaveAttribute('data-node-id', `r:${sA._id}`)
    await expect(selfRow(page).locator('.text-decoration-line-through').first()).toBeVisible()
    await expect(cell(page, `r:${sA._id}`, 'status')).toContainText('Cancelled')
    for (const [col, value] of [['qty', '20'], ['reserved', '0'], ['free', '20']]) await expect(cell(page, warehouse, col), `warehouse ${col} cancelled`).toHaveText(value)
  })
})

test.describe('The reservation page — links that name the line (FR-28.46)', () => {
  test('the supplier order link opens its line and warehouse, and the customer order link carries its line', async ({ page }) => {
    const api = await session()
    const w = await world(api)
    const s = await orderSupply(api, w)
    const ordoHref = new RegExp(`/orders/${s.order._id}/edit\\?line=${s.line._id}&allocation=${s.alloc0}$`)
    const ordiHref = new RegExp(`/internal-orders/${s.ordi._id}/edit\\?line=${s.ordiLine._id}$`)

    // The Reservations list: both numbers are links that name the line.
    await loginForApp(page)
    await page.goto(`/invoicing/reservations?q=${encodeURIComponent(s.rA.reservationNumber)}`, { waitUntil: 'networkidle' })
    const row = page.locator('.v-data-table tbody tr', { hasText: s.rA.reservationNumber })
    await expect(row).toBeVisible({ timeout: 15000 })
    await expect(row.getByRole('link', { name: s.order.orderNumber })).toHaveAttribute('href', ordoHref)
    await expect(row.getByRole('link', { name: s.ordi.orderNumber })).toHaveAttribute('href', ordiHref)

    // The page of the reservation: the same two links.
    await row.getByRole('link', { name: s.rA.reservationNumber }).click()
    await page.waitForURL(new RegExp(`/invoicing/reservations/${s.rA._id}$`))
    await expect(page.getByTestId('reservation-number')).toHaveText(s.rA.reservationNumber, { timeout: 15000 })
    await expect(page.getByRole('link', { name: s.order.orderNumber })).toHaveAttribute('href', ordoHref)
    await expect(page.getByRole('link', { name: s.ordi.orderNumber })).toHaveAttribute('href', ordiHref)

    // Following the supplier order's link lands on its line, the warehouse open and marked.
    await page.getByRole('link', { name: s.order.orderNumber }).click()
    await page.waitForURL(ordoHref)
    await expect(page.locator(`tr[data-node-id="a:${s.alloc0}"]`)).toHaveClass(/order-tree__row--hit/, { timeout: 15000 })
    await expect(page.locator(`tr[data-node-id="l:${s.line._id}"]`)).toBeVisible()
    await expect(page.locator(`tr[data-node-id="l:${s.line._id}"]`).getByTestId('tree-toggle')).toHaveAttribute('aria-expanded', 'true')

    // The supplier order's own tree names the customer order's line in the same way.
    const reservation = page.locator(`tr[data-node-id="r:${s.rA._id}"]`)
    await expect(reservation.getByRole('link', { name: s.ordi.orderNumber })).toHaveAttribute('href', ordiHref)
  })
})

test.describe('The reservation page — the panels fold on their own (FR-28.43)', () => {
  test('a folded panel says what it holds and keeps a flag, and the state is still there after a reload', async ({ page }) => {
    const api = await session()
    const w = await world(api)
    const s = await orderSupply(api, w)

    await loginForApp(page)
    await openReservation(page, s.rA)
    const panel = (id: string) => page.getByTestId(`reservation-panel-${id}`)
    const toggle = (id: string) => panel(id).getByTestId('panel-toggle')
    // Nothing to summarise while a panel is open.
    for (const id of PANELS) await expect(panel(id).getByTestId('panel-summary'), id).toHaveCount(0)

    for (const id of ['who', 'source', 'history']) await toggle(id).click()
    for (const id of ['who', 'source', 'history']) {
      await expect(toggle(id), id).toHaveAttribute('aria-expanded', 'false')
      await expect(panel(id).getByTestId('panel-body'), id).toBeHidden()
    }
    // The others are their own panels: they stay open.
    for (const id of ['order', 'invoices']) await expect(toggle(id), id).toHaveAttribute('aria-expanded', 'true')

    const folded = async () => {
      await expect(panel('who').getByTestId('panel-summary')).toContainText(`${w.clientA.name} · ${w.product.name} · 3 reserved · 0 invoiced · 0 dispatched`)
      await expect(panel('source').getByTestId('panel-summary')).toContainText(`${s.order.orderNumber} · ${w.main.name} · 3 reservations`)
      await expect(panel('history').getByTestId('panel-summary')).toHaveText('1 event')
      // What needs attention stays on a folded header.
      await expect(panel('source').getByTestId('panel-flag')).toHaveText('Late')
    }
    await folded()

    // Kept for this user, organization and screen.
    expect(await keptPanels(page, 'reservations.detail')).toMatchObject({ who: false, source: false, history: false })
    await page.reload({ waitUntil: 'networkidle' })
    await expect(page.getByTestId('reservation-number')).toHaveText(s.rA.reservationNumber, { timeout: 15000 })
    for (const id of ['who', 'source', 'history']) await expect(toggle(id), id).toHaveAttribute('aria-expanded', 'false')
    for (const id of ['order', 'invoices']) await expect(toggle(id), id).toHaveAttribute('aria-expanded', 'true')
    await folded()

    // Open again, which is remembered as well: the tree is back.
    for (const id of ['who', 'source', 'history']) await toggle(id).click()
    await expect(supplyOf(page)).toBeVisible()
    await page.reload({ waitUntil: 'networkidle' })
    await expect(page.getByTestId('reservation-number')).toHaveText(s.rA.reservationNumber, { timeout: 15000 })
    for (const id of PANELS) await expect(toggle(id), id).toHaveAttribute('aria-expanded', 'true')
    await expect(supplyOf(page)).toBeVisible()
  })
})
