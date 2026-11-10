import { test, expect } from '@playwright/test'
import { loginForApp } from './helpers/login'

/**
 * FR-28.44, .46 and .47 for the CUSTOMER order — its lines as a tree.
 *
 * A line, and under it the reservations that cover it, in the supplier order's columns and drawn by the same
 * component. What a closed line still says (its figures, what is late), the figures that add up to the panel's
 * summary, + Reserve on a line (from stock, from a supplier order, generate) opening the dialog that already made
 * that reservation for THAT line, a reservation released from its row, the card's state across a reload, a link
 * that names a line (`?line=`), the keyboard, and a quantity of five digits and a price of 9,999.99 read whole.
 *
 * Reservations are made, changed and released AT ONCE here (each with its own dialog): nothing on this tree is
 * staged until Save, unlike the supplier order's.
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
  return { call }
}
type Api = Awaited<ReturnType<typeof session>>

/** Three articles with `stock` units each in the default warehouse, a client and a supplier. */
async function world(api: Api, stock = 10) {
  const ts = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
  const article = async (n: number) => (await api.call('POST', '/warehouse/product', {
    sku: `E2E-CTREE${n}-${ts}`, name: `E2E ctree article ${n} ${ts}`, category: 'Test', type: 'goods', unit: 'pcs', sellingPrice: 3, purchasePrice: 1, taxRate: 20,
  })).product
  const [p1, p2, p3] = [await article(1), await article(2), await article(3)]
  const contact = async (type: string, name: string) => (await api.call('POST', '/invoicing/contact', { type, companyName: `E2E ctree ${name} ${ts}` })).contact
  const client = await contact('customer', 'client')
  const supplier = await contact('supplier', 'supplier')
  const warehouses = (await api.call('GET', '/warehouse/warehouse?size=100')).warehouses || []
  const main = warehouses.find((w: any) => w.isDefault) || warehouses[0]
  if (stock > 0) {
    for (const p of [p1, p2, p3]) {
      const { stockMovement } = await api.call('POST', '/warehouse/movement', {
        type: 'receipt', date: new Date().toISOString(), toWarehouseId: main._id,
        lines: [{ productId: p._id || p.id, quantity: stock, unitCost: 1, totalCost: stock }], totalAmount: stock,
      })
      await api.call('POST', `/warehouse/movement/${stockMovement._id || stockMovement.id}/confirm`, {})
    }
  }
  return { ts, p1, p2, p3, client, supplier, main }
}
type World = Awaited<ReturnType<typeof world>>
const idOf = (x: any) => String(x._id || x.id)

interface LineSpec { product: 'p1' | 'p2' | 'p3'; qty: number; price?: number }

/** A confirmed customer order. The day the client asked for is 2026-11-20, before the supplier orders below arrive (2026-12-01). */
async function customerOrder(api: Api, w: World, lines: LineSpec[]) {
  const { internalOrder } = await api.call('POST', '/invoicing/internal-orders', {
    contactId: idOf(w.client), issueDate: new Date().toISOString().slice(0, 10), requestedDeliveryDate: '2026-11-20',
    lines: lines.map((l) => ({ productId: idOf(w[l.product]), description: w[l.product].name, quantity: l.qty, unit: 'pcs', expectedUnitPrice: l.price ?? 3 })),
  })
  return (await api.call('POST', `/invoicing/internal-orders/${internalOrder._id}/confirm`)).internalOrder
}

async function reserveFromStock(api: Api, w: World, ordi: any, lineIndex: number, quantity: number) {
  const line = ordi.lines[lineIndex]
  return (await api.call('POST', '/invoicing/reservations', {
    source: 'stock', productId: line.productId, quantity, internalOrderId: ordi._id, internalOrderLineId: line._id, warehouseId: w.main._id,
  })).reservation
}

/** A sent supplier order for the line's article, and a reservation held on it for the customer's line. */
async function reserveFromSupplier(api: Api, w: World, ordi: any, lineIndex: number, quantity: number) {
  const line = ordi.lines[lineIndex]
  const { order } = await api.call('POST', '/invoicing/orders', {
    issueDate: new Date().toISOString().slice(0, 10), expectedDate: '2026-12-01', currency: 'EUR', tags: [],
    supplierGroups: [{ supplierId: idOf(w.supplier), lines: [{ productId: line.productId, description: line.description, quantity, unit: 'pcs', allocations: [{ warehouseId: w.main._id, quantity }] }] }],
  })
  const sent = (await api.call('POST', `/invoicing/orders/${order._id}/send`)).order
  const group = sent.supplierGroups[0]
  const supplierLine = group.lines[0]
  const reservation = (await api.call('POST', '/invoicing/reservations', {
    source: 'order', productId: line.productId, quantity, internalOrderId: ordi._id, internalOrderLineId: line._id,
    orderId: sent._id, groupId: group._id, lineId: supplierLine._id, allocationId: supplierLine.allocations[0]._id,
  })).reservation
  return { order: sent, supplierLine, allocation: supplierLine.allocations[0], reservation }
}

async function open(page: any, ordi: any, query = '') {
  await loginForApp(page)
  await page.goto(`/invoicing/internal-orders/${ordi._id}/edit${query}`)
  await expect(page.locator('.form-paper-header').getByText(ordi.orderNumber)).toBeVisible({ timeout: 15000 })
  await expect(page.getByTestId('tree-row').first()).toBeVisible()
}

const lineRow = (page: any, lineId: string) => page.locator(`tr[data-kind="line"][data-node-id="l:${lineId}"]`)
const rowsUnder = (page: any, lineId: string) => page.locator(`tr[data-root-id="l:${lineId}"]`)
const toggle = (page: any, lineId: string) => page.locator(`[data-tree-toggle="l:${lineId}"]`)
const cell = (row: any, col: string) => row.locator(`td[data-col="${col}"]`)
const coverDialog = (page: any) => page.locator('.v-overlay--active .v-card').filter({ hasText: 'Cover shortages' })
const generateDialog = (page: any) => page.locator('.v-overlay--active .v-card').filter({ hasText: 'Generate supplier order' }).filter({ has: page.getByRole('spinbutton', { name: 'Qty' }) })

test.describe('The customer order is a tree (FR-28.44)', () => {
  test('a line folds and opens, a folded line still says what it holds, and the summary is the figures', async ({ page }) => {
    const api = await session()
    const w = await world(api)
    const ordi = await customerOrder(api, w, [{ product: 'p1', qty: 3 }, { product: 'p2', qty: 4 }, { product: 'p3', qty: 2 }])
    const [l1, l2, l3] = ordi.lines.map((l: any) => String(l._id))
    await reserveFromStock(api, w, ordi, 0, 3)
    await reserveFromStock(api, w, ordi, 1, 1)
    await reserveFromSupplier(api, w, ordi, 1, 2)
    await open(page, ordi)

    // What holds a reservation is open on its own; a line with none is not.
    await expect(toggle(page, l1)).toHaveAttribute('aria-expanded', 'true')
    await expect(toggle(page, l2)).toHaveAttribute('aria-expanded', 'true')
    await expect(toggle(page, l3)).toHaveAttribute('aria-expanded', 'false')
    await expect(page.locator('tr[data-kind="reservation"]')).toHaveCount(3)
    // The words of the coverage chip are the ones the line has always had.
    await expect(cell(lineRow(page, l1), 'status')).toContainText('Reserved Qty: 3/3')
    await expect(cell(lineRow(page, l2), 'status')).toContainText('Reserved Qty: 3/4')
    await expect(cell(lineRow(page, l3), 'status')).toContainText('Reserved Qty: 0/2')

    // A supplier order that arrives after the day asked for: the reservation on it says so, on its own row while the line is open.
    const late = page.locator(`tr[data-kind="reservation"][data-root-id="l:${l2}"]`).filter({ hasText: 'Late' })
    await expect(late).toHaveCount(1)
    await expect(cell(lineRow(page, l2), 'status')).not.toContainText('Late')

    // Fold the line: its reservations go, its figures stay on its row, and so does what is wrong below it.
    await toggle(page, l2).click()
    await expect(toggle(page, l2)).toHaveAttribute('aria-expanded', 'false')
    await expect(rowsUnder(page, l2)).toHaveCount(1)
    await expect(page.locator('tr[data-kind="reservation"]')).toHaveCount(1)
    await expect(cell(lineRow(page, l2), 'reserved')).toHaveText('3')
    await expect(cell(lineRow(page, l2), 'free')).toHaveText('1')
    await expect(cell(lineRow(page, l2), 'status')).toContainText('Reserved Qty: 3/4')
    await expect(cell(lineRow(page, l2), 'status')).toContainText('Late')
    // Open again: the flag goes back to the reservation it belongs to.
    await toggle(page, l2).click()
    await expect(cell(lineRow(page, l2), 'status')).not.toContainText('Late')

    // Collapse all, Expand all (FR-28.42).
    await page.getByTestId('tree-collapse-all').click()
    await expect(page.locator('[data-testid="tree-toggle"][aria-expanded="true"]')).toHaveCount(0)
    await expect(page.locator('tr[data-kind="reservation"]')).toHaveCount(0)
    await page.getByTestId('tree-expand-all').click()
    await expect(page.locator('[data-testid="tree-toggle"][aria-expanded="false"]')).toHaveCount(0)
    await expect(page.locator('tr[data-kind="reservation"]')).toHaveCount(3)

    // One set of figures: the Totals row, the Totals card and the folded card's summary say the same.
    const totals = page.getByTestId('tree-totals')
    await expect(cell(totals, 'qty')).toHaveText('9')
    await expect(cell(totals, 'reserved')).toHaveText('6')
    await expect(cell(totals, 'free')).toHaveText('3')
    const lines = page.getByTestId('internal-order-lines')
    await lines.getByTestId('panel-toggle').click()
    await expect(lines.getByTestId('panel-summary')).toHaveText('3 lines · 9 needed · 6 reserved')
  })

  test('+ Reserve from stock opens the cover dialog for that line only; reserving is immediate; a reservation is released from its row', async ({ page }) => {
    const api = await session()
    const w = await world(api)
    const ordi = await customerOrder(api, w, [{ product: 'p1', qty: 5 }, { product: 'p2', qty: 4 }])
    const [l1, l2] = ordi.lines.map((l: any) => String(l._id))
    await open(page, ordi)

    await cell(lineRow(page, l1), 'actions').getByTestId('tree-reserve').click()
    await page.getByTestId('tree-reserve-stock').click()
    const dialog = coverDialog(page)
    // The dialog the toolbox opens for the whole order, filtered to the line, and to the source asked for.
    await expect(dialog.getByTestId('cover-line')).toHaveCount(1)
    await expect(dialog.getByTestId('cover-line')).toContainText(w.p1.name)
    await expect(dialog).toContainText('Free stock')
    await expect(dialog).not.toContainText('Expected (supplier orders)')
    await expect(dialog).not.toContainText('Reservations of lower-priority orders')
    await dialog.getByRole('button', { name: 'Reserve', exact: true }).click()
    await expect(page.getByText('Saved successfully').first()).toBeVisible()
    await dialog.getByRole('button', { name: 'Close' }).click()
    await expect(dialog).toBeHidden()

    // At once, with no Save: the line says so and shows the reservation under it, which opened by itself.
    await expect(cell(lineRow(page, l1), 'status')).toContainText('Reserved Qty: 5/5')
    await expect(rowsUnder(page, l1)).toHaveCount(2)
    await expect(cell(lineRow(page, l2), 'status')).toContainText('Reserved Qty: 0/4')
    await expect(page.getByRole('button', { name: /^save$/i }).first()).toBeVisible()

    // Released from its own row, in the same dialog as everywhere: the row stays, as Cancelled, and can be made again.
    await page.locator('tr[data-kind="reservation"]').getByTestId('tree-release').click()
    const release = page.getByTestId('reservation-release')
    await expect(release).toBeVisible()
    await release.getByRole('button', { name: 'Release the reservation' }).click()
    await expect(cell(lineRow(page, l1), 'status')).toContainText('Reserved Qty: 0/5')
    const row = page.locator('tr[data-kind="reservation"]')
    await expect(row).toContainText('Cancelled')
    await expect(row.getByTestId('tree-reserveAgain')).toBeVisible()
    await expect(row.getByTestId('tree-release')).toHaveCount(0)
  })

  test('a quantity edited below what is held says so on the line, open or folded, and nothing is short', async ({ page }) => {
    const api = await session()
    const w = await world(api)
    const ordi = await customerOrder(api, w, [{ product: 'p1', qty: 5 }])
    const [l1] = ordi.lines.map((l: any) => String(l._id))
    await reserveFromStock(api, w, ordi, 0, 3)
    await open(page, ordi)

    const status = cell(lineRow(page, l1), 'status')
    await expect(status).toContainText('Reserved Qty: 3/5')
    await expect(status).not.toContainText('Over-reserved')
    await expect(cell(lineRow(page, l1), 'free')).toHaveText('2')
    // 2 needed, 3 held: a save would be refused, and the line says so before it is asked to.
    await lineRow(page, l1).getByRole('spinbutton', { name: 'Qty' }).fill('2')
    await expect(status).toContainText('Over-reserved')
    await expect(cell(lineRow(page, l1), 'free')).toHaveText('0')
    await toggle(page, l1).click()
    await expect(toggle(page, l1)).toHaveAttribute('aria-expanded', 'false')
    await expect(status).toContainText('Over-reserved')
    // The figures are the form's as it stands: the Totals say 2 needed, 3 reserved.
    await expect(cell(page.getByTestId('tree-totals'), 'qty')).toHaveText('2')
    await expect(cell(page.getByTestId('tree-totals'), 'reserved')).toHaveText('3')
  })

  test('a line with nothing reserved shows its placeholder with the same + Reserve, and generates a supplier order for that line only', async ({ page }) => {
    const api = await session()
    const w = await world(api, 0)
    const ordi = await customerOrder(api, w, [{ product: 'p1', qty: 5 }, { product: 'p2', qty: 4 }])
    const [l1] = ordi.lines.map((l: any) => String(l._id))
    await open(page, ordi)

    // Closed, because there is nothing under it but the placeholder.
    await expect(toggle(page, l1)).toHaveAttribute('aria-expanded', 'false')
    await expect(page.locator('tr[data-kind="placeholder"]')).toHaveCount(0)
    await toggle(page, l1).click()
    const placeholder = page.locator(`tr[data-kind="placeholder"][data-root-id="l:${l1}"]`)
    await expect(placeholder).toContainText('Nothing reserved yet')
    await placeholder.getByTestId('tree-reserve').click()
    await page.getByTestId('tree-reserve-generate').click()
    const dialog = generateDialog(page)
    await expect(dialog).toBeVisible()
    await expect(dialog.getByRole('spinbutton', { name: 'Qty' })).toHaveCount(1)
    await expect(dialog).toContainText(w.p1.name)
    await expect(dialog).not.toContainText(w.p2.name)
    await dialog.getByRole('button', { name: 'Cancel' }).click()
    await expect(dialog).toBeHidden()

    // The toolbox, which acts on the whole order, still offers every short line.
    await page.getByTestId('internal-order-reservations').getByRole('button', { name: 'Generate supplier order' }).click()
    await expect(generateDialog(page).getByRole('spinbutton', { name: 'Qty' })).toHaveCount(2)
  })

  test('+ Reserve from a supplier order opens the same dialog on its other source, and says when there is none', async ({ page }) => {
    const api = await session()
    const w = await world(api, 0)
    const ordi = await customerOrder(api, w, [{ product: 'p1', qty: 5 }])
    const [l1] = ordi.lines.map((l: any) => String(l._id))
    await open(page, ordi)

    await cell(lineRow(page, l1), 'actions').getByTestId('tree-reserve').click()
    await page.getByTestId('tree-reserve-order').click()
    const dialog = coverDialog(page)
    await expect(dialog.getByTestId('cover-line')).toHaveCount(1)
    await expect(dialog).toContainText('No supplier order has room for this line.')
    await expect(dialog).not.toContainText('Free stock')
  })

  test('the ORDO on a reservation links to the line it is on, and the supplier order opens there', async ({ page }) => {
    const api = await session()
    const w = await world(api)
    const ordi = await customerOrder(api, w, [{ product: 'p2', qty: 4 }])
    const supply = await reserveFromSupplier(api, w, ordi, 0, 3)
    await open(page, ordi)

    const link = page.getByTestId('order-tree').getByRole('link', { name: supply.order.orderNumber })
    await expect(link).toHaveAttribute('href', new RegExp(`/invoicing/orders/${supply.order._id}/edit\\?line=${supply.supplierLine._id}&allocation=${supply.allocation._id}$`))
    await link.click()
    await page.waitForURL(new RegExp(`/invoicing/orders/${supply.order._id}/edit`))
    // FR-28.46 on the supplier order: the warehouse the goods come into is marked.
    await expect(page.locator(`tr.order-tree__row--hit[data-node-id="a:${supply.allocation._id}"]`)).toHaveCount(1)
  })
})

test.describe('What is open is kept, and a link can name a line (FR-28.43, FR-28.46)', () => {
  test('the cards keep their state across a reload; the Reservations card starts closed', async ({ page }) => {
    const api = await session()
    const w = await world(api)
    const ordi = await customerOrder(api, w, [{ product: 'p1', qty: 3 }])
    const res = await reserveFromStock(api, w, ordi, 0, 3)
    await open(page, ordi)

    const lines = page.getByTestId('internal-order-lines')
    const reservations = page.getByTestId('internal-order-reservations')
    await expect(lines.getByTestId('panel-toggle')).toHaveAttribute('aria-expanded', 'true')
    await expect(reservations.getByTestId('panel-toggle')).toHaveAttribute('aria-expanded', 'false')
    // The tree shows the reservation, so the flat card that repeats it is not in the way.
    await expect(reservations.getByTestId('panel-body')).toBeHidden()

    await reservations.getByTestId('panel-toggle').click()
    await expect(reservations.getByRole('link', { name: res.reservationNumber })).toBeVisible()
    await lines.getByTestId('panel-toggle').click()
    await expect(lines.getByTestId('panel-body')).toBeHidden()

    await page.reload()
    await expect(page.locator('.form-paper-header').getByText(ordi.orderNumber)).toBeVisible({ timeout: 15000 })
    await expect(page.getByTestId('internal-order-lines').getByTestId('panel-toggle')).toHaveAttribute('aria-expanded', 'false')
    await expect(page.getByTestId('internal-order-reservations').getByTestId('panel-toggle')).toHaveAttribute('aria-expanded', 'true')
    // And the folded card still says what it holds.
    await expect(page.getByTestId('internal-order-lines').getByTestId('panel-summary')).toHaveText('1 line · 3 needed · 3 reserved')
  })

  test('?line= opens the line, scrolls to it and marks it for a moment; an id that matches nothing opens the form as usual', async ({ page }) => {
    const api = await session()
    const w = await world(api)
    const ordi = await customerOrder(api, w, [{ product: 'p1', qty: 3 }, { product: 'p2', qty: 4 }, { product: 'p3', qty: 2 }])
    await reserveFromStock(api, w, ordi, 0, 3)
    const [, , l3] = ordi.lines.map((l: any) => String(l._id))

    await open(page, ordi, `?line=${l3}`)
    // l3 holds nothing, so it was closed: the link opens it and marks it.
    await expect(toggle(page, l3)).toHaveAttribute('aria-expanded', 'true')
    await expect(page.locator('tr.order-tree__row--hit')).toHaveCount(1)
    await expect(page.locator('tr.order-tree__row--hit')).toHaveAttribute('data-node-id', `l:${l3}`)
    await expect(lineRow(page, l3)).toBeInViewport()
    // A moment: the mark goes.
    await expect(page.locator('tr.order-tree__row--hit')).toHaveCount(0, { timeout: 6000 })

    // The card was folded by the user: the link opens it too.
    const lines = page.getByTestId('internal-order-lines')
    await lines.getByTestId('panel-toggle').click()
    await expect(lines.getByTestId('panel-body')).toBeHidden()
    await page.goto(`/invoicing/internal-orders/${ordi._id}/edit?line=${l3}`)
    await expect(page.locator('.form-paper-header').getByText(ordi.orderNumber)).toBeVisible({ timeout: 15000 })
    await expect(page.getByTestId('internal-order-lines').getByTestId('panel-body')).toBeVisible()
    await expect(page.locator('tr.order-tree__row--hit')).toHaveCount(1)

    // An id that matches nothing: the form as usual, nothing opened, nothing marked.
    await page.goto(`/invoicing/internal-orders/${ordi._id}/edit?line=000000000000000000000000`)
    await expect(page.locator('.form-paper-header').getByText(ordi.orderNumber)).toBeVisible({ timeout: 15000 })
    await expect(page.getByTestId('tree-row').first()).toBeVisible()
    await expect(toggle(page, l3)).toHaveAttribute('aria-expanded', 'false')
    await expect(page.locator('tr.order-tree__row--hit')).toHaveCount(0)
  })
})

test.describe('The keyboard (FR-28.47)', () => {
  test('the arrows move between the lines and fold them; + Reserve is a button with a menu that opens with Enter and closes with Escape', async ({ page }) => {
    const api = await session()
    const w = await world(api)
    const ordi = await customerOrder(api, w, [{ product: 'p1', qty: 3 }, { product: 'p2', qty: 4 }])
    await reserveFromStock(api, w, ordi, 0, 3)
    await reserveFromStock(api, w, ordi, 1, 2)
    const [l1, l2] = ordi.lines.map((l: any) => String(l._id))
    await open(page, ordi)

    await toggle(page, l1).focus()
    await page.keyboard.press('ArrowLeft')
    await expect(toggle(page, l1)).toHaveAttribute('aria-expanded', 'false')
    await page.keyboard.press('ArrowRight')
    await expect(toggle(page, l1)).toHaveAttribute('aria-expanded', 'true')
    // Down goes to the next row that has a toggle: the reservation under the line has none, so the next LINE.
    await page.keyboard.press('ArrowDown')
    await expect(toggle(page, l2)).toBeFocused()

    const reserve = cell(lineRow(page, l2), 'actions').getByTestId('tree-reserve')
    await reserve.focus()
    await page.keyboard.press('Enter')
    await expect(page.getByTestId('tree-reserve-stock')).toBeVisible()
    await expect(page.getByTestId('tree-reserve-order')).toBeVisible()
    await expect(page.getByTestId('tree-reserve-generate')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('tree-reserve-stock')).toBeHidden()
  })
})

test.describe('A quantity and a price are read whole (a line of 12,500 at 9,999.99)', () => {
  /** The right panel (notes and activity) starts folded; the user who keeps it open has it open before the page loads. */
  const panel = (page: any, open: boolean) => page.addInitScript((v: string) => localStorage.setItem('lgr:entity-form-sidebar:collapsed', v), String(!open))

  /** Every number field of the tree: what is typed in it, and whether the field shows all of it. */
  async function numbers(page: any) {
    return page.evaluate(() => [...document.querySelectorAll('[data-testid="order-tree"] input[type="number"]')].map((i) => {
      const input = i as HTMLInputElement
      return { label: input.getAttribute('aria-label'), value: input.value, scroll: input.scrollWidth, client: input.clientWidth }
    }))
  }

  for (const [width, panelOpen] of [[1366, true], [1366, false], [1920, true], [1920, false]] as const) {
    test(`${width} px, right panel ${panelOpen ? 'open' : 'folded'}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 800 })
      await panel(page, panelOpen)
      const api = await session()
      const w = await world(api, 0)
      const ordi = await customerOrder(api, w, [{ product: 'p1', qty: 12500, price: 9999.99 }, { product: 'p2', qty: 99999, price: 1234.5 }])
      await open(page, ordi)

      const fields = await numbers(page)
      // Both lines' quantity and price, and the blank line waiting for an article (its quantity starts at 0).
      const typed = fields.filter((f: any) => f.value !== '')
      expect(typed.map((f: any) => f.value)).toEqual(expect.arrayContaining(['12500', '9999.99', '99999', '1234.5']))
      for (const f of fields) expect(f.scroll, `${f.label} = ${f.value} is cut short in a field ${f.client}px wide`).toBeLessThanOrEqual(f.client + 1)

      // And the table needs no sideways scroll to show them (the status and the actions are at its far edge).
      const g = await page.evaluate(() => {
        const wrap = document.querySelector('[data-testid="order-tree"] .v-table__wrapper') as HTMLElement
        return { client: wrap.clientWidth, scroll: wrap.scrollWidth }
      })
      expect(g.scroll, 'the table scrolls sideways').toBeLessThanOrEqual(g.client + 1)
    })
  }
})
