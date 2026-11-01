import { test, expect } from '@playwright/test'
import { apiGet, apiLogin } from './helpers/api'
import { closeTillSession, openTillSession, ownCashier, type OwnCashier } from './helpers/cash-register'
import { loginForApp } from './helpers/login'
import { SESSION_FILES, filesBlip, filesGone } from './helpers/nav'
import { BETA } from './helpers/org-switcher'

/**
 * The terminal sits behind the same menu as everything else now, a click from any invoice, and its
 * cart lives in the view. So a filled cart asks before anything takes the person off the page: the
 * menu, ★, „+ Нов", Back. Nobody loses a cart without being asked, and whoever means to leave can.
 *
 * A cashier of its own per test: the session is what the terminal shows, and the seed's is shared.
 */
let cashier: OwnCashier
let tillId = ''

const cartLine = (page: any) => page.locator('[data-testid^="cart-line-"]')
const dialog = (page: any) => page.getByTestId('leave-cart-dialog')

async function fillCart(page: any) {
  await expect(page.getByTestId('register-card').first()).toBeVisible({ timeout: 15000 })
  await page.getByTestId('register-card').first().click()
  await expect(cartLine(page).first()).toBeVisible()
}

async function menu(page: any, group: RegExp, entry: string) {
  await page.locator('.top-menu-inline').getByRole('button', { name: group }).click()
  await page.locator('.v-overlay--active .v-list-item').filter({ hasText: entry }).first().click()
}

async function stayed(page: any) {
  await page.getByTestId('leave-cart-stay').click()
  await expect(dialog(page)).toHaveCount(0)
  await expect(page).toHaveURL(/\/invoicing\/cash-sales\/new$/)
  await expect(cartLine(page).first()).toBeVisible()
}

/** The sale's POST on its way: `what` decides what becomes of it. */
const SALE = '**/trade/pos/session/*/transaction'
async function onTheSale(page: any, what: (route: any) => Promise<void>) {
  await page.route(SALE, (route: any) => (route.request().method() === 'POST' ? what(route) : route.fallback()))
}

/** The sale held on its way, as a slow printer holds it, until the function returned lets it on. */
async function holdTheSale(page: any): Promise<() => void> {
  let letGo = () => {}
  const released = new Promise<void>((resolve) => { letGo = resolve })
  await onTheSale(page, async (route) => {
    await released
    await route.continue()
  })
  return letGo
}

/** The server books the sale, and the till never hears. */
const loseTheAnswer = (page: any) => onTheSale(page, async (route) => {
  await route.fetch()
  await route.abort('connectionreset')
})

/** What the browser asks from here on, each answered "leave": no question stops a load here. */
function questions(page: any): string[] {
  const asked: string[] = []
  page.on('dialog', async (d: any) => {
    asked.push(d.type())
    await d.accept()
  })
  return asked
}

/** F5, and the browser's question answered. "stay" leaves the reload unfinished, so nothing waits on it. */
async function f5(page: any, answer: 'stay' | 'leave') {
  const question = page.waitForEvent('dialog', { timeout: 10000 })
  page.reload().catch(() => {})
  const asked = await question
  expect(asked.type()).toBe('beforeunload')
  await (answer === 'stay' ? asked.dismiss() : asked.accept())
}

const reloadSpared = async (page: any) => {
  await expect(cartLine(page).first()).toBeVisible()
  expect(await page.evaluate(() => (window as any).__walk)).toBe('one document')
}

test.describe('A filled cart', () => {
  test.beforeEach(async ({ page }) => {
    cashier = await ownCashier('cart')
    tillId = (await openTillSession(cashier.session)).id
    await loginForApp(page, 'acme-corp', cashier.username, cashier.password)
    await page.goto('/invoicing/cash-sales/new')
  })

  test.afterEach(async () => {
    await closeTillSession(tillId, cashier.session)
    await cashier.drop()
  })

  test('a menu entry asks: staying keeps the cart, leaving leaves', async ({ page }) => {
    await fillCart(page)

    await menu(page, /Outgoing/, 'Sales Documents')
    await expect(dialog(page)).toBeVisible()
    await stayed(page)

    await menu(page, /Outgoing/, 'Sales Documents')
    await page.getByTestId('leave-cart-go').click()
    await expect(page).toHaveURL(/\/invoicing\/invoices$/)
  })

  test('„+ Нов" asks', async ({ page }) => {
    await fillCart(page)

    await page.getByTestId('new-document-menu').click()
    await page.getByTestId('new-document-list').locator('.v-list-item').filter({ hasText: 'Outgoing invoice' }).click()
    await expect(dialog(page)).toBeVisible()
    await stayed(page)

    await page.getByTestId('new-document-menu').click()
    await page.getByTestId('new-document-list').locator('.v-list-item').filter({ hasText: 'Outgoing invoice' }).click()
    await page.getByTestId('leave-cart-go').click()
    await expect(page).toHaveURL(/\/invoicing\/invoices\/new/)
  })

  test('★ asks', async ({ page }) => {
    await page.goto('/invoicing/contacts')
    await page.getByTestId('favorites-menu').click()
    await page.getByTestId('favorites-pin-current').click()
    await page.keyboard.press('Escape')
    await menu(page, /Outgoing/, 'CS Terminal')
    await fillCart(page)

    await page.getByTestId('favorites-menu').click()
    await page.locator('.v-overlay--active .v-list-item').filter({ hasText: 'Contacts' }).click()
    await expect(dialog(page)).toBeVisible()
    await page.getByTestId('leave-cart-go').click()
    await expect(page).toHaveURL(/\/invoicing\/contacts$/)
  })

  test('Back asks', async ({ page }) => {
    await page.goto('/invoicing/invoices')
    await menu(page, /Outgoing/, 'CS Terminal')
    await fillCart(page)

    await page.goBack()
    await expect(dialog(page)).toBeVisible()
    await stayed(page)
  })

  test('an empty cart leaves without a word', async ({ page }) => {
    await expect(page.getByTestId('register-card').first()).toBeVisible({ timeout: 15000 })
    await menu(page, /Outgoing/, 'Sales Documents')
    await expect(page).toHaveURL(/\/invoicing\/invoices$/)
    await expect(dialog(page)).toHaveCount(0)
  })

  test('nor does a sale that was completed', async ({ page }) => {
    await fillCart(page)
    await page.getByTestId('complete-sale').click()
    await expect(page.getByTestId('last-sale-number')).toBeVisible({ timeout: 15000 })
    await menu(page, /Outgoing/, 'Sales Documents')
    await expect(page).toHaveURL(/\/invoicing\/invoices$/)
    await expect(dialog(page)).toHaveCount(0)
  })

  // The other way off the page: a page load the app starts itself. It counts the cart as work.
  test('a page whose files are gone does not reload a filled cart away', async ({ page }) => {
    await fillCart(page)
    await page.evaluate(() => { (window as any).__walk = 'one document' })
    await filesGone(page)

    await menu(page, /Outgoing/, 'CR Sessions')
    await page.getByTestId('leave-cart-go').click()

    await expect(page.getByText('A new version of LGR is available.')).toBeVisible({ timeout: 15000 })
    await expect(page).toHaveURL(/\/invoicing\/cash-sales\/new$/)
    expect(await page.evaluate(() => (window as any).__walk)).toBe('one document')
    await expect(cartLine(page).first()).toBeVisible()

    // Its Reload is a page load the person starts, and asked about as F5 is: the cart is still here.
    // Answered from a handler: the question stalls the click that raises it.
    let asked = ''
    page.once('dialog', async (d: any) => {
      asked = d.type()
      await d.dismiss()
    })
    await page.getByRole('button', { name: 'Reload' }).click()
    await expect.poll(() => asked).toBe('beforeunload')
    await reloadSpared(page)
  })

  // No deploy, only a file that did not arrive. Calling that a new version is what forced a page
  // load on the next move, cart or none.
  test('a chunk that fails with the same build is no new version', async ({ page }) => {
    await fillCart(page)
    await filesBlip(page)

    await menu(page, /Outgoing/, 'CR Sessions')
    await page.getByTestId('leave-cart-go').click()

    await expect(page.getByTestId('move-failed')).toContainText('This page could not be loaded.', { timeout: 15000 })
    await expect(page.getByTestId('new-build')).toHaveCount(0)
    await expect(page).toHaveURL(/\/invoicing\/cash-sales\/new$/)
    await expect(cartLine(page).first()).toBeVisible()

    // The file is back, and the same click gets there.
    await page.unroute(SESSION_FILES)
    await menu(page, /Outgoing/, 'CR Sessions')
    await page.getByTestId('leave-cart-go').click()
    await expect(page).toHaveURL(/\/invoicing\/cash-register\/sessions$/, { timeout: 15000 })
  })

  // A move refused for a sale that is printing. The person sees how it ended.
  test('a sale on its way cannot be left, and the question closes by itself', async ({ page }) => {
    await fillCart(page)
    const letGo = await holdTheSale(page)
    await page.getByTestId('complete-sale').click()

    await menu(page, /Outgoing/, 'Sales Documents')
    await expect(dialog(page)).toContainText('printing')
    await expect(dialog(page)).not.toContainText('not sold yet')
    await expect(page.getByTestId('leave-cart-go')).toHaveCount(0)
    await expect(page).toHaveURL(/\/invoicing\/cash-sales\/new$/)

    letGo()
    await expect(page.getByTestId('last-sale-number')).toBeVisible({ timeout: 15000 })
    await expect(dialog(page)).toHaveCount(0)
    await expect(page).toHaveURL(/\/invoicing\/cash-sales\/new$/)
  })

  // The basket of a sale under way is what a lost answer's retry must find unchanged.
  test('nothing changes the basket while its sale is on its way', async ({ page }) => {
    await fillCart(page)
    const letGo = await holdTheSale(page)
    await page.getByTestId('complete-sale').click()

    await page.getByTestId('register-card').nth(1).click()
    await page.getByTestId('register-card').first().click()
    await expect(cartLine(page)).toHaveCount(1)
    await expect(page.getByTestId('cart-qty').first().locator('input')).toHaveValue('1')

    letGo()
    await expect(page.getByTestId('last-sale-number')).toBeVisible({ timeout: 15000 })
  })

  test('a lost answer says what is true, and the screen keeps it to one sale', async ({ page }) => {
    await fillCart(page)
    await loseTheAnswer(page)
    await page.getByTestId('complete-sale').click()
    await expect(page.getByTestId('sale-unknown')).toBeVisible({ timeout: 15000 })

    // The one sale this screen can still make is the one it sent: no other body, no other key.
    await expect(page.getByTestId('register-card')).toHaveCount(0)
    await expect(page.getByTestId('cart-qty')).toHaveCount(0)
    await expect(page.getByRole('combobox', { name: /Payment Method/i })).toBeDisabled()
    await expect(page.getByLabel(/Non-fiscal/i)).toBeDisabled()
    await expect(page.getByRole('button', { name: /Close Session/i })).toBeDisabled()

    await menu(page, /Outgoing/, 'Sales Documents')
    await expect(dialog(page)).toContainText('may already be booked')
    await expect(dialog(page)).toContainText('CR Sales')
    await expect(dialog(page)).not.toContainText('not sold yet')
    await stayed(page)

    await page.unroute(SALE)
    await page.getByTestId('complete-sale').click()
    await expect(page.getByTestId('last-sale-number')).toBeVisible({ timeout: 15000 })
    await expect(page.getByTestId('register-card').first()).toBeVisible()
    await expect(page.getByRole('textbox', { name: /Search products/i })).toBeFocused()

    const { transactions } = await apiGet(cashier.session, `/trade/pos/session/${tillId}/transaction`)
    expect(transactions).toHaveLength(1)
  })

  // What only the browser can ask about: F5, the tab closed, an address typed.
  test('F5 asks: staying keeps the cart, leaving reloads', async ({ page }) => {
    await fillCart(page)
    await page.evaluate(() => { (window as any).__walk = 'one document' })

    await f5(page, 'stay')
    await reloadSpared(page)

    await f5(page, 'leave')
    await expect(page.getByTestId('register-card').first()).toBeVisible({ timeout: 15000 })
    await expect(cartLine(page)).toHaveCount(0)
  })

  test('F5 asks while a sale is on its way', async ({ page }) => {
    await fillCart(page)
    await page.evaluate(() => { (window as any).__walk = 'one document' })
    const letGo = await holdTheSale(page)
    await page.getByTestId('complete-sale').click()

    await f5(page, 'stay')
    await reloadSpared(page)

    letGo()
    await expect(page.getByTestId('last-sale-number')).toBeVisible({ timeout: 15000 })
  })

  test('F5 asks after a lost answer', async ({ page }) => {
    await fillCart(page)
    await page.evaluate(() => { (window as any).__walk = 'one document' })
    await loseTheAnswer(page)
    await page.getByTestId('complete-sale').click()
    await expect(page.getByTestId('sale-unknown')).toBeVisible({ timeout: 15000 })

    await f5(page, 'stay')
    await reloadSpared(page)
  })

  test('F5 asks nothing of a cart emptied, or of a sale completed', async ({ page }) => {
    const asked = questions(page)
    await fillCart(page)
    await cartLine(page).first().getByRole('button', { name: 'Delete' }).click()
    await expect(cartLine(page)).toHaveCount(0)
    await page.reload()

    await fillCart(page)
    await page.getByTestId('complete-sale').click()
    await expect(page.getByTestId('last-sale-number')).toBeVisible({ timeout: 15000 })
    await page.reload()

    await expect(page.getByTestId('register-card').first()).toBeVisible({ timeout: 15000 })
    expect(asked).toEqual([])
  })

  // The rule's page load: a filled cart stops it first (above), so an empty one goes unasked.
  test('a page whose files are gone loads with no question, the cart being empty', async ({ page }) => {
    const asked = questions(page)
    await fillCart(page)
    await cartLine(page).first().getByRole('button', { name: 'Delete' }).click()
    await expect(cartLine(page)).toHaveCount(0)
    await page.evaluate(() => { (window as any).__walk = 'one document' })
    await filesGone(page)

    await menu(page, /Outgoing/, 'CR Sessions')

    await expect(page).toHaveURL(/\/invoicing\/cash-register\/sessions$/, { timeout: 15000 })
    await expect(page.getByRole('heading', { name: 'CR Sessions' })).toBeVisible({ timeout: 15000 })
    await expect.poll(() => page.evaluate(() => (window as any).__walk ?? 'replaced')).toBe('replaced')
    expect(asked).toEqual([])
  })
})

/**
 * An org switch is the other page load the app starts itself. It is refused while a cart holds
 * lines, so it never meets the browser's question, unless a line lands while the switch is on its
 * way: by then the tab's session is in the other org, and „stay" would keep a page nothing answers.
 */
test.describe('A filled cart and an org switch', () => {
  let multi: Awaited<ReturnType<typeof apiLogin>>
  let till = ''
  const SWITCH = '**/api/auth/switch'
  const orgEntry = (page: any) => page.getByTestId('org-switcher-org').filter({ hasText: BETA })

  test.beforeEach(async ({ page }) => {
    multi = await apiLogin('acme-corp', 'multi', 'test123')
    till = (await openTillSession(multi)).id
    await loginForApp(page, 'acme-corp', 'multi', 'test123')
    await page.goto('/invoicing/cash-sales/new')
    await expect(page.getByTestId('register-card').first()).toBeVisible({ timeout: 15000 })
  })

  test.afterEach(async () => {
    await closeTillSession(till, multi)
  })

  test('is refused, and nothing is asked', async ({ page }) => {
    const asked = questions(page)
    await fillCart(page)
    await page.evaluate(() => { (window as any).__walk = 'one document' })

    await page.getByTestId('org-switcher').click()
    await orgEntry(page).click()

    await expect(page.getByText(/sale/i).filter({ hasText: /finish|complete|progress/i }).first()).toBeVisible()
    await page.keyboard.press('Escape')
    await reloadSpared(page)
    expect(asked).toEqual([])
  })

  test('that started with the cart empty is not stopped by a line added on its way', async ({ page }) => {
    const asked = questions(page)
    let letGo = () => {}
    const released = new Promise<void>((resolve) => { letGo = resolve })
    await page.route(SWITCH, async (route: any) => {
      await released
      await route.continue()
    })

    await page.getByTestId('org-switcher').click()
    await orgEntry(page).click()
    await page.getByTestId('register-card').first().click()
    await expect(cartLine(page).first()).toBeVisible()
    letGo()

    await expect(page.getByTestId('org-switcher')).toContainText(BETA, { timeout: 15000 })
    expect(asked).toEqual([])
  })
})
