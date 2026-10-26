import { test, expect } from '@playwright/test'
import { startWalk, uxApi } from '../helpers/ux-budget'

/**
 * P7 — Repeat a reservation. A stock reservation was cancelled by mistake and has to be made
 * again: release it from the Reservations list (the mistake), then put the same hold back the
 * shortest way the UI allows — since #252, „Резервирай отново" on the cancelled row itself.
 *
 * Products used: PRD-0029 (this walk's share of the acme-corp seed). Customer: Rhine Industries.
 */

type Api = Awaited<ReturnType<typeof uxApi>>
type Walk = Awaited<ReturnType<typeof startWalk>>

const CUSTOMER = 'Rhine Industries'
const SKU = 'PRD-0029'
const QTY = 3

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
 * Setup (uncounted): a confirmed internal order for the customer, one line, reserved from stock
 * in the default warehouse — the way „Резервирай от склад" makes it. Earlier runs' orders are
 * cancelled first so their holds do not pile up on the article.
 */
async function reservedOrder(api: Api, product: any, customer: any): Promise<{ ordi: any; res: any }> {
  const { internalOrders } = await api.get(`/invoicing/internal-orders?size=100&status=draft,confirmed`)
  for (const o of internalOrders || []) {
    if (String(o.contactId) !== String(customer._id)) continue
    if (!(o.lines || []).some((l: any) => String(l.productId) === String(product._id))) continue
    await api.post(`/invoicing/internal-orders/${o._id}/cancel`)
  }
  const { warehouses } = await api.get('/warehouse/warehouse?size=100')
  const main = (warehouses || []).find((w: any) => w.isDefault) || warehouses?.[0]
  const today = new Date().toISOString().split('T')[0]
  const { internalOrder } = await api.post('/invoicing/internal-orders', {
    contactId: customer._id,
    issueDate: today,
    requestedDeliveryDate: new Date(Date.now() + 7 * 86400000).toISOString().split('T')[0],
    warehouseId: main._id,
    lines: [{ productId: product._id, description: product.name, sku: product.sku, quantity: QTY, unit: product.unit || 'pcs', expectedUnitPrice: product.sellingPrice }],
  })
  expect(internalOrder?._id, 'internal order created').toBeTruthy()
  const confirmed = await api.post(`/invoicing/internal-orders/${internalOrder._id}/confirm`)
  expect(confirmed.internalOrder?.status).toBe('confirmed')
  const reserved = await api.post(`/invoicing/internal-orders/${internalOrder._id}/reserve-available`, {})
  expect(reserved.created?.length, 'stock reservation created').toBe(1)
  return { ordi: confirmed.internalOrder, res: reserved.created[0] }
}

const snackbar = (walk: Walk, text: string | RegExp) => walk.page.locator('.v-snackbar').filter({ hasText: text })

/** Screenshots wait out Vuetify's dialog/snackbar transitions. */
async function settledShot(walk: Walk, name: string): Promise<void> {
  await walk.page.waitForTimeout(400)
  await walk.shot(name)
}

test('P7 repeat: a reservation cancelled by mistake, made again', async ({ page }, testInfo) => {
  const api = await uxApi()
  const product = await productBySku(api, SKU)
  const customer = await contactByName(api, CUSTOMER)
  const { ordi, res } = await reservedOrder(api, product, customer)
  const original = (await api.get(`/invoicing/reservations/${res._id}`)).reservation

  const walk = await startWalk(page, testInfo, {
    id: 'P7-repeat',
    title: 'Reservations — cancel a stock reservation by mistake, make it again',
    start: '/invoicing/reservations',
  })
  const row = page.locator('tbody tr').filter({ hasText: original.reservationNumber })
  await expect(row).toBeVisible()
  await expect(row).toContainText(CUSTOMER)
  await settledShot(walk, 'reservations-list')
  if (!(await page.getByRole('link', { name: /Създай/ }).count()) && !(await page.getByRole('button', { name: /Създай/ }).count())) {
    walk.note('Reservations list: no Create button — a reservation can only be made from an internal order (Резервирай от склад / Покрий недостига) or an external order\'s allocation (Резервирай за клиент).')
  }

  // ── 1. The mistake: release it ──
  await walk.click(row.getByRole('button', { name: 'Освободи резервацията' }), 'release the reservation (row icon)')
  const confirmDialog = page.locator('.v-overlay--active .v-card').filter({ hasText: original.reservationNumber })
  await expect(confirmDialog).toBeVisible()
  walk.dialog('confirm the release')
  // FR-22.37: two buttons that cannot be confused, and the quantity starts at all of it.
  await expect(confirmDialog.getByRole('spinbutton', { name: 'Количество за освобождаване' })).toHaveValue(String(QTY))
  await settledShot(walk, 'release-confirm')
  const dialogButtons = (await confirmDialog.getByRole('button').allTextContents()).map((t) => t.trim())
  expect(dialogButtons).toEqual(['Не', 'Освободи резервацията'])
  walk.note(`Release dialog buttons: ${dialogButtons.map((b) => `„${b}"`).join(' / ')}; it starts on all ${QTY}, says how many can go and that the reservation is then cancelled (a smaller number releases part of it).`)
  await walk.click(confirmDialog.getByRole('button', { name: 'Освободи резервацията' }), 'confirm: release it')
  await expect(snackbar(walk, `Резервация ${original.reservationNumber} е отказана`)).toBeVisible()
  await expect(row).toContainText('Отказана')
  await expect(row.getByRole('button', { name: 'Освободи резервацията' })).toHaveCount(0)
  await settledShot(walk, 'cancelled')
  const cancelled = (await api.get(`/invoicing/reservations/${res._id}`)).reservation
  expect(cancelled.status).toBe('cancelled')
  walk.note(`${original.reservationNumber} is now „Отказана"; the snackbar names it and says it can be reserved again from its row, which now offers „Резервирай отново".`)
  await expect(row).toContainText(`${QTY} / 0 / 0`)
  walk.note(`The cancelled row still reads „${QTY} / 0 / 0" under „Кол. / Фактурирано / Експедирано" — only the status chip says it holds nothing.`)

  // ── 2. Make it again, from its own row (#252) ──
  const again = row.getByRole('button', { name: 'Резервирай отново' })
  await expect(again).toBeVisible()
  await walk.click(again, 'reserve it again (row icon)')
  const againSnack = snackbar(walk, /Резервирано отново като/)
  await expect(againSnack).toBeVisible()
  const freshNumber = ((await againSnack.innerText()).match(/като\s+(\S+)/) || [])[1]
  expect(freshNumber).toMatch(/^RES-/)
  const freshRow = page.locator('tbody tr').filter({ hasText: freshNumber })
  await expect(freshRow).toContainText('Активна')
  await expect(freshRow).toContainText('резервирана отново')
  await settledShot(walk, 'reserved-again')

  // What the walk did (uncounted): a NEW reservation, same product / quantity / warehouse / client.
  const { reservations } = await api.get(`/invoicing/reservations?internalOrderId=${ordi._id}&size=10`)
  const fresh = (reservations || []).find((r: any) => r.status === 'active')
  expect(fresh).toBeTruthy()
  expect(fresh.quantity).toBe(original.quantity)
  expect(String(fresh.warehouseId)).toBe(String(original.warehouseId))
  expect(String(fresh.contactId)).toBe(String(original.contactId))
  expect(fresh.number).not.toBe(original.reservationNumber)
  expect(fresh.number).toBe(freshNumber)
  expect(String(fresh.repeatOf)).toBe(String(res._id))
  walk.note(`The hold is back as a NEW document: ${fresh.number} (same ${QTY} × ${SKU}, same warehouse, same client, same internal-order line), marked „резервирана отново"; ${original.reservationNumber} stays in the list as „Отказана". The same row icon serves a reservation made on an external order's allocation, and both order forms offer it too; a second click answers with the same copy (a unique index on \`repeatOf\`).`)

  const result = walk.finish()
  // FR-22.37 asks ≤ 4 for every reservation; the row icon (#252) makes it 3: release, confirm, again.
  expect(result.clicks).toBeLessThanOrEqual(3)
})
