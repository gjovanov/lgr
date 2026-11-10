import { test, expect } from '@playwright/test'
import { loginForApp } from './helpers/login'

/**
 * FR-28.37 to .47 — the supplier order's lines, warehouses and client reservations as a tree.
 *
 * One table, one set of columns: a line, under it a row per warehouse, under that a row per client, each
 * parent carrying what its children add up to. What opens by itself is what holds a reservation or needs a
 * look; the user's changes win over that; + Warehouse and + Client are rows (Enter adds, Escape drops) and
 * everything they make is staged until Save, exactly as the dialog they replace staged it.
 *
 * Columns of the table, by position (an order that is saved): item, qty, unit, price, reserved, free,
 * received, invoiced, dispatched, status, actions.
 */

const apiBase = process.env.BASE_URL || 'http://localhost:4001'
const QTY = 1
const RESERVED = 4
const FREE = 5
const STATUS = 9

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

/** Two articles, a supplier, two clients, and two warehouses (the default one, and another). */
async function world(api: Api) {
  const ts = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
  const article = async (n: number) => (await api.call('POST', '/warehouse/product', {
    sku: `E2E-TREE${n}-${ts}`, name: `E2E tree article ${n} ${ts}`, category: 'Test', type: 'goods', unit: 'pcs', sellingPrice: 3, purchasePrice: 1, taxRate: 20,
  })).product
  const [p1, p2] = [await article(1), await article(2)]
  const contact = async (type: string, name: string) => (await api.call('POST', '/invoicing/contact', { type, companyName: `E2E tree ${name} ${ts}` })).contact
  const supplier = await contact('supplier', 'supplier')
  const clientA = await contact('customer', 'client A')
  const clientB = await contact('customer', 'client B')
  const warehouses = (await api.call('GET', '/warehouse/warehouse?size=100')).warehouses || []
  const main = warehouses.find((w: any) => w.isDefault) || warehouses[0]
  const other = warehouses.find((w: any) => String(w._id) !== String(main._id))
  return { ts, p1, p2, supplier, clientA, clientB, main, other }
}
type World = Awaited<ReturnType<typeof world>>

interface LineSpec { product: 'p1' | 'p2'; qty: number; allocations: Array<{ wh: 'main' | 'other'; qty: number; holds?: Array<{ client: 'A' | 'B'; qty: number }> }> }

/**
 * A supplier order of the lines given (sent, so reservations can be held on it), with the reservations made.
 * `send: false` leaves it a draft: the server will not send an order whose allocations exceed what is ordered.
 */
async function sentOrder(api: Api, w: World, lines: LineSpec[], opts: { send?: boolean } = {}) {
  const wh = (k: 'main' | 'other') => (k === 'main' ? w.main : w.other)._id
  const { order } = await api.call('POST', '/invoicing/orders', {
    issueDate: new Date().toISOString().slice(0, 10), expectedDate: '2026-12-01', currency: 'EUR', tags: [],
    supplierGroups: [{
      supplierId: w.supplier._id || w.supplier.id,
      lines: lines.map((l) => ({
        productId: w[l.product]._id || w[l.product].id, description: w[l.product].name, quantity: l.qty, unit: 'pcs',
        allocations: l.allocations.map((a) => ({ warehouseId: wh(a.wh), quantity: a.qty })),
      })),
    }],
  })
  const sent = opts.send === false ? order : (await api.call('POST', `/invoicing/orders/${order._id}/send`)).order
  const group = sent.supplierGroups[0]
  const numbers: string[][][] = []
  for (const [li, spec] of lines.entries()) {
    numbers[li] = []
    for (const [ai, a] of spec.allocations.entries()) {
      numbers[li][ai] = []
      for (const h of a.holds || []) {
        const l = group.lines[li]
        const { reservation } = await api.call('POST', '/invoicing/reservations', {
          source: 'order', productId: l.productId, quantity: h.qty, contactId: (h.client === 'A' ? w.clientA : w.clientB)._id,
          orderId: sent._id, groupId: group._id, lineId: l._id, allocationId: l.allocations[ai]._id,
        })
        numbers[li][ai].push(reservation.reservationNumber)
      }
    }
  }
  const full = (await api.call('GET', `/invoicing/orders/${sent._id}`))
  return { order: full.order, group: full.order.supplierGroups[0], numbers }
}

async function open(page: any, order: any, query = '') {
  await loginForApp(page)
  await page.goto(`/invoicing/orders/${order._id}/edit${query}`)
  await expect(page.locator('.form-paper-header').getByText(order.orderNumber)).toBeVisible({ timeout: 15000 })
  await expect(page.getByTestId('tree-row').first()).toBeVisible()
}

const lineRow = (page: any, lineId: string) => page.locator(`tr[data-kind="line"][data-root-id="l:${lineId}"]`)
const rowsUnder = (page: any, lineId: string) => page.locator(`tr[data-root-id="l:${lineId}"]`)
const warehouseRows = (page: any, lineId: string) => page.locator(`tr[data-kind="allocation"][data-root-id="l:${lineId}"]`)
const cell = (row: any, col: number) => row.locator('td').nth(col)
const totalsCard = (page: any, label: string) => page.getByText(label, { exact: true }).locator('xpath=following-sibling::span').first()

test.describe('What is open', () => {
  test('a line with live reservations opens by itself, with the warehouses that hold them; one with none stays closed', async ({ page }) => {
    const api = await session()
    const w = await world(api)
    const { order, group } = await sentOrder(api, w, [
      { product: 'p1', qty: 100, allocations: [{ wh: 'main', qty: 70, holds: [{ client: 'A', qty: 25 }, { client: 'B', qty: 15 }] }, { wh: 'other', qty: 30 }] },
      { product: 'p2', qty: 10, allocations: [{ wh: 'main', qty: 10 }] },
    ])
    await open(page, order)
    const [held, empty] = group.lines.map((l: any) => l._id)

    // The line that holds reservations is open, and so is the warehouse that holds them; the other warehouse is not.
    await expect(lineRow(page, held).getByTestId('tree-toggle')).toHaveAttribute('aria-expanded', 'true')
    await expect(warehouseRows(page, held)).toHaveCount(2)
    await expect(warehouseRows(page, held).nth(0).getByTestId('tree-toggle')).toHaveAttribute('aria-expanded', 'true')
    await expect(warehouseRows(page, held).nth(1).getByTestId('tree-toggle')).toHaveAttribute('aria-expanded', 'false')
    await expect(rowsUnder(page, held).filter({ hasText: `E2E tree client A ${w.ts}` })).toHaveCount(1)
    await expect(rowsUnder(page, held).filter({ hasText: `E2E tree client B ${w.ts}` })).toHaveCount(1)

    // The line with none is just its row, its toggle closed.
    await expect(lineRow(page, empty).getByTestId('tree-toggle')).toHaveAttribute('aria-expanded', 'false')
    await expect(rowsUnder(page, empty)).toHaveCount(1)
  })

  test('an empty parent has a row of its own, with its +', async ({ page }) => {
    const api = await session()
    const w = await world(api)
    const { order, group } = await sentOrder(api, w, [
      { product: 'p1', qty: 10, allocations: [] },
      { product: 'p2', qty: 10, allocations: [{ wh: 'main', qty: 10 }] },
    ])
    await open(page, order)
    const [noWarehouse, noClient] = group.lines.map((l: any) => l._id)

    await lineRow(page, noWarehouse).getByTestId('tree-toggle').click()
    const placeholder = rowsUnder(page, noWarehouse).filter({ hasText: 'No warehouse yet' })
    await expect(placeholder).toHaveCount(1)
    await expect(placeholder.getByTestId('tree-addWarehouse')).toBeVisible()

    await lineRow(page, noClient).getByTestId('tree-toggle').click()
    await warehouseRows(page, noClient).first().getByTestId('tree-toggle').click()
    const none = rowsUnder(page, noClient).filter({ hasText: 'No client reservations' })
    await expect(none).toHaveCount(1)
    await expect(none.getByTestId('tree-addClient')).toBeVisible()
  })

  test('what the user closes stays closed, and a closed parent still says what needs a look', async ({ page }) => {
    const api = await session()
    const w = await world(api)
    // The server will not create or send an order that allocates more than it orders, so it is made in the form.
    const { order, group } = await sentOrder(api, w, [
      { product: 'p1', qty: 100, allocations: [{ wh: 'main', qty: 70 }, { wh: 'other', qty: 30 }] },
    ], { send: false })
    await open(page, order)
    const line = group.lines[0]._id

    await lineRow(page, line).getByTestId('tree-toggle').click()
    await warehouseRows(page, line).nth(1).getByRole('spinbutton').fill('40')
    await expect(cell(lineRow(page, line), STATUS)).toContainText('Over-allocated')
    // Closed, the line still says so: what needs a look is never hidden by folding it.
    await lineRow(page, line).getByTestId('tree-toggle').click()
    await expect(rowsUnder(page, line)).toHaveCount(1)
    await expect(cell(lineRow(page, line), STATUS)).toContainText('Over-allocated')
  })
})

test.describe('One set of figures', () => {
  const LINES: LineSpec[] = [
    { product: 'p1', qty: 100, allocations: [{ wh: 'main', qty: 70, holds: [{ client: 'A', qty: 25 }, { client: 'B', qty: 15 }] }, { wh: 'other', qty: 30, holds: [{ client: 'A', qty: 20 }] }] },
    { product: 'p2', qty: 200, allocations: [{ wh: 'main', qty: 150, holds: [{ client: 'B', qty: 25 }] }] },
  ]

  test('a parent is what its children add up to, and the summary, the totals row and the Totals card agree', async ({ page }) => {
    const api = await session()
    const w = await world(api)
    const { order, group } = await sentOrder(api, w, LINES)
    await open(page, order)
    const [l1, l2] = group.lines.map((l: any) => l._id)

    // Reserved and Free, at every level of the first line.
    await expect(cell(lineRow(page, l1), RESERVED)).toHaveText('60')
    await expect(cell(warehouseRows(page, l1).nth(0), RESERVED)).toHaveText('40')
    await expect(cell(warehouseRows(page, l1).nth(0), FREE)).toHaveText('30')
    await expect(cell(warehouseRows(page, l1).nth(1), RESERVED)).toHaveText('20')
    await expect(cell(warehouseRows(page, l1).nth(1), FREE)).toHaveText('10')
    await expect(cell(lineRow(page, l2), RESERVED)).toHaveText('25')
    await expect(cell(lineRow(page, l2), FREE)).toHaveText('50') // 200 ordered, 150 allocated

    // The supplier's totals row, the Totals card and the folded summary say the same.
    const totals = page.getByTestId('tree-totals')
    await expect(cell(totals, QTY)).toHaveText('300')
    await expect(cell(totals, RESERVED)).toHaveText('85')
    await expect(totalsCard(page, 'Ordered Qty')).toHaveText('300')
    await expect(totalsCard(page, 'Reserved Qty')).toHaveText('85')
    const card = page.getByTestId('order-group').first()
    await card.getByTestId('panel-toggle').click()
    await expect(card.getByTestId('panel-summary')).toHaveText('2 lines · 300 ordered · 85 reserved')
  })

  test('a reservation staged on the form counts at once on its warehouse, its line, the summary and the Totals card', async ({ page }) => {
    const api = await session()
    const w = await world(api)
    const { order, group } = await sentOrder(api, w, LINES)
    await open(page, order)
    const l1 = group.lines[0]._id
    const second = warehouseRows(page, l1).nth(1)

    await second.getByTestId('tree-addClient').click()
    await page.locator('[data-tree-editor]').getByRole('combobox', { name: /customer/i }).pressSequentially(`E2E tree client B ${w.ts}`, { delay: 25 })
    await page.getByRole('option', { name: new RegExp(`E2E tree client B ${w.ts}`) }).click()
    await page.locator('[data-tree-editor-qty] input').fill('6')
    await page.keyboard.press('Enter')

    // 20 + 6 on the warehouse, 66 on the line, 91 in all: the Totals card used to say 85 until Save.
    await expect(cell(second, RESERVED)).toHaveText('26')
    await expect(cell(second, FREE)).toHaveText('4')
    await expect(cell(lineRow(page, l1), RESERVED)).toHaveText('66')
    await expect(cell(page.getByTestId('tree-totals'), RESERVED)).toHaveText('91')
    await expect(totalsCard(page, 'Reserved Qty')).toHaveText('91')
    // Nothing is sent before Save.
    expect((await api.call('GET', `/invoicing/orders/${order._id}`)).reservations.filter((r: any) => r.status === 'active')).toHaveLength(4)
  })
})

test.describe('+ Warehouse and + Client are rows', () => {
  test('a warehouse row starts at what is left, Escape drops it, Enter adds it, and Save sends it', async ({ page }) => {
    const api = await session()
    const w = await world(api)
    const { order, group } = await sentOrder(api, w, [{ product: 'p1', qty: 20, allocations: [{ wh: 'main', qty: 12 }] }])
    await open(page, order)
    const line = group.lines[0]._id

    await lineRow(page, line).getByTestId('tree-addWarehouse').click()
    const editor = page.locator('[data-tree-editor]')
    await expect(editor).toBeVisible()
    // The list is open and the cursor is in the field.
    await expect(editor.locator('input').first()).toBeFocused()
    await expect(page.getByRole('option').first()).toBeVisible()
    await expect(page.locator('[data-tree-editor-qty] input')).toHaveValue('8')

    // Escape closes the open list first, and the next one drops the row.
    await page.keyboard.press('Escape')
    await expect(editor).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(editor).toHaveCount(0)
    await expect(warehouseRows(page, line)).toHaveCount(1)

    // Again, this time added: picked from the list, Enter on the quantity.
    await lineRow(page, line).getByTestId('tree-addWarehouse').click()
    await page.getByRole('option', { name: w.other.name }).click()
    await expect(page.locator('[data-tree-editor-qty] input')).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(editor).toHaveCount(0)
    await expect(warehouseRows(page, line)).toHaveCount(2)
    await expect(cell(lineRow(page, line), FREE)).toHaveText('0')

    // Staged: the order on the server still has one warehouse, until Save.
    expect((await api.call('GET', `/invoicing/orders/${order._id}`)).order.supplierGroups[0].lines[0].allocations).toHaveLength(1)
    await page.getByRole('button', { name: /^save$/i }).first().click()
    await expect.poll(async () => (await api.call('GET', `/invoicing/orders/${order._id}`)).order.supplierGroups[0].lines[0].allocations.map((a: any) => a.quantity)).toEqual([12, 8])
  })

  test('Enter in an open list picks from it and nothing more; the next Enter adds the row', async ({ page }) => {
    const api = await session()
    const w = await world(api)
    const { order, group } = await sentOrder(api, w, [{ product: 'p1', qty: 20, allocations: [{ wh: 'main', qty: 12 }] }])
    await open(page, order)
    const line = group.lines[0]._id
    const editor = page.locator('[data-tree-editor]')

    await lineRow(page, line).getByTestId('tree-addWarehouse').click()
    await editor.locator('input').first().pressSequentially(w.other.name, { delay: 20 })
    // The list is open: this Enter is its own, it picks the highlighted warehouse. It must not also add the
    // row, with the quantity it started at.
    await page.keyboard.press('Enter')
    await expect(editor).toBeVisible()
    await expect(page.locator('[data-tree-editor-qty] input')).toBeFocused()
    await expect(warehouseRows(page, line)).toHaveCount(1)
    // Now the cursor is in the quantity and no list is open: this one adds it.
    await page.keyboard.press('Enter')
    await expect(editor).toHaveCount(0)
    await expect(warehouseRows(page, line)).toHaveCount(2)
  })

  test('the row says what is wrong with it, beside the field, and adds nothing until it is right', async ({ page }) => {
    const api = await session()
    const w = await world(api)
    const { order, group } = await sentOrder(api, w, [{ product: 'p1', qty: 20, allocations: [{ wh: 'main', qty: 12, holds: [{ client: 'A', qty: 9 }] }] }])
    await open(page, order)
    const line = group.lines[0]._id
    const editor = page.locator('[data-tree-editor]')
    const add = page.getByTestId('tree-add')

    // A warehouse: none chosen, no quantity, more than the line has left.
    await lineRow(page, line).getByTestId('tree-addWarehouse').click()
    await add.click()
    await expect(page.getByText('Choose a warehouse')).toBeVisible()
    // Pressing Add closed the list: open it again to choose.
    await editor.locator('.v-field').first().click()
    await page.getByRole('option', { name: w.other.name }).click()
    await page.locator('[data-tree-editor-qty] input').fill('0')
    await add.click()
    await expect(page.getByText('The quantity must be above zero')).toBeVisible()
    await page.locator('[data-tree-editor-qty] input').fill('100')
    await add.click()
    await expect(page.getByText('Allocations exceed the ordered quantity')).toBeVisible()
    await expect(warehouseRows(page, line)).toHaveCount(1)
    await page.getByTestId('tree-add-cancel').click()
    await expect(editor).toHaveCount(0)

    // A client: none chosen, more than the warehouse has free (12 − 9 = 3).
    await warehouseRows(page, line).first().getByTestId('tree-addClient').click()
    await add.click()
    await expect(page.getByText('Choose a client')).toBeVisible()
    await editor.locator('.v-field').first().click()
    await page.getByRole('option', { name: new RegExp(`E2E tree client B ${w.ts}`) }).click()
    await expect(page.locator('[data-tree-editor-qty] input')).toHaveValue('3')
    await page.locator('[data-tree-editor-qty] input').fill('4')
    await add.click()
    await expect(page.getByText('More than is free here (3)')).toBeVisible()
    // Nothing was added: the one reservation there was is still the only one (the row being added shows the chosen client, so count rows of reservations).
    await expect(page.locator(`tr[data-kind="reservation"][data-root-id="l:${line}"]`)).toHaveCount(1)
  })

  test('a client row is staged: new, counted, unsaved over a closed parent, and saved with the order', async ({ page }) => {
    const api = await session()
    const w = await world(api)
    const { order, group } = await sentOrder(api, w, [{ product: 'p1', qty: 10, allocations: [{ wh: 'main', qty: 10 }] }])
    await open(page, order)
    const line = group.lines[0]._id
    await lineRow(page, line).getByTestId('tree-toggle').click()

    await warehouseRows(page, line).first().getByTestId('tree-addClient').click()
    await page.getByRole('option', { name: new RegExp(`E2E tree client A ${w.ts}`) }).click()
    await expect(page.locator('[data-tree-editor-qty] input')).toHaveValue('10')
    await page.locator('[data-tree-editor-qty] input').fill('4')
    await page.keyboard.press('Enter')

    const client = rowsUnder(page, line).filter({ hasText: `E2E tree client A ${w.ts}` })
    await expect(client).toHaveCount(1)
    await expect(cell(client, STATUS)).toContainText('new')
    // Only the Reservations card says „unsaved changes"; a closed parent says „unsaved" and nothing more.
    await expect(page.getByText('unsaved changes')).toHaveCount(1)
    await lineRow(page, line).getByTestId('tree-toggle').click()
    await expect(cell(lineRow(page, line), STATUS)).toContainText('unsaved')
    await lineRow(page, line).getByTestId('tree-toggle').click()
    // The warehouse with a reservation staged on it has nothing free for another one.
    await expect(cell(warehouseRows(page, line).first(), FREE)).toHaveText('6')

    await page.getByRole('button', { name: /^save$/i }).first().click()
    await expect.poll(async () => (await api.call('GET', `/invoicing/orders/${order._id}`)).reservations.filter((r: any) => r.status === 'active').map((r: any) => r.quantity)).toEqual([4])
    await expect(page.getByText('unsaved changes')).toHaveCount(0)
    // The saved reservation has a number and a link where the staged one had „new".
    await expect(rowsUnder(page, line).filter({ hasText: /RES-/ })).toHaveCount(1)
  })

  test('a warehouse with nothing free offers no + Client', async ({ page }) => {
    const api = await session()
    const w = await world(api)
    const { order, group } = await sentOrder(api, w, [{ product: 'p1', qty: 10, allocations: [{ wh: 'main', qty: 10, holds: [{ client: 'A', qty: 10 }] }] }])
    await open(page, order)
    await expect(warehouseRows(page, group.lines[0]._id).first().getByTestId('tree-addClient')).toBeDisabled()
  })
})

test.describe('A reservation on the tree', () => {
  test('cancelled on save counts as what is consumed, can be taken back, and is cancelled with the order', async ({ page }) => {
    const api = await session()
    const w = await world(api)
    const { order, group, numbers } = await sentOrder(api, w, [{ product: 'p1', qty: 10, allocations: [{ wh: 'main', qty: 10, holds: [{ client: 'A', qty: 4 }] }] }])
    await open(page, order)
    const line = group.lines[0]._id
    const alloc = warehouseRows(page, line).first()
    const client = rowsUnder(page, line).filter({ hasText: numbers[0][0][0] })
    await expect(cell(alloc, RESERVED)).toHaveText('4')
    await expect(cell(alloc, FREE)).toHaveText('6')

    await client.getByRole('button', { name: 'Cancel reservation' }).click()
    await expect(cell(client, STATUS)).toContainText('cancelled on save')
    await expect(cell(alloc, RESERVED)).toHaveText('0')
    await expect(cell(alloc, FREE)).toHaveText('10')
    await expect(page.getByText('unsaved changes')).toHaveCount(1)

    // Taken back.
    await client.getByTestId('tree-undo').click()
    await expect(cell(client, STATUS)).toContainText('Active')
    await expect(cell(alloc, RESERVED)).toHaveText('4')
    await expect(page.getByText('unsaved changes')).toHaveCount(0)

    // Cancelled with the order.
    await client.getByRole('button', { name: 'Cancel reservation' }).click()
    await page.getByRole('button', { name: /^save$/i }).first().click()
    await expect.poll(async () => (await api.call('GET', `/invoicing/orders/${order._id}`)).reservations[0].status).toBe('cancelled')
    // A cancelled reservation holds nothing and is not a row: the Reservations card still lists it.
    await expect(rowsUnder(page, line).filter({ hasText: numbers[0][0][0] })).toHaveCount(0)
  })

  test('its quantity is edited in its row, down to what is consumed, and saved with the order', async ({ page }) => {
    const api = await session()
    const w = await world(api)
    const { order, group, numbers } = await sentOrder(api, w, [{ product: 'p1', qty: 10, allocations: [{ wh: 'main', qty: 10, holds: [{ client: 'A', qty: 4 }] }] }])
    await open(page, order)
    const line = group.lines[0]._id
    const client = rowsUnder(page, line).filter({ hasText: numbers[0][0][0] })

    await client.getByRole('spinbutton', { name: new RegExp(numbers[0][0][0]) }).fill('7')
    await expect(cell(client, STATUS)).toContainText('changed')
    await expect(cell(warehouseRows(page, line).first(), RESERVED)).toHaveText('7')
    await page.getByRole('button', { name: /^save$/i }).first().click()
    await expect.poll(async () => (await api.call('GET', `/invoicing/orders/${order._id}`)).reservations[0].quantity).toBe(7)
  })
})

test.describe('Open and closed, across Save', () => {
  test('expand all and collapse all work on one supplier, and a row the user closed is still closed after Save', async ({ page }) => {
    const api = await session()
    const w = await world(api)
    const { order, group } = await sentOrder(api, w, [
      { product: 'p1', qty: 100, allocations: [{ wh: 'main', qty: 70, holds: [{ client: 'A', qty: 25 }] }, { wh: 'other', qty: 30 }] },
      { product: 'p2', qty: 50, allocations: [{ wh: 'main', qty: 50, holds: [{ client: 'B', qty: 10 }] }] },
    ])
    await open(page, order)
    const [l1, l2] = group.lines.map((l: any) => l._id)
    const group0 = page.getByTestId('order-group').first()

    await group0.getByTestId('tree-collapse-all').click()
    await expect(page.getByTestId('tree-row')).toHaveCount(2) // the two lines
    await group0.getByTestId('tree-expand-all').click()
    // Everything below the lines: 2 + 1 warehouse placeholder... (3 warehouses, 2 clients, and the empty one's placeholder)
    await expect(warehouseRows(page, l1)).toHaveCount(2)
    await expect(rowsUnder(page, l1).filter({ hasText: 'No client reservations' })).toHaveCount(1)

    // The user closes the second line; the reload that a save causes does not reopen it.
    await lineRow(page, l2).getByTestId('tree-toggle').click()
    await expect(rowsUnder(page, l2)).toHaveCount(1)
    await page.getByRole('button', { name: /^save$/i }).first().click()
    await expect(page.getByText('Saved successfully').first()).toBeVisible()
    await expect(rowsUnder(page, l2)).toHaveCount(1)
    await expect(lineRow(page, l2).getByTestId('tree-toggle')).toHaveAttribute('aria-expanded', 'false')
    await expect(warehouseRows(page, l1)).toHaveCount(2)
  })
})

test.describe('A link names the line', () => {
  test('opens the card, the line and the warehouse, and marks the warehouse for a moment', async ({ page }) => {
    const api = await session()
    const w = await world(api)
    const { order, group } = await sentOrder(api, w, [{ product: 'p1', qty: 40, allocations: [{ wh: 'main', qty: 20 }, { wh: 'other', qty: 20 }] }])
    const line = group.lines[0]
    const second = line.allocations[1]._id
    await open(page, order, `?line=${line._id}&allocation=${second}`)

    await expect(lineRow(page, line._id).getByTestId('tree-toggle')).toHaveAttribute('aria-expanded', 'true')
    await expect(page.locator(`tr[data-node-id="a:${second}"]`)).toBeVisible()
    await expect(page.locator(`tr[data-node-id="a:${second}"]`)).toHaveClass(/order-tree__row--hit/)
    // The warehouse itself is open: its (empty) placeholder shows.
    await expect(page.locator(`tr[data-node-id="a:${second}"]`).getByTestId('tree-toggle')).toHaveAttribute('aria-expanded', 'true')
  })

  test('an id that matches nothing opens the form as usual', async ({ page }) => {
    const api = await session()
    const w = await world(api)
    const { order, group } = await sentOrder(api, w, [{ product: 'p1', qty: 10, allocations: [{ wh: 'main', qty: 10 }] }])
    await open(page, order, '?line=000000000000000000000000&allocation=000000000000000000000000')
    await expect(lineRow(page, group.lines[0]._id).getByTestId('tree-toggle')).toHaveAttribute('aria-expanded', 'false')
    await expect(page.locator('.v-snackbar')).toHaveCount(0)
  })

  test('the Reservations list and the reservation page link to the line and its warehouse', async ({ page }) => {
    const api = await session()
    const w = await world(api)
    const { order, group, numbers } = await sentOrder(api, w, [{ product: 'p1', qty: 20, allocations: [{ wh: 'main', qty: 10, holds: [{ client: 'A', qty: 4 }] }] }])
    const line = group.lines[0]
    const allocId = line.allocations[0]._id
    const expected = new RegExp(`/orders/${order._id}/edit\\?line=${line._id}&allocation=${allocId}`)

    await loginForApp(page)
    await page.goto(`/invoicing/reservations?q=${encodeURIComponent(numbers[0][0][0])}`)
    const row = page.locator('.v-data-table tbody tr', { hasText: numbers[0][0][0] })
    await expect(row).toBeVisible({ timeout: 15000 })
    await expect(row.getByRole('link', { name: order.orderNumber })).toHaveAttribute('href', expected)
    await row.getByRole('link', { name: order.orderNumber }).click()
    await expect(page.locator(`tr[data-node-id="a:${allocId}"]`)).toHaveClass(/order-tree__row--hit/, { timeout: 15000 })

    // The reservation's own page: the same link.
    const reservationLink = rowsUnder(page, line._id).getByRole('link', { name: numbers[0][0][0] })
    await reservationLink.click()
    await page.waitForURL(/\/reservations\/[0-9a-f]{24}/)
    await expect(page.getByRole('link', { name: order.orderNumber }).first()).toHaveAttribute('href', expected)
  })
})

test.describe('The keyboard', () => {
  test('each toggle is a button that names its row and says whether it is open; arrows move and open and close', async ({ page }) => {
    const api = await session()
    const w = await world(api)
    const { order, group } = await sentOrder(api, w, [{ product: 'p1', qty: 10, allocations: [{ wh: 'main', qty: 10, holds: [{ client: 'A', qty: 4 }] }] }])
    await open(page, order)
    const line = group.lines[0]._id
    const lineToggle = lineRow(page, line).getByTestId('tree-toggle')
    const warehouseToggle = warehouseRows(page, line).first().getByTestId('tree-toggle')

    await expect(lineToggle).toHaveAttribute('aria-expanded', 'true')
    await expect(lineToggle).toHaveAttribute('aria-label', /^Collapse/)
    await expect(warehouseToggle).toHaveAttribute('aria-label', /^Collapse .*/)

    await lineToggle.focus()
    await page.keyboard.press('ArrowDown')
    await expect(warehouseToggle).toBeFocused()
    await page.keyboard.press('ArrowLeft') // closes the warehouse
    await expect(warehouseToggle).toHaveAttribute('aria-expanded', 'false')
    await expect(warehouseToggle).toHaveAttribute('aria-label', /^Expand/)
    await page.keyboard.press('ArrowLeft') // a closed row: up to its parent
    await expect(lineToggle).toBeFocused()
    await page.keyboard.press('ArrowLeft') // closes the line
    await expect(lineToggle).toHaveAttribute('aria-expanded', 'false')
    await page.keyboard.press('ArrowRight') // opens it again
    await expect(lineToggle).toHaveAttribute('aria-expanded', 'true')
    // Enter and Space are a button's own.
    await page.keyboard.press('Enter')
    await expect(lineToggle).toHaveAttribute('aria-expanded', 'false')
  })
})

test.describe('An order that cannot be changed', () => {
  test('offers no + and no editing', async ({ page }) => {
    const api = await session()
    const w = await world(api)
    const { order, group } = await sentOrder(api, w, [{ product: 'p1', qty: 10, allocations: [{ wh: 'main', qty: 10, holds: [{ client: 'A', qty: 4 }] }] }])
    await api.call('POST', `/invoicing/orders/${order._id}/cancel`)
    await open(page, order)
    await expect(page.getByTestId('tree-addWarehouse')).toHaveCount(0)
    await expect(page.getByTestId('tree-addClient')).toHaveCount(0)
    await expect(page.getByTestId('tree-cancel')).toHaveCount(0)
    await expect(lineRow(page, group.lines[0]._id)).toBeVisible()
  })
})
