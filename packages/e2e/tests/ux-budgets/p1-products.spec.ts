import { test, expect } from '@playwright/test'
import { startWalk, uxApi } from '../helpers/ux-budget'

/**
 * P1 — Products. The job: find an article, see its stock (and what is reserved or on order),
 * change its selling price.
 *
 * Products used: PRD-0011..0015 (the inventory walks' share of the acme-corp seed); this walk's
 * article is PRD-0012. Customer: Harbor Supplies. Supplier: Bright Solutions.
 */

type Api = Awaited<ReturnType<typeof uxApi>>

const SKU = 'PRD-0012'
const CUSTOMER = 'Harbor Supplies'
const SUPPLIER = 'Bright Solutions'
const ON_SHELF = 3 // held for the customer from the main warehouse's stock
const ORDERED = 12 // on a supplier order that is out, nothing received yet
const PROMISED = 4 // of those 12, already reserved for the customer

/** The quantity as the Bulgarian list prints it. */
const qty = (n: number) => new Intl.NumberFormat('bg-BG', { maximumFractionDigits: 3 }).format(n)

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
 * Setup (uncounted): the article held for a client on the shelf, and ordered from a supplier with
 * part of the order promised — the two things #203.8 asks the Products list to show. Earlier runs'
 * holds and orders are released first, so the figures do not pile up.
 */
async function reservedAndOnOrder(api: Api, product: any): Promise<{ resNumber: string; ordoNumber: string }> {
  const customer = await contactByName(api, CUSTOMER)
  const supplier = await contactByName(api, SUPPLIER)
  const { orders } = await api.get('/invoicing/orders?size=100&status=draft,sent')
  for (const o of orders || []) {
    const mine = (o.supplierGroups || []).some((g: any) => String(g.supplierId) === String(supplier._id)
      && (g.lines || []).some((l: any) => String(l.productId) === String(product._id)))
    if (mine) await api.post(`/invoicing/orders/${o._id}/cancel`)
  }
  const { reservations } = await api.get(`/invoicing/reservations?size=100&status=active&productId=${product._id}&contactId=${customer._id}`)
  for (const r of reservations || []) await api.post(`/invoicing/reservations/${r._id}/cancel`)

  const { warehouses } = await api.get('/warehouse/warehouse?size=100')
  const main = (warehouses || []).find((w: any) => w.isDefault) || warehouses?.[0]
  const { reservation } = await api.post('/invoicing/reservations', {
    source: 'stock', productId: product._id, warehouseId: main._id, contactId: customer._id, quantity: ON_SHELF,
  })
  expect(reservation?.status, 'stock reservation').toBe('active')

  const { order } = await api.post('/invoicing/orders', {
    issueDate: new Date().toISOString().split('T')[0],
    expectedDate: new Date(Date.now() + 10 * 86400000).toISOString().split('T')[0],
    supplierGroups: [{
      supplierId: supplier._id,
      lines: [{
        productId: product._id, description: product.name, sku: product.sku, quantity: ORDERED, unit: product.unit || 'pcs',
        expectedUnitPrice: product.purchasePrice, allocations: [{ warehouseId: main._id, quantity: ORDERED }],
      }],
    }],
  })
  expect(order?._id, 'supplier order created').toBeTruthy()
  const sent = (await api.post(`/invoicing/orders/${order._id}/send`)).order
  expect(sent?.status).toBe('sent')
  const g = sent.supplierGroups[0]
  const l = g.lines[0]
  const promised = await api.post('/invoicing/reservations', {
    source: 'order', productId: product._id, contactId: customer._id, quantity: PROMISED,
    orderId: sent._id, groupId: g._id, lineId: l._id, allocationId: l.allocations[0]._id,
  })
  expect(promised.reservation?.status, 'reservation on the supplier order').toBe('active')
  return { resNumber: reservation.reservationNumber, ordoNumber: sent.orderNumber }
}

test('P1 products: find an article, check its stock, change its selling price', async ({ page }, testInfo) => {
  const api = await uxApi()
  const product = await productBySku(api, SKU)
  const { resNumber, ordoNumber } = await reservedAndOnOrder(api, product)
  // What the stock tab (#252) says, summed over the warehouses: the list must say the same.
  const { supply } = await api.get(`/invoicing/product-supply/${product._id}`)
  const sum = (k: string) => (supply.warehouses || []).reduce((s: number, w: any) => s + (Number(w[k]) || 0), 0)
  const reserved = sum('reserved')
  const onOrder = sum('incoming')
  const ofItReserved = sum('reservedIncoming')
  // The seed's other two warehouses carry holds of their own, so `reserved` is more than ours.
  expect(reserved).toBeGreaterThanOrEqual(ON_SHELF)
  expect(onOrder).toBe(ORDERED)
  expect(ofItReserved).toBe(PROMISED)

  const walk = await startWalk(page, testInfo, {
    id: 'P1',
    title: 'Products — find an article, check stock, change its selling price',
    start: '/inventory/products',
  })
  await walk.shot('list')

  // FR-22.46 (#4.1): stock before unit, what is reserved and on order right after the stock.
  const headers = (await page.locator('thead th').allTextContents()).map((h) => h.trim()).filter(Boolean)
  const at = (title: string) => headers.indexOf(title)
  expect(at('Наличност')).toBeGreaterThan(-1)
  expect(at('Резервирано')).toBe(at('Наличност') + 1)
  expect(at('Поръчано')).toBe(at('Наличност') + 2)
  expect(at('Мярка')).toBeGreaterThan(at('Поръчано'))

  await walk.type(page.getByRole('textbox', { name: /Търсене/ }), 'Product 12', 'search for the article')
  const row = page.locator('tbody tr').filter({ hasText: SKU })
  await expect(row).toBeVisible()

  // FR-22.45: the row answers "what is held, what is coming" — the figures the stock tab sums.
  const reservedLink = row.getByRole('link', { name: `Резервирано: ${qty(reserved)}`, exact: true })
  await expect(reservedLink).toBeVisible()
  await expect(row.getByRole('link', { name: `Поръчано: ${qty(onOrder)}`, exact: true })).toBeVisible()
  await expect(row).toContainText(`от тях резервирано: ${qty(ofItReserved)}`)
  await walk.shot('found')
  walk.note(`List row: „Резервирано" ${qty(reserved)} and „Поръчано" ${qty(onOrder)} (${qty(ofItReserved)} of it already reserved), beside the stock badges — the same sums as the stock tab; each figure opens it.`)

  // The figure opens the stock tab, which names what is behind it.
  await walk.click(reservedLink, 'open what is reserved (the figure on the row)')
  await page.waitForURL(/\/products\/[0-9a-f]{24}\/stock$/)
  await page.waitForLoadState('networkidle')
  const main = page.locator('.v-main')
  await expect(main.getByRole('link', { name: resNumber })).toBeVisible()
  await expect(main.getByRole('link', { name: ordoNumber }).first()).toBeVisible()
  await expect(main.getByText(CUSTOMER).first()).toBeVisible()
  await walk.shot('stock-tab')
  walk.note(`Stock tab: the reservation ${resNumber} and the supplier order ${ordoNumber} behind the figures, with the client.`)

  // Prices live on the „Цени" tab, one click from here.
  await walk.click(page.getByRole('tab', { name: /^Цени$/ }), 'open the prices tab')
  await page.waitForURL(/\/pricing$/)
  const selling = page.getByLabel(/Продажна цена/).first()
  await expect(selling).toBeVisible()
  await walk.fill(selling, '115', 'new selling price')
  await walk.click(page.getByRole('button', { name: /Запази/ }).first(), 'save')
  await expect(page.locator('.v-snackbar')).toBeVisible()
  await walk.shot('saved')
  const afterSave = page.url()
  if (!/\/products\/[^/]+\/pricing$/.test(afterSave)) walk.note(`Save left the article for ${afterSave.replace(/^https?:\/\/[^/]+/, '')}.`)
  expect((await api.get(`/warehouse/product/${product._id}`)).product.sellingPrice).toBe(115)

  const result = walk.finish()
  // FR-22 §3: ≤ 6 clicks and 2 typed, with both figures on the row and on the stock tab.
  expect(result.clicks).toBeLessThanOrEqual(6)
  expect(result.typed).toBeLessThanOrEqual(2)
})
