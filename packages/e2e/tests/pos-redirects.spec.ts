import { test, expect } from '@playwright/test'
import { apiGet, apiLogin, type ApiSession } from './helpers/api'
import { createBackOfficeCashSale } from './helpers/cash-register'
import { restoreEntry } from './helpers/document-form'
import { loginForApp } from './helpers/login'

const API = process.env.BASE_URL || 'http://localhost:4001'

const claimsOf = (session: ApiSession) => JSON.parse(Buffer.from(session.token.split('.')[1], 'base64url').toString('utf8'))

/** A Pending-changes entry, as a form left it, in this person's own list. */
async function seedPendingChange(page: any, session: ApiSession, entry: Record<string, unknown>) {
  const { id: userId } = claimsOf(session)
  await page.addInitScript(({ key, entry }: any) => {
    // Once: the test goes on to change the list, and each page load runs this again.
    if (sessionStorage.getItem('e2e_seeded')) return
    sessionStorage.setItem('e2e_seeded', '1')
    localStorage.setItem(key, JSON.stringify([entry]))
  }, {
    key: `lgr_pending_changes_${session.orgId}_${userId}`,
    entry: { orgId: session.orgId, userId, capturedAt: new Date().toISOString(), ...entry },
  })
}

/**
 * POS moved into Invoicing. Its old addresses keep working: the desktops in the field store
 * `/pos/` as their start path, and the shell opens that on the server. So the redirect is the
 * server's, and it is asked here over HTTP before a browser is. 302, never 301: a browser keeps a
 * permanent redirect, and a rollback has to bring the old app back.
 */
const MOVED: Array<[string, string]> = [
  ['/pos', '/invoicing/cash-sales/new'],
  ['/pos/', '/invoicing/cash-sales/new'],
  ['/pos/terminal', '/invoicing/cash-sales/new'],
  ['/pos/orders', '/invoicing/cash-sales'],
  ['/pos/orders?method=card', '/invoicing/cash-sales?method=card'],
  ['/pos/orders/6a1b2c3d4e5f60718293a4b5', '/invoicing/cash-sales/6a1b2c3d4e5f60718293a4b5/view'],
  ['/pos/sessions', '/invoicing/cash-register/sessions'],
  ['/pos/devices', '/invoicing/configuration/devices'],
  ['/pos/devices/new', '/invoicing/configuration/devices/new'],
  ['/pos/devices/6a1b2c3d4e5f60718293a4b5', '/invoicing/configuration/devices/6a1b2c3d4e5f60718293a4b5'],
  ['/pos/pin?to=%2Fterminal', '/invoicing/pin'],
  ['/pos/no-such-page', '/invoicing/cash-sales/new'],
]

test.describe('The POS app\'s old addresses', () => {
  for (const [from, to] of MOVED) {
    test(`${from} → ${to}`, async () => {
      const res = await fetch(`${API}${from}`, { redirect: 'manual' })
      expect(res.status).toBe(302)
      expect(res.headers.get('location')).toBe(to)
    })
  }

  test('nothing is left to cache, and a stale asset is a plain 404', async () => {
    const res = await fetch(`${API}/pos/`, { redirect: 'manual' })
    expect(res.headers.get('cache-control')).toContain('no-store')
    expect((await fetch(`${API}/pos/assets/index-stale.js`, { redirect: 'manual' })).status).toBe(404)
  })

  test('what only looks like it is left alone', async () => {
    const posters = await fetch(`${API}/posters`, { redirect: 'manual' })
    expect(posters.status).toBe(200) // the portal's shell, like any other unknown page
    expect((await fetch(`${API}/api/pos/terminal`, { redirect: 'manual' })).status).toBe(404)
  })

  test('a till that stores /pos/ opens on the terminal', async ({ page }) => {
    await loginForApp(page)
    await page.goto('/pos/')
    await expect(page).toHaveURL(/\/invoicing\/cash-sales\/new$/)
    await expect(page.getByRole('heading', { name: 'CS Terminal' })).toBeVisible({ timeout: 15000 })
  })

  test('a bookmark keeps its filter', async ({ page }) => {
    await loginForApp(page)
    await page.goto('/pos/orders?kind=storno')
    await expect(page).toHaveURL(/\/invoicing\/cash-sales\?kind=storno$/)
    await expect(page.getByRole('heading', { name: 'Cash Register Sales' })).toBeVisible({ timeout: 15000 })
  })

  test('a device opened from the old list opens in its new place', async ({ page }) => {
    await loginForApp(page)
    await page.goto('/pos/devices/new')
    await expect(page).toHaveURL(/\/invoicing\/configuration\/devices\/new$/)
    await expect(page.getByRole('heading', { name: 'New POS Device' })).toBeVisible({ timeout: 15000 })
  })
})

/**
 * FR-24 Phase 0 served the till under `/invoicing/pos/*`, and that was on production before it moved
 * to its final addresses. No server map here: the server hands these to the SPA, as it does any
 * `/invoicing/*` page, and the router redirects.
 */
const SERVED_THERE: Array<[string, string]> = [
  ['/invoicing/pos', '/invoicing/cash-sales/new'],
  ['/invoicing/pos/terminal', '/invoicing/cash-sales/new'],
  ['/invoicing/pos/orders?kind=storno', '/invoicing/cash-sales?kind=storno'],
  ['/invoicing/pos/sessions', '/invoicing/cash-register/sessions'],
  ['/invoicing/pos/devices', '/invoicing/configuration/devices'],
  ['/invoicing/pos/devices/new', '/invoicing/configuration/devices/new'],
  ['/invoicing/pos/no-such-page', '/invoicing/cash-sales/new'],
]

test.describe('The till\'s addresses under FR-24 Phase 0', () => {
  for (const [from, to] of SERVED_THERE) {
    test(`${from} → ${to}`, async ({ page }) => {
      await loginForApp(page)
      await page.goto(from)
      await expect(page).toHaveURL(to, { timeout: 15000 })
    })
  }

  test('a sign-in that began on one comes back to the page', async ({ page }) => {
    await page.goto('/invoicing/pos/terminal')
    // Asked of the URL: the one SPA's router writes `next` unencoded.
    await expect(page).toHaveURL(url => url.pathname === '/auth/login' && url.searchParams.get('next') === '/invoicing/cash-sales/new', { timeout: 15000 })
  })
})

/**
 * FR-24.7: a form left with unsaved edits waits under Pending changes in `localStorage`, and those
 * outlive a deploy. The till's own such form is the device page, and an entry made while POS was an
 * app names `appId: 'pos'`, an app that is gone, and a path that is gone with it. A new cash sale's
 * form stood at the address the terminal has now: see the end of this file.
 */
test.describe('A pending change from before the move', () => {
  const NAME = 'Till printer, half typed'

  async function seedEntry(page: any, over: Record<string, unknown>, session?: ApiSession) {
    await seedPendingChange(page, session ?? await apiLogin(), {
      id: 'old-pos-entry', entityType: 'posDevice', mode: 'create',
      routeName: 'pos.devices.new', routeParams: {}, routePath: '/devices/new', appId: 'pos',
      formData: { name: NAME, deviceNumber: 'AB123456' },
      previewFields: [{ label: 'Name', value: NAME }],
      ...over,
    })
  }

  const restore = (page: any) => restoreEntry(page, NAME)

  async function restoredInPlace(page: any) {
    await expect(page).toHaveURL(/\/invoicing\/configuration\/devices\/new$/, { timeout: 15000 })
    await expect(page.getByRole('textbox', { name: /^Name/ })).toHaveValue(NAME, { timeout: 15000 })
  }

  test('captured in the POS app, it reopens from an invoicing page', async ({ page }) => {
    await seedEntry(page, {})
    await loginForApp(page)
    await page.goto('/invoicing/invoices')
    await restore(page)
    await restoredInPlace(page)
  })

  test('and from another module', async ({ page }) => {
    await seedEntry(page, {})
    await loginForApp(page)
    await page.goto('/inventory/products')
    await restore(page)
    await restoredInPlace(page)
  })

  test('captured under FR-24 Phase 0, it reopens too', async ({ page }) => {
    await seedEntry(page, { appId: 'invoicing', routePath: '/pos/devices/new' })
    await loginForApp(page)
    await page.goto('/inventory/products')
    await restore(page)
    await restoredInPlace(page)
  })

  // The shell loads the panel. With the profile refused it used to load it under an empty user id:
  // the panel came up empty, and what a save removed there stayed behind in the real list.
  test('stays the person\'s own when /auth/me fails', async ({ page }) => {
    const session = await apiLogin()
    const { id: userId } = claimsOf(session)
    await seedEntry(page, {}, session)
    await page.route('**/api/auth/me', (route: any) => route.fulfill({ status: 500, json: { message: 'no' } }))
    await loginForApp(page)
    await page.goto('/invoicing/invoices')

    await page.locator('button:has(.mdi-content-save-alert-outline)').click()
    const entry = page.locator('.v-navigation-drawer--right .v-list-item').filter({ hasText: NAME })
    await expect(entry).toBeVisible({ timeout: 15000 })
    await entry.locator('button:has(.mdi-close)').click()

    await expect.poll(() => page.evaluate((key: string) => localStorage.getItem(key), `lgr_pending_changes_${session.orgId}_${userId}`)).toBe('[]')
  })
})

/**
 * `invoicing.cash-sales.new` was the back-office form until the till took its address. A draft a
 * person left on it names that route, and a blank terminal is not what they left. The form's create
 * branch lives on for these, at its own address, so the terminal's permission does not decide it:
 * an accountant holds no `pos.*`, and wrote most of them.
 */
test.describe('A draft of a new cash sale, left on the old form', () => {
  const NOTE = 'Half typed, before the till moved'
  const PRICE = 10.5

  /** The stock the catalog shows for the draft's article at the main warehouse. */
  async function stockOf(product: any) {
    const { products } = await apiGet(await apiLogin(), `/trade/pos/catalog?warehouseId=${product.warehouseId}&type=goods&size=100&sortOrder=desc`)
    return products.find((p: any) => p.productId === product.productId).stockAvailable
  }

  async function seedDraft(page: any, session: ApiSession) {
    // In stock, or the save stops at the form's transfer dialog. The catalog is `pos.read`: an admin
    // looks it up, for an accountant who holds none.
    const admin = await apiLogin()
    const { warehouses } = await apiGet(admin, '/warehouse/warehouse?size=50')
    const main = warehouses.find((w: any) => w.code === 'WH-01') ?? warehouses[0]
    const warehouseId = main.id || main._id
    const { products } = await apiGet(admin, `/trade/pos/catalog?warehouseId=${warehouseId}&type=goods&size=100&sortOrder=desc`)
    const product = products.find((p: any) => (p.stockAvailable ?? 0) >= 2 && p.unitPrice > 0)
    await seedPendingChange(page, session, {
      id: 'old-cash-draft', entityType: 'cashSale', mode: 'create', appId: 'invoicing',
      routeName: 'invoicing.cash-sales.new', routeParams: {}, routePath: '/invoicing/cash-sales/new',
      formData: {
        issueDate: new Date().toISOString().slice(0, 10), currency: 'EUR', notes: NOTE, paymentMethod: 'cash', warehouseId,
        lines: [{
          productId: product.productId, description: product.productName, quantity: 2, unit: product.unit || 'pcs', unitPrice: PRICE,
          discount: 0, taxRate: 20, taxAmount: 4.2, lineTotal: 25.2, warehouseId, productUpdate: {}, priceTiers: [],
          // A price the person typed, as a draft left before such a price was pinned records it.
          priceExplanation: [{ type: 'base', label: 'Selling price', price: product.unitPrice }, { type: 'override', label: 'Manual override', price: PRICE }],
        }],
      },
        previewFields: [{ label: 'Note', value: NOTE }],
    })
    return { ...product, warehouseId }
  }

  async function restoredOnTheForm(page: any, product: any) {
    await expect(page).toHaveURL(/\/invoicing\/cash-sales\/draft$/, { timeout: 15000 })
    await expect(page.locator('[data-testid^="cart-line-"]').filter({ hasText: product.productName })).toBeVisible({ timeout: 15000 })
    await expect(page.getByTestId('complete-sale')).toHaveCount(0)
  }

  test('reopens on the form for someone who has no till, and saves', async ({ page }) => {
    const session = await apiLogin('acme-corp', 'accountant', 'test123')
    const { id: userId } = claimsOf(session)
    const product = await seedDraft(page, session)
    await loginForApp(page, 'acme-corp', 'accountant', 'test123')
    await page.goto('/invoicing/invoices')
    await restoreEntry(page, NOTE)
    await restoredOnTheForm(page, product)
    await expect(page.getByTestId('price-combobox')).toContainText('10.50000')

    // A cash sale is issued as it is saved, and the journal is where the next one starts.
    await page.getByRole('button', { name: /^save$/i }).first().click()
    await expect(page).toHaveURL(/\/invoicing\/cash-sales$/, { timeout: 15000 })
    await expect.poll(() => page.evaluate((key: string) => localStorage.getItem(key), `lgr_pending_changes_${session.orgId}_${userId}`)).toBe('[]')
  })

  // The route is the same view with another address, so without a key the form stayed: it read New,
  // kept the open sale's number and lines, and Save issued them again and moved their stock again.
  test('reopens from an open sale with its own lines, and nothing moves until it is saved', async ({ page }) => {
    const session = await apiLogin('acme-corp', 'accountant', 'test123')
    const open = await createBackOfficeCashSale()
    const product = await seedDraft(page, session)
    await loginForApp(page, 'acme-corp', 'accountant', 'test123')
    await page.goto(`/invoicing/cash-sales/${open.id}/edit`)
    await expect(page.getByText(open.number).first()).toBeVisible({ timeout: 15000 })
    const before = await stockOf(product)

    await restoreEntry(page, NOTE)

    await restoredOnTheForm(page, product)
    await expect(page.getByText(open.number)).toHaveCount(0)
    await expect(page.getByTestId('cart-qty').locator('input')).toHaveValue('2')
    await expect(page.getByTestId('price-combobox')).toContainText('10.50000')
    expect(await stockOf(product)).toBe(before)

    await page.getByRole('button', { name: /^save$/i }).first().click()
    await expect(page).toHaveURL(/\/invoicing\/cash-sales$/, { timeout: 15000 })
    expect(await stockOf(product)).toBe(before - 2)
  })

  test('reopens on the form from the terminal too', async ({ page }) => {
    const session = await apiLogin()
    const product = await seedDraft(page, session)
    await loginForApp(page)
    await page.goto('/invoicing/cash-sales/new')
    await expect(page.getByRole('heading', { name: 'CS Terminal' })).toBeVisible({ timeout: 15000 })
    await restoreEntry(page, NOTE)
    await restoredOnTheForm(page, product)
  })

  test('reopens from another module, by its address', async ({ page }) => {
    const session = await apiLogin()
    const product = await seedDraft(page, session)
    await loginForApp(page)
    await page.goto('/inventory/products')
    await restoreEntry(page, NOTE)
    await restoredOnTheForm(page, product)
  })
})
