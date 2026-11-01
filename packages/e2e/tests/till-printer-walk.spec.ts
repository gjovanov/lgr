import { test, expect } from '@playwright/test'
import { apiLogin } from './helpers/api'
import { installFakeSerial, serialStats } from './helpers/fake-serial'
import { loginForApp } from './helpers/login'
import { SESSION_FILES, filesGone } from './helpers/nav'

const API = process.env.BASE_URL || 'http://localhost:4001'
const PASSWORD = 'test12345'

/**
 * FR-24's point: moving between the till and an invoice is a router push, not a page load, because a
 * page load closes the tab's Web Serial port and the cashier is back at the port picker. No other
 * test notices a stray page load, so this walks the menu with a printer bridged and watches the
 * document. The port is `helpers/fake-serial.ts`; the bridge and its WebSocket are real.
 *
 * Its own warehouse, device and cashier: a connected device prints every sale on its warehouse, and
 * an open session is what `pos-terminal.spec.ts` must not find, so nothing here may touch the seed's.
 * Serial, on one page: the walk is what is being tested.
 */
test.describe.configure({ mode: 'serial' })

const run = Date.now().toString(36)
const username = `e2e-walk-${run}`
const deviceNumber = `W${run}`.slice(0, 8).padEnd(8, '0').toUpperCase()

type Session = Awaited<ReturnType<typeof apiLogin>>
async function call(s: Session, method: string, path: string, body?: unknown) {
  const res = await fetch(`${API}/api/org/${s.orgId}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${s.token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const json = await res.json().catch(() => null)
  return { status: res.status, json }
}
const ok = async (s: Session, method: string, path: string, body?: unknown) => {
  const r = await call(s, method, path, body)
  expect(r.status, `${method} ${path} → ${r.status} ${JSON.stringify(r.json)}`).toBeLessThan(300)
  return r.json
}

let admin: Session
let cashier: Session
let userId = ''
let warehouseId = ''
let deviceId = ''
let sessionId = ''

/** Through the menu, as a cashier gets there: `page.goto` would be the page load this looks for. */
async function menu(page: any, group: RegExp, entry: string) {
  await page.locator('.top-menu-inline').getByRole('button', { name: group }).click()
  await page.locator('.v-overlay--active .v-list-item').filter({ hasText: entry }).first().click()
}

/** The cashier at the terminal, the printer bridged. */
async function connectedTill(page: any) {
  await installFakeSerial(page)
  await loginForApp(page, 'acme-corp', username, PASSWORD)
  await page.goto('/invoicing/cash-sales/new')
  await page.getByRole('button', { name: /Connect Printer/i }).click()
  await expect(page.getByTestId('shell-bridge-chip')).toContainText(deviceNumber, { timeout: 15000 })
}

async function stillOneDocument(page: any, where: string) {
  expect(await page.evaluate(() => (window as any).__walk), `the document was replaced by ${where}`).toBe('one document')
}

test.describe('The printer, while the cashier moves around', () => {
  test.beforeAll(async () => {
    admin = await apiLogin()
    const { warehouse } = await ok(admin, 'POST', '/warehouse/warehouse', { name: `Walk ${run}`, code: `WK-${run}`, type: 'store' })
    warehouseId = warehouse.id || warehouse._id
    const { user } = await ok(admin, 'POST', '/user', {
      email: `${username}@lgr.test`, username, password: PASSWORD, firstName: 'E2E', lastName: 'Walk', role: 'sales',
    })
    userId = user.id || user._id
    cashier = await apiLogin('acme-corp', username, PASSWORD)
    const { fiscalDevice } = await ok(admin, 'POST', '/fiscal/device', {
      name: `Walk ${run}`, deviceNumber, manufacturer: 'datecs', connectionType: 'browser', warehouseId,
    })
    deviceId = fiscalDevice.id || fiscalDevice._id
    const { session } = await ok(cashier, 'POST', '/trade/pos/session', { warehouseId, openingBalance: 0, currency: 'EUR' })
    sessionId = session.id || session._id
  })

  test.afterAll(async () => {
    // Each on its own: one left behind must not leave the others. The device first: with it gone
    // no Z-report is owed, and a cashier may close, where `closeWithoutFiscal` asks for a manager.
    const steps = [
      deviceId && call(admin, 'DELETE', `/fiscal/device/${deviceId}`),
      sessionId && call(cashier, 'POST', `/trade/pos/session/${sessionId}/close`, { closingBalance: 0 }),
      warehouseId && call(admin, 'DELETE', `/warehouse/warehouse/${warehouseId}`),
      userId && call(admin, 'DELETE', `/user/${userId}`),
    ]
    const answers = await Promise.all(steps.map(async s => (s ? (await s).status : 200)))
    expect(answers.filter(s => s >= 300)).toEqual([])
  })

  test('stays connected from the terminal through invoicing and back, with no page load', async ({ page }) => {
    await connectedTill(page)

    // Anything that replaces the document loses this.
    await page.evaluate(() => { (window as any).__walk = 'one document' })
    let documents = 0
    page.on('domcontentloaded', () => { documents++ })

    await menu(page, /Outgoing/, 'Sales Documents')
    await expect(page).toHaveURL(/\/invoicing\/invoices$/)
    await stillOneDocument(page, 'the invoices')

    // An invoice being written, the hop a shop makes all day.
    await page.locator('a.v-btn', { hasText: /create|new/i }).first().click()
    await expect(page).toHaveURL(/\/invoicing\/invoices\/new/)
    await stillOneDocument(page, 'a new invoice')

    await menu(page, /Outgoing/, 'CR Sales')
    await expect(page).toHaveURL(/\/invoicing\/cash-sales$/)
    await menu(page, /Outgoing/, 'CR Sessions')
    await expect(page).toHaveURL(/\/invoicing\/cash-register\/sessions$/)
    await menu(page, /Configuration/, 'Devices')
    await expect(page).toHaveURL(/\/invoicing\/configuration\/devices$/)
    await stillOneDocument(page, 'the devices')

    await menu(page, /Outgoing/, 'CS Terminal')
    await expect(page).toHaveURL(/\/invoicing\/cash-sales\/new$/)
    await expect(page.getByRole('heading', { name: 'CS Terminal' })).toBeVisible({ timeout: 15000 })

    await stillOneDocument(page, 'the walk')
    expect(documents).toBe(0)
    expect(await serialStats(page)).toMatchObject({ requested: 1, opened: 1, closed: 0 })
    await expect(page.getByTestId('shell-bridge-chip')).toContainText(deviceNumber)
    // No picker again, and the terminal's own chip agrees with the shell's.
    await expect(page.getByRole('button', { name: /Connect Printer/i })).toHaveCount(0)
    await expect(page.locator('.v-chip').filter({ hasText: deviceNumber }).first()).toBeVisible()

    // The server still reaches the port: the same socket, the same bridge.
    const { fiscalDevices } = await ok(admin, 'GET', '/fiscal/device?size=100')
    const held = fiscalDevices.find((d: any) => (d.id || d._id) === deviceId)
    expect({ connected: held.connected, bridgedBy: held.bridgedBy?.kind }).toEqual({ connected: true, bridgedBy: 'user' })
    const before = (await serialStats(page)).written
    await call(admin, 'GET', `/fiscal/device/${deviceId}/status`)
    expect((await serialStats(page)).written).toBeGreaterThan(before)
    expect(documents).toBe(0)

  })

  test('another module keeps the printer too: one document serves them all', async ({ page }) => {
    await connectedTill(page)
    await page.evaluate(() => { (window as any).__walk = 'one document' })

    await page.locator('button:has(.mdi-apps)').click()
    await page.locator('.v-overlay--active').getByText('Inventory', { exact: true }).click()
    await expect(page).toHaveURL(/\/inventory\//, { timeout: 15000 })

    await stillOneDocument(page, 'Inventory')
    await expect(page.getByTestId('shell-bridge-chip')).toContainText(deviceNumber)
    expect(await serialStats(page)).toMatchObject({ opened: 1, closed: 0 })
  })

  // FR-24.14. A deploy took the files of a page this tab has not opened yet, and a page load closes
  // the port. So the tab asks, the printer stays up, and the person decides when.
  test('a page whose files are gone asks first, and the printer stays up until the person says', async ({ page }) => {
    await connectedTill(page)
    await page.evaluate(() => { (window as any).__walk = 'one document' })
    await filesGone(page)

    await menu(page, /Outgoing/, 'CR Sessions')

    await expect(page.getByText('A new version of LGR is available.')).toBeVisible({ timeout: 15000 })
    await expect(page).toHaveURL(/\/invoicing\/cash-sales\/new$/)
    await stillOneDocument(page, 'the move that failed')
    await expect(page.getByTestId('shell-bridge-chip')).toContainText(deviceNumber)
    expect(await serialStats(page)).toMatchObject({ requested: 1, opened: 1, closed: 0 })

    // The server still reaches the port.
    const before = (await serialStats(page)).written
    await call(admin, 'GET', `/fiscal/device/${deviceId}/status`)
    expect((await serialStats(page)).written).toBeGreaterThan(before)

    await page.getByRole('button', { name: 'Reload' }).click()
    await expect.poll(() => page.evaluate(() => (window as any).__walk ?? 'replaced'), { timeout: 15000 }).toBe('replaced')
  })

  test('the old addresses lead to the terminal with the printer still to connect, as any load does', async ({ page }) => {
    await installFakeSerial(page)
    await loginForApp(page, 'acme-corp', username, PASSWORD)
    for (const old of ['/pos/terminal', '/invoicing/pos/terminal']) {
      await page.goto(old)
      await expect(page, old).toHaveURL(/\/invoicing\/cash-sales\/new$/)
      await expect(page.getByRole('button', { name: /Connect Printer/i })).toBeVisible({ timeout: 15000 })
    }
  })
})

/**
 * FR-24.14: `web/src/stale.ts`, in a browser, with no printer. A deploy takes the hashed files of
 * every page a tab has not opened yet, its script and its stylesheet both. `unit/failed-move.test.ts`
 * holds the rule; this is the real preload helper and the real router under it.
 */
test.describe('A move that fails', () => {
  const walk = async (page: any) => {
    await loginForApp(page, 'acme-corp', 'sales', 'test123')
    await page.goto('/invoicing/invoices')
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible({ timeout: 15000 })
    await page.evaluate(() => { (window as any).__walk = 'one document' })
  }

  async function arrives(page: any) {
    await expect(page).toHaveURL(/\/invoicing\/cash-register\/sessions$/, { timeout: 15000 })
    await expect(page.getByRole('heading', { name: 'CR Sessions' })).toBeVisible({ timeout: 15000 })
  }

  test('a page whose files are gone loads as a page, rather than the click doing nothing', async ({ page }) => {
    await walk(page)
    await filesGone(page)
    await menu(page, /Outgoing/, 'CR Sessions')
    await arrives(page)
    await expect.poll(() => page.evaluate(() => (window as any).__walk ?? 'replaced')).toBe('replaced')
  })

  // The real deploy's first failure: Vite waits for the stylesheet before it imports the script.
  test('the stylesheet alone gone is the same failure', async ({ page }) => {
    await walk(page)
    await filesGone(page, /\/ui\/PosSessionsView-[^/]+\.css$/)
    await menu(page, /Outgoing/, 'CR Sessions')
    await arrives(page)
  })

  test('with the server down the tab stays on its page, says so, and the click works once it is back', async ({ page }) => {
    await walk(page)
    await filesGone(page)
    await page.route('**/api/health', (route: any) => route.abort())

    await menu(page, /Outgoing/, 'CR Sessions')

    await expect(page.getByText('This page could not be loaded.')).toBeVisible({ timeout: 15000 })
    await expect(page).toHaveURL(/\/invoicing\/invoices$/)
    expect(await page.evaluate(() => (window as any).__walk)).toBe('one document')

    await page.unroute('**/api/health')
    await menu(page, /Outgoing/, 'CR Sessions')
    await arrives(page)
  })

  test('a page that cannot start says so, and is one click from working', async ({ page }) => {
    await loginForApp(page, 'acme-corp', 'sales', 'test123')
    await page.route(SESSION_FILES, (route: any) => route.abort())

    await page.goto('/invoicing/cash-register/sessions')

    const dead = page.getByTestId('dead-start')
    await expect(dead).toContainText('This page could not be loaded.', { timeout: 15000 })
    await page.unroute(SESSION_FILES)
    await dead.getByRole('button', { name: 'Reload' }).click()
    await arrives(page)
  })

  // Storage can throw: site data blocked, a locked-down webview. This script runs when nothing else
  // can, and it counted its retries there, so it threw and left a blank page.
  test('an entry that never arrives says so with no storage to count in', async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(window, 'sessionStorage', { get() { throw new DOMException('denied', 'SecurityError') } })
    })
    await page.route(/\/ui\/index-[^/]+\.js$/, (route: any) => route.abort())

    await page.goto('/invoicing/invoices')

    await expect(page.getByTestId('boot-failed')).toBeVisible({ timeout: 20000 })
  })

  test('an entry that never arrives says so too, once its retries are spent', async ({ page }) => {
    await loginForApp(page, 'acme-corp', 'sales', 'test123')
    const entry = /\/ui\/index-[^/]+\.js$/
    await page.route(entry, (route: any) => route.abort())

    await page.goto('/invoicing/invoices')

    await expect(page.getByTestId('boot-failed')).toBeVisible({ timeout: 20000 })
    await page.unroute(entry)
    await page.getByTestId('boot-failed').getByRole('button').click()
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible({ timeout: 15000 })
  })
})
