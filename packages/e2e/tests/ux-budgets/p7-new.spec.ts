import { test, expect } from '@playwright/test'
import { startWalk, uxApi } from '../helpers/ux-budget'

/**
 * P7 — A new reservation, made on the Reservations list (FR-22.37). A client asks for 2 of an
 * article to be held for them: start on the list, end on the new reservation's own page with its
 * number in view.
 *
 * Product used: PRD-0034 (this walk's share of the acme-corp seed). Customer: Stellar Components.
 */

type Api = Awaited<ReturnType<typeof uxApi>>
type Walk = Awaited<ReturnType<typeof startWalk>>

const CUSTOMER = 'Stellar Components'
const SKU = 'PRD-0034'
const QTY = 2

async function productBySku(api: Api, sku: string): Promise<any> {
  const { products } = await api.get(`/warehouse/product?search=${encodeURIComponent(sku)}&size=5`)
  const p = (products || []).find((x: any) => x.sku === sku)
  expect(p, `seed product ${sku}`).toBeTruthy()
  return p
}

/** Screenshots wait out Vuetify's dialog/snackbar transitions. */
async function settledShot(walk: Walk, name: string): Promise<void> {
  await walk.page.waitForTimeout(400)
  await walk.shot(name)
}

test('P7 new: a reservation made on the Reservations list', async ({ page }, testInfo) => {
  const api = await uxApi()
  const product = await productBySku(api, SKU)
  // Re-runnability (uncounted): earlier runs' holds on the article are released.
  const { reservations: earlier } = await api.get(`/invoicing/reservations?productId=${product._id}&status=active&size=100`)
  for (const r of earlier || []) await api.post(`/invoicing/reservations/${r._id}/cancel`, {})
  const sources = await api.get(`/invoicing/reservations/sources?productId=${product._id}`)
  const main = sources.stock?.[0]
  expect(main?.isDefault, 'the default warehouse is offered first').toBe(true)
  expect(main.free).toBeGreaterThanOrEqual(QTY)

  const walk = await startWalk(page, testInfo, {
    id: 'P7-new',
    title: 'Reservations — a client wants 2 of an article held: reserve it on the list',
    start: '/invoicing/reservations',
  })
  await settledShot(walk, 'reservations-list')

  // ── 1. The dialog, from the list's header ──
  await walk.click(page.getByRole('button', { name: 'Нова резервация' }), 'new reservation (list header)')
  const dialog = page.getByTestId('reservation-create')
  await expect(dialog).toBeVisible()
  walk.dialog('the new-reservation dialog')

  // ── 2. Client, article, quantity: each field hands the cursor to the next ──
  const client = dialog.getByRole('combobox', { name: 'Клиент' })
  await expect(client).toBeFocused()
  await walk.type(client, 'Stellar', 'search the client', { focused: true })
  await walk.click(page.locator('.v-overlay--active .v-list-item').filter({ hasText: CUSTOMER }).first(), 'pick the client')

  const article = dialog.getByRole('combobox', { name: 'Продукт' })
  await expect(article).toBeFocused()
  await walk.type(article, SKU, `search ${SKU}`, { focused: true })
  await walk.click(page.locator('.v-overlay--active .v-list-item').filter({ hasText: SKU }).first(), `pick ${SKU}`)

  const quantity = dialog.getByRole('spinbutton', { name: 'Кол.' })
  await expect(quantity).toBeFocused()
  await walk.fill(quantity, String(QTY), `quantity ${QTY}`, { focused: true })

  // The source comes chosen: the default warehouse, which holds the quantity.
  await expect(dialog.getByRole('radio', { name: new RegExp(main.warehouseName) })).toBeChecked()
  await settledShot(walk, 'dialog-filled')
  walk.note(`Sources offered for ${SKU}: free stock per warehouse (${sources.stock.map((s: any) => `${s.warehouseName} ${s.free}`).join(', ')})${sources.allocations.length ? ` and ${sources.allocations.length} supplier-order allocation(s)` : ''}; „${main.warehouseName}" comes chosen because it is the default and holds ${QTY}.`)

  // ── 3. Reserve: the user lands on the new reservation ──
  await walk.click(dialog.getByRole('button', { name: 'Резервирай' }), 'reserve')
  await page.waitForURL(/\/invoicing\/reservations\/[0-9a-f]{24}$/)
  // The page shows „—" until the reservation has loaded: wait for the number, then read it.
  const numberEl = page.getByTestId('reservation-number')
  await expect(numberEl).toHaveText(/^RES-/)
  const number = (await numberEl.innerText()).trim()
  await expect(page.getByRole('link', { name: CUSTOMER })).toBeVisible()
  await expect(page.getByTestId('reservation-quantity')).toContainText(String(QTY))
  await expect(page.getByTestId('reservation-history')).toContainText('Създадена')
  await settledShot(walk, 'reservation-page')
  walk.note(`${number} opens on its own page: client, article, ${QTY} reserved, the source warehouse, its history — every number a link.`)

  // What the walk did (uncounted).
  const id = page.url().match(/reservations\/([0-9a-f]{24})/)![1]
  const made = (await api.get(`/invoicing/reservations/${id}`)).reservation
  expect(made).toMatchObject({ reservationNumber: number, status: 'active', source: 'stock', quantity: QTY, contactName: CUSTOMER })
  expect(String(made.warehouseId)).toBe(main.warehouseId)

  const result = walk.finish()
  // FR-22.37: a handful at most — the dialog, the client, the article, Reserve.
  expect(result.clicks).toBeLessThanOrEqual(4)
})
