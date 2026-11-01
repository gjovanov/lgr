import { test, expect } from '@playwright/test'
import { loginForApp } from './helpers/login'
import { apiLogin, apiGet, apiPost } from './helpers/api'
import { closeTillSession, createBackOfficeCashSale, openTillSession, ringTillSale } from './helpers/cash-register'
import { BETA, signInAsMultiInAcme, switchTo } from './helpers/org-switcher'

const API = process.env.BASE_URL || 'http://localhost:4001'
const PASSWORD = 'test12345'

/**
 * The till lives in the invoicing app, and not everyone there has it, or anything else of it.
 *
 * No default role is till-only yet, so this spec makes one: a member whose permissions are `pos.*`
 * and nothing of invoicing. A PIN session reads the same `isTillOnly`; the server's own scope for
 * one is `integration/local-signin.flow`'s to prove.
 *
 * Serial: the tests share that one user, whose creation is the expensive part.
 */
test.describe.configure({ mode: 'serial' })

const username = `till-only-${Date.now()}`

/** A user whose permissions are exactly `permissions`. A set replaces the role's defaults; `User.permissions` only adds to them. */
async function userWith(name: string, permissions: string[]) {
  const admin = await apiLogin()
  const res = await apiPost(admin, '/user', {
    email: `${name}@acme.com`, username: name, password: PASSWORD, firstName: 'Till', lastName: 'Only', role: 'member',
  })
  expect(res.ok, `create the user → ${res.status}`).toBe(true)
  const { user } = await res.json()
  const set = await apiPost(admin, '/permission-sets', { name: `Set of ${name}`, permissions })
  expect(set.ok, `create the set → ${set.status}`).toBe(true)
  const { permissionSet } = await set.json()
  const put = await fetch(`${API}/api/org/${admin.orgId}/user/${user.id || user._id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${admin.token}` },
    body: JSON.stringify({ permissionSetIds: [permissionSet.id || permissionSet._id] }),
  })
  expect(put.ok, `assign the set → ${put.status}`).toBe(true)
}

/**
 * What the server refuses this page from here on. Started after `loginForApp`: that lands on the
 * portal, whose own probes (`backup/access`) are answered 403 and have nothing to do with the till.
 */
function refusalsOf(page: any): string[] {
  const refused: string[] = []
  page.on('response', (r: any) => { if (r.status() === 403 && r.url().includes('/api/')) refused.push(r.url()) })
  return refused
}

async function menuTexts(page: any, group: RegExp | string): Promise<string[]> {
  await page.locator('.top-menu-inline').getByRole('button', { name: group }).click()
  const items = page.locator('.v-overlay--active .v-list-item')
  await expect(items.first()).toBeVisible()
  const texts = (await items.allInnerTexts()).map((t: string) => t.trim())
  await page.keyboard.press('Escape')
  return texts
}

test.describe('A till-only role', () => {
  test.beforeAll(async () => {
    await userWith(username, ['pos.read', 'pos.write'])
  })

  test('the App Hub shows it the Invoicing tile, which is how it reaches the till', async () => {
    const session = await apiLogin('acme-corp', username, PASSWORD)
    const { apps } = await apiGet(session, '/apps')
    expect(apps.map((a: any) => a.id)).toEqual(['invoicing'])
  })

  test('the menu shows the till and nothing else, with no refused call behind it', async ({ page }) => {
    await loginForApp(page, 'acme-corp', username, PASSWORD)
    const refused = refusalsOf(page)
    await page.goto('/invoicing/cash-sales/new')
    await expect(page.getByRole('heading', { name: 'CS Terminal' })).toBeVisible({ timeout: 15000 })

    const bar = page.locator('.top-menu-inline')
    await expect(bar.getByRole('button')).toHaveCount(2)
    expect(await menuTexts(page, /Outgoing/)).toEqual(['CS Terminal', 'CR Sales', 'CR Sessions'])
    expect(await menuTexts(page, /Configuration/)).toEqual(['Devices'])
    expect(refused).toEqual([])
  })

  test('any other invoicing page takes it to the terminal', async ({ page }) => {
    await loginForApp(page, 'acme-corp', username, PASSWORD)
    for (const path of ['/invoicing/', '/invoicing/invoices', '/invoicing/contacts', '/invoicing/bills/new']) {
      await page.goto(path)
      await expect(page, path).toHaveURL(/\/invoicing\/cash-sales\/new$/)
    }
  })

  test('the journal gives it the journal: no export, no import, and a row opens on the journal\'s page', async ({ page }) => {
    const sale = await ringTillSale()
    try {
      await loginForApp(page, 'acme-corp', username, PASSWORD)
      const refused = refusalsOf(page)
      await page.goto(`/invoicing/cash-sales?q=${sale.number}`)
      const row = page.locator('.v-data-table tbody tr').filter({ has: page.getByRole('link', { name: sale.number, exact: true }) })
      await expect(row).toBeVisible({ timeout: 15000 })
      await expect(page.getByRole('button', { name: /^export$/i })).toHaveCount(0)
      await expect(page.getByRole('button', { name: /^import$/i })).toHaveCount(0)
      await expect(page.locator('a.v-btn', { hasText: /create/i }).first()).toBeVisible()
      await expect(row.getByRole('button', { name: /print/i })).toHaveCount(0)

      await row.getByRole('link', { name: sale.number, exact: true }).click()
      await expect(page).toHaveURL(new RegExp(`/invoicing/cash-sales/${sale.id}/view$`))
      await expect(page.getByTestId('journal-document-title')).toHaveText(sale.number)
      await expect(page.getByRole('button', { name: /print/i })).toHaveCount(0)
      expect(refused).toEqual([])
    } finally {
      await closeTillSession(sale.sessionId)
    }
  })

  test('it rings a sale at the till, and sees it in its session', async ({ page }) => {
    const cashier = await apiLogin('acme-corp', username, PASSWORD)
    const till = await openTillSession(cashier)
    try {
      await loginForApp(page, 'acme-corp', username, PASSWORD)
      await page.goto('/invoicing/cash-sales/new')
      const card = page.getByTestId('register-card').first()
      await expect(card).toBeVisible({ timeout: 15000 })
      await card.click()
      await page.getByTestId('complete-sale').click()
      await expect(page.getByTestId('last-sale-number')).toBeVisible({ timeout: 15000 })

      await page.goto('/invoicing/cash-register/sessions')
      await expect(page.getByRole('heading', { name: 'CR Sessions' })).toBeVisible({ timeout: 15000 })
    } finally {
      await closeTillSession(till.id, cashier)
    }
  })
})

/**
 * `canOpenPage` decides who may open what (`unit/module-manifests.test.ts` holds the table). These
 * are the real pages behind its rows that a person can no longer be stranded on.
 */
test.describe('Who cannot use a till page', () => {
  const JOURNAL = /\/invoicing\/cash-sales$/

  async function onJournal(page: any, path: string) {
    await page.goto(path)
    await expect(page, path).toHaveURL(JOURNAL)
    await expect(page.getByRole('heading', { name: 'Cash Register Sales' })).toBeVisible({ timeout: 15000 })
  }

  test('an accountant\'s old bookmarks lead to the journal it reads, with nothing refused', async ({ page }) => {
    await loginForApp(page, 'acme-corp', 'accountant', 'test123')
    const refused = refusalsOf(page)
    for (const path of ['/invoicing/cash-sales/new', '/invoicing/cash-register/sessions', '/invoicing/configuration/devices']) await onJournal(page, path)
    expect(refused).toEqual([])
  })

  test('a read-only till session lands on the journal, and is never shown a terminal', async ({ page }) => {
    const reader = `till-reader-${Date.now()}`
    await userWith(reader, ['pos.read'])
    await loginForApp(page, 'acme-corp', reader, PASSWORD)
    const refused = refusalsOf(page)
    for (const path of ['/invoicing/', '/invoicing/invoices', '/invoicing/cash-sales/new']) await onJournal(page, path)
    await expect(page.locator('a.v-btn', { hasText: /create/i })).toHaveCount(0)
    expect(await menuTexts(page, /Outgoing/)).toEqual(['CR Sales', 'CR Sessions'])
    expect(refused).toEqual([])
  })

  // The report is theirs to read. Printing it writes to the till, and the server refuses that.
  test('a read-only till session reads a session\'s report, and is not offered its print', async ({ page }) => {
    const sale = await ringTillSale()
    await closeTillSession(sale.sessionId)
    const reader = `till-printless-${Date.now()}`
    await userWith(reader, ['pos.read'])
    await loginForApp(page, 'acme-corp', reader, PASSWORD)
    await page.goto('/invoicing/cash-register/sessions')

    await page.getByTestId('session-report-open').first().click()
    await expect(page.getByRole('dialog').filter({ hasText: 'Session report' })).toBeVisible({ timeout: 15000 })
    await expect(page.getByRole('button', { name: 'Print report' })).toHaveCount(0)
  })

  // A sale of the back office, which someone without the documents opens on the journal's page: the
  // form reads `/invoices`, and the server refuses them that.
  test('the till and inventory: what the server reads for them, and the journal\'s own page', async ({ page }) => {
    const sale = await createBackOfficeCashSale()
    const stock = `till-stock-${Date.now()}`
    await userWith(stock, ['pos.read', 'pos.write', 'inventory.read'])
    await loginForApp(page, 'acme-corp', stock, PASSWORD)
    const refused = refusalsOf(page)

    await page.goto('/invoicing/orders')
    await expect(page).toHaveURL(/\/invoicing\/orders$/)
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible({ timeout: 15000 })
    expect(await menuTexts(page, /Orders/)).toEqual([expect.stringContaining('Supplier Orders')])
    await page.goto('/invoicing/contacts')
    await expect(page).toHaveURL(/\/invoicing\/contacts$/)

    await page.goto(`/invoicing/cash-sales?q=${sale.number}`)
    const row = page.locator('.v-data-table tbody tr').filter({ has: page.getByRole('link', { name: sale.number, exact: true }) })
    await expect(row).toBeVisible({ timeout: 15000 })
    await row.getByRole('link', { name: sale.number, exact: true }).click()
    await expect(page).toHaveURL(new RegExp(`/invoicing/cash-sales/${sale.id}/view$`))
    await expect(page.getByTestId('journal-document-title')).toHaveText(sale.number)
    expect(refused).toEqual([])
  })

  test('pos.write alone has the tile, so the till is not reached by a typed address only', async () => {
    const seller = `till-seller-${Date.now()}`
    await userWith(seller, ['pos.write'])
    const { apps } = await apiGet(await apiLogin('acme-corp', seller, PASSWORD), '/apps')
    expect(apps.map((a: any) => a.id)).toEqual(['invoicing'])
  })

  // The server reads the module for any of its permissions: none of this is the till's to take away.
  test('someone with invoicing.write and .send and no .read keeps the back office', async ({ page }) => {
    const clerk = `till-clerk-${Date.now()}`
    await userWith(clerk, ['pos.read', 'pos.write', 'invoicing.write', 'invoicing.send'])
    await loginForApp(page, 'acme-corp', clerk, PASSWORD)
    await page.goto('/invoicing/invoices')
    await expect(page).toHaveURL(/\/invoicing\/invoices$/)
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible({ timeout: 15000 })
    expect(await menuTexts(page, /Outgoing/)).toContain('Sales Documents')
    await page.goto('/invoicing/contacts')
    await expect(page).toHaveURL(/\/invoicing\/contacts$/)
    await page.goto('/invoicing/cash-sales')
    await expect(page.getByRole('button', { name: /^export$/i })).toBeVisible({ timeout: 15000 })
  })

  // `sales` here, `accountant` there: the app is theirs in both, and the terminal in one.
  test('an org switch off the terminal lands on the app\'s home, not on a page it cannot use', async ({ page }) => {
    await signInAsMultiInAcme(page)
    await page.goto('/invoicing/cash-sales/new')
    await expect(page.getByRole('heading', { name: 'CS Terminal' })).toBeVisible({ timeout: 15000 })
    await switchTo(page, BETA)
    await expect(page).toHaveURL(/\/invoicing\/invoices$/, { timeout: 15000 })
  })
})

test.describe('Roles beside the till', () => {
  test('an accountant is not offered the till, and keeps the journal it reads', async ({ page }) => {
    await loginForApp(page, 'acme-corp', 'accountant', 'test123')
    await page.goto('/invoicing/invoices')
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible({ timeout: 15000 })

    const outgoing = await menuTexts(page, /Outgoing/)
    expect(outgoing).toContain('CR Sales')
    expect(outgoing).not.toContain('CS Terminal')
    expect(outgoing).not.toContain('CR Sessions')
    expect(await menuTexts(page, /Configuration/)).not.toContain('Devices')

    await page.goto('/invoicing/cash-sales')
    await expect(page.getByRole('heading', { name: 'Cash Register Sales' })).toBeVisible({ timeout: 15000 })
    await expect(page.locator('a.v-btn', { hasText: /create/i })).toHaveCount(0)
  })

  test('a cashier gets all of it, the till behind its divider', async ({ page }) => {
    await loginForApp(page, 'acme-corp', 'sales', 'test123')
    await page.goto('/invoicing/invoices')
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible({ timeout: 15000 })

    await page.locator('.top-menu-inline').getByRole('button', { name: /Outgoing/ }).click()
    const list = page.locator('.v-overlay--active .v-list')
    await expect(list.locator('.v-list-item').filter({ hasText: 'CS Terminal' })).toBeVisible()
    await expect(list.locator('.v-divider')).toHaveCount(1)
    await page.keyboard.press('Escape')
    expect(await menuTexts(page, /Configuration/)).toContain('Devices')
  })
})

/**
 * FR-20.40: a till paired with an on-prem server signs in with a PIN. The guard is the invoicing
 * router's, for the till's pages only. No master here (`/auth/local/*` answers 404 off one), so its
 * answer is stood in for, and the PIN's reply is a real password session.
 */
test.describe('The PIN pad', () => {
  /** The sign-in page, returning to `path`: the one SPA's router writes `next` unencoded. */
  const signInTo = (path: string) => (url: URL) => url.pathname === '/auth/login' && url.searchParams.get('next') === path

  async function offerPin(page: any) {
    await page.route('**/api/auth/local/methods', (route: any) => route.fulfill({ json: { pin: true, password: true } }))
  }

  test('a till page with no session opens the pad, and the PIN brings the tab back', async ({ page }) => {
    await offerPin(page)
    const login = await fetch(`${API}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orgSlug: 'acme-corp', username: 'admin', password: 'test123' }),
    }).then(r => r.json())
    await page.route('**/api/auth/local/pin', (route: any) => route.fulfill({ json: { token: login.token, org: login.org } }))

    await page.goto('/invoicing/cash-register/sessions')
    // `to` is as this router names the page: the one SPA's carries the module's base.
    await expect(page).toHaveURL(/\/invoicing\/pin\?to=(\/invoicing)?\/cash-register\/sessions$/)
    await expect(page.getByTestId('pin-pad')).toBeVisible({ timeout: 15000 })

    await page.getByTestId('pin-operator').locator('input').fill('0001')
    await page.getByTestId('pin-pin').locator('input').fill('482915')
    await page.getByTestId('pin-submit').click()
    await expect(page).toHaveURL(/\/invoicing\/cash-register\/sessions$/, { timeout: 15000 })
    await expect(page.getByRole('heading', { name: 'CR Sessions' })).toBeVisible({ timeout: 15000 })
  })

  test('every other invoicing page keeps the portal\'s sign-in, wherever a PIN is on offer', async ({ page }) => {
    await offerPin(page)
    await page.goto('/invoicing/invoices')
    await expect(page).toHaveURL(signInTo('/invoicing/invoices'), { timeout: 15000 })
  })

  // It used to go to the plain sign-in, and the person landed on the dashboard.
  test('the pad\'s password link keeps the page', async ({ page }) => {
    await offerPin(page)
    const sale = '/invoicing/cash-sales/6a1b2c3d4e5f60718293a4b5/view'
    await page.goto(sale)
    await expect(page).toHaveURL(/\/invoicing\/pin\?to=/)
    await page.getByRole('link', { name: /password/i }).click()
    await expect(page).toHaveURL(signInTo(sale), { timeout: 15000 })
  })

  test('a PIN that cannot sell lands on the journal', async ({ page }) => {
    const reader = `pin-reader-${Date.now()}`
    await userWith(reader, ['pos.read'])
    await offerPin(page)
    const login = await fetch(`${API}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orgSlug: 'acme-corp', username: reader, password: PASSWORD }),
    }).then(r => r.json())
    await page.route('**/api/auth/local/pin', (route: any) => route.fulfill({ json: { token: login.token, org: login.org } }))

    await page.goto('/invoicing/pin')
    await page.getByTestId('pin-operator').locator('input').fill('0001')
    await page.getByTestId('pin-pin').locator('input').fill('482915')
    await page.getByTestId('pin-submit').click()
    await expect(page).toHaveURL(/\/invoicing\/cash-sales$/, { timeout: 15000 })
  })

  test('off a master a till page goes to the portal\'s sign-in too', async ({ page }) => {
    await page.goto('/invoicing/cash-sales/new')
    await expect(page).toHaveURL(signInTo('/invoicing/cash-sales/new'), { timeout: 15000 })
  })

  test('the old pad answers at the new one, without its old `to`', async ({ page }) => {
    await offerPin(page)
    await page.goto('/pos/pin?to=%2Fterminal')
    await expect(page).toHaveURL(/\/invoicing\/pin$/)
    await expect(page.getByTestId('pin-pad')).toBeVisible({ timeout: 15000 })
  })
})
