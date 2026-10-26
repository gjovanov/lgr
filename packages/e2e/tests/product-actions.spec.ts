import { test, expect, type Locator, type Page } from '@playwright/test'
import { loginForApp } from './helpers/login'
import { apiLogin, apiGet, apiPost, type ApiSession } from './helpers/api'
import { rowAction } from './helpers/row-actions'
import { lineValues } from './helpers/document-form'
import { listGeometry } from './helpers/list-geometry'

/**
 * FR-22.47 — an article offers „Заприходи", „Продай" and „Резервирай" (Receive, Sell, Reserve), in
 * the Products list's row menu and on its own page, on every tab. Each opens its document with the
 * article on the first line, filled as picking it there fills it:
 *
 * - Receive: the new goods receipt (`/inventory/movements/new?productId=`), same app — the article
 *   at its purchase price, the destination's stock beside it, the cursor in the quantity;
 * - Sell: a new sales invoice in the invoicing app (`/invoicing/invoices/new?productId=`) — its
 *   unit and the price the pricing chain resolves;
 * - Reserve: the Reservations list with its create dialog open on the article.
 *
 * Who sees which is „+ Нов"'s rule (the form's write permission); a service is never received or
 * reserved; a deactivated article's Sell and Reserve are disabled and say why. The rules are held
 * in `unit/product-doc-actions.test.ts`; this spec holds the screens to them.
 *
 * Products used: PRD-0035 (a stock article) and PRD-0045 (a service), which no other spec or walk
 * touches, and one article this spec creates and deactivates. Nothing is saved on the documents.
 */
test.use({ viewport: { width: 1366, height: 768 } })

const SKU = 'PRD-0035'
const SERVICE_SKU = 'PRD-0045'
const ACTIONS = ['receive', 'sell', 'reserve'] as const
type ActionKey = (typeof ACTIONS)[number]

async function productBySku(s: ApiSession, sku: string): Promise<any> {
  const { products } = await apiGet(s, `/warehouse/product?search=${encodeURIComponent(sku)}&size=5`)
  const p = (products || []).find((x: any) => x.sku === sku)
  expect(p, `seed product ${sku}`).toBeTruthy()
  return p
}

/** The Products list narrowed to one article (FR-05: the search is in the URL), and its row. */
async function productRow(page: Page, sku: string, status?: 'inactive' | 'all'): Promise<Locator> {
  await page.goto(`/inventory/products?q=${encodeURIComponent(sku)}${status ? `&status=${status}` : ''}`)
  const row = page.locator('.v-data-table tbody tr').filter({ hasText: sku })
  await expect(row).toHaveCount(1, { timeout: 15000 })
  return row
}

/** The goods receipt, its first line the article at its purchase price, the cursor in the quantity. */
async function expectReceipt(page: Page, p: any): Promise<void> {
  await expect(page).toHaveURL(new RegExp(`/inventory/movements/new\\?productId=${p._id}$`))
  await expect(page.locator('.v-select__selection-text').first()).toHaveText('Receipt')
  const lines = page.locator('.line-table tbody tr')
  const first = lines.first()
  await expect(first.locator('.v-chip').filter({ hasText: p.name })).toBeVisible({ timeout: 10000 })
  await expect(first.locator('td').nth(3).locator('input')).toHaveValue(String(p.purchasePrice))
  // What the destination holds of it, as picking it shows.
  await expect(first.locator('td').nth(1).locator('.v-chip')).toBeVisible()
  // The next line is waiting, and the quantity is what the user types next.
  await expect(lines).toHaveCount(2)
  await expect(first.locator('td').nth(2).locator('input')).toBeFocused()
}

/** A new sales invoice whose first line is the article, at the price the chain resolves. */
async function expectInvoice(page: Page, p: any, price: number): Promise<void> {
  await expect(page).toHaveURL(new RegExp(`/invoicing/invoices/new\\?productId=${p._id}$`))
  await expect(page.getByRole('heading', { name: /^new invoice$/i })).toBeVisible({ timeout: 15000 })
  await expect.poll(async () => (await lineValues(page))[0] || '', { timeout: 10000 }).toContain(p.name)
  const first = page.locator('.line-table tbody tr').first()
  await expect(first).toContainText(price.toFixed(2))
  await expect(first.locator('input[type="number"]').first()).toHaveValue('1')
  // Picking an article on the last line opens the next one.
  await expect(page.locator('.line-table tbody tr')).toHaveCount(2)
}

/** The Reservations list, its create dialog open on the article; the trigger is out of the URL. */
async function expectReservation(page: Page, p: any): Promise<void> {
  const dialog = page.getByTestId('reservation-create')
  await expect(dialog).toBeVisible({ timeout: 15000 })
  await expect(dialog).toContainText(`${p.name} (${p.sku})`)
  // The sources come for this article: it has free stock in the seeded warehouses.
  await expect(dialog.getByRole('radio').first()).toBeVisible()
  await expect(page).toHaveURL(/\/invoicing\/reservations(\?|$)/)
  expect(page.url()).not.toContain('productId')
}

/**
 * Hovering `activator` shows `text` in ITS tooltip — the one its `aria-describedby` names. Others
 * may be in the DOM: on its way, the pointer crosses the neighbouring entries.
 */
async function expectTooltip(activator: Locator, text: string): Promise<void> {
  await activator.hover()
  await expect(activator).toHaveAttribute('aria-describedby', /.+/)
  const id = await activator.getAttribute('aria-describedby')
  const tip = activator.page().locator(`[id="${id}"]`)
  await expect(tip).toBeVisible()
  await expect(tip).toHaveText(text)
}

async function expectLanding(page: Page, key: ActionKey, p: any, price: number): Promise<void> {
  if (key === 'receive') await expectReceipt(page, p)
  else if (key === 'sell') await expectInvoice(page, p, price)
  else await expectReservation(page, p)
}

let session: ApiSession
let product: any
let price: number

test.beforeAll(async () => {
  session = await apiLogin()
  product = await productBySku(session, SKU)
  price = (await apiGet(session, `/pricing/resolve?productId=${product._id}&quantity=1`)).finalPrice
  expect(price, 'the resolved selling price').toBeGreaterThan(0)
})

test('the Products list fits 1366 px with one menu per row — with the „Active" column too', async ({ page }) => {
  await loginForApp(page)
  for (const path of ['/inventory/products', '/inventory/products?status=all']) {
    await page.goto(path)
    await expect(page.locator('.v-data-table tbody tr').first()).toBeVisible({ timeout: 15000 })
    await page.waitForLoadState('networkidle')
    const geo = await listGeometry(page)
    expect(geo.rows, `${path}: rows to measure`).toBeGreaterThan(0)
    expect(geo.hidden, `${path}: no sideways scroll at 1366 px`).toBeLessThanOrEqual(1)
    expect(new Set(geo.actionButtons), `${path}: one menu button per row`).toEqual(new Set([1]))
  }
})

for (const key of ACTIONS) {
  test(`row menu → ${key}: the document opens with the article on its first line`, async ({ page }) => {
    await loginForApp(page)
    const row = await productRow(page, SKU)
    const item = await rowAction(row, key)
    await expect(item).toBeVisible()
    await item.click()
    await expectLanding(page, key, product, price)
  })
}

test('the row menu keeps the article\'s pages and Delete beside the three', async ({ page }) => {
  await loginForApp(page)
  const row = await productRow(page, SKU)
  await row.getByTestId('row-actions').click()
  const list = page.getByTestId('row-actions-list').filter({ visible: true }).last()
  await expect(list.locator('[data-testid^="row-action-"]')).toHaveText(['Edit', 'Stock', 'Receive', 'Sell', 'Reserve', 'Delete'])
  await list.getByTestId('row-action-stock').click()
  await expect(page).toHaveURL(new RegExp(`/inventory/products/${product._id}/stock$`))
})

test('the article\'s page offers the three on every tab, and each lands the same way', async ({ page }) => {
  await loginForApp(page)
  await page.goto(`/inventory/products/${product._id}/edit`)
  const actions = page.getByTestId('product-doc-actions')
  await expect(actions).toBeVisible({ timeout: 15000 })
  for (const tab of [/^pricing$/i, /^settings$/i, /^stock$/i, /^movements$/i, /^ledger$/i, /^counts$/i, /^edit$/i]) {
    await page.getByRole('tab', { name: tab }).click()
    await expect(actions, `on the ${tab} tab`).toBeVisible()
    for (const key of ACTIONS) await expect(page.getByTestId(`product-action-${key}`)).toBeEnabled()
  }

  // Edit tab → Sell (another app: a page load).
  await expect(page.getByTestId('product-action-sell')).toHaveAttribute('href', `/invoicing/invoices/new?productId=${product._id}`)
  await page.getByTestId('product-action-sell').click()
  await expectLanding(page, 'sell', product, price)

  // Stock tab → Receive (this app).
  await page.goto(`/inventory/products/${product._id}/stock`)
  await page.getByTestId('product-action-receive').click()
  await expectLanding(page, 'receive', product, price)

  // Pricing tab → Reserve.
  await page.goto(`/inventory/products/${product._id}/pricing`)
  await page.getByTestId('product-action-reserve').click()
  await expectLanding(page, 'reserve', product, price)
})

test('a deactivated article: Sell and Reserve say why they are disabled; Receive still opens the receipt', async ({ page }) => {
  const stamp = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`
  const sku = `E2E-ACT-${stamp}`
  const created = await apiPost(session, '/warehouse/product', { sku, name: `E2E actions ${stamp}`, category: 'General', type: 'goods', unit: 'pcs', purchasePrice: 4, sellingPrice: 9 })
  expect(created.ok, `create product: ${created.status}`).toBe(true)
  const made = (await created.json()).product
  const off = await fetch(`${process.env.BASE_URL || 'http://localhost:4001'}/api/org/${session.orgId}/warehouse/product/${made._id}`, {
    method: 'DELETE', headers: { Authorization: `Bearer ${session.token}` },
  })
  expect(off.ok, `deactivate: ${off.status}`).toBe(true)
  const inactive = { ...made, isActive: false }
  const reason = 'The product is deactivated — activate it to sell or reserve it.'

  await loginForApp(page)
  // The list shows a deactivated article only when asked for (FR-22.48).
  const row = await productRow(page, sku, 'inactive')
  await row.getByTestId('row-actions').click()
  const list = page.getByTestId('row-actions-list').filter({ visible: true }).last()
  for (const key of ['sell', 'reserve']) {
    await expect(list.getByTestId(`row-action-${key}`)).toHaveClass(/v-list-item--disabled/)
    await expectTooltip(list.getByTestId(`row-action-${key}-disabled`), reason)
  }
  await expect(list.getByTestId('row-action-receive')).not.toHaveClass(/v-list-item--disabled/)
  await list.getByTestId('row-action-receive').click()
  await expectReceipt(page, inactive)

  // The page says the same.
  await page.goto(`/inventory/products/${made._id}/stock`)
  for (const key of ['sell', 'reserve']) {
    await expect(page.getByTestId(`product-action-${key}`)).toBeDisabled({ timeout: 15000 })
    await expectTooltip(page.getByTestId(`product-action-${key}-wrap`), reason)
  }
  await expect(page.getByTestId('product-action-receive')).toBeEnabled()
  // An enabled one names what it opens.
  await expectTooltip(page.getByTestId('product-action-receive-wrap'), 'New goods receipt')
})

test('a service is sold, never received or reserved', async ({ page }) => {
  const service = await productBySku(session, SERVICE_SKU)
  expect(service.trackInventory).toBe(false)
  await loginForApp(page)
  const row = await productRow(page, SERVICE_SKU)
  await row.getByTestId('row-actions').click()
  const list = page.getByTestId('row-actions-list').filter({ visible: true }).last()
  await expect(list.getByTestId('row-action-sell')).toBeVisible()
  await expect(list.getByTestId('row-action-receive')).toHaveCount(0)
  await expect(list.getByTestId('row-action-reserve')).toHaveCount(0)
  await page.keyboard.press('Escape')

  await page.goto(`/inventory/products/${service._id}/edit`)
  await expect(page.getByTestId('product-action-sell')).toBeVisible({ timeout: 15000 })
  await expect(page.getByTestId('product-action-receive')).toHaveCount(0)
  await expect(page.getByTestId('product-action-reserve')).toHaveCount(0)
})

/** What a role is offered, on the row and on the page: what the form's Save would take. */
for (const { username, offered } of [
  { username: 'warehouse', offered: ['receive'] },
  { username: 'sales', offered: ['sell', 'reserve'] },
]) {
  test(`${username}: offered ${offered.join(' and ')} alone`, async ({ page }) => {
    await loginForApp(page, 'acme-corp', username, 'test123')
    const row = await productRow(page, SKU)
    await row.getByTestId('row-actions').click()
    const list = page.getByTestId('row-actions-list').filter({ visible: true }).last()
    await expect(list.getByTestId('row-action-edit')).toBeVisible()
    for (const key of ACTIONS) {
      await expect(list.getByTestId(`row-action-${key}`), key).toHaveCount(offered.includes(key) ? 1 : 0)
    }
    await page.keyboard.press('Escape')

    await page.goto(`/inventory/products/${product._id}/stock`)
    await expect(page.getByTestId(`product-action-${offered[0]}`)).toBeVisible({ timeout: 15000 })
    for (const key of ACTIONS) {
      await expect(page.getByTestId(`product-action-${key}`), key).toHaveCount(offered.includes(key) ? 1 : 0)
    }
  })
}
