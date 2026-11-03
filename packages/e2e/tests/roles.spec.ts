import { test, expect } from '@playwright/test'
import { loginForApp } from './helpers/login'
import { apiLogin, apiGet, apiPost } from './helpers/api'

/**
 * FR-26: the Seller („Продавач") and the Sales Consultant („Търговски консултант"), as the person
 * at the counter sees them (§2.1). What the server refuses is `integration/seller-roles.flow`'s.
 *
 * Each role's user has no permission set: the role's defaults carry its permissions and its areas,
 * exactly as an org that has not run migration 0014 yet would issue them.
 *
 * Serial: the tests share the two users, whose creation is the expensive part.
 */
test.describe.configure({ mode: 'serial' })

const PASSWORD = 'test12345'
const stamp = Date.now()
const users = { seller: `seller-${stamp}`, sales_consultant: `consultant-${stamp}` } as const

async function menuTexts(page: any, group: RegExp | string): Promise<string[]> {
  await page.locator('.top-menu-inline').getByRole('button', { name: group }).click()
  const items = page.locator('.v-overlay--active .v-list-item')
  await expect(items.first()).toBeVisible()
  const texts = (await items.allInnerTexts()).map((t: string) => t.trim())
  await page.keyboard.press('Escape')
  return texts
}

async function topMenu(page: any): Promise<string[]> {
  return (await page.locator('.top-menu-inline').getByRole('button').allInnerTexts()).map((t: string) => t.trim())
}

test.describe('The Seller and the Sales Consultant', () => {
  test.beforeAll(async () => {
    const admin = await apiLogin()
    for (const [role, username] of Object.entries(users)) {
      const res = await apiPost(admin, '/user', {
        email: `${username}@acme.com`, username, password: PASSWORD, firstName: 'Counter', lastName: role, role,
      })
      expect(res.ok, `create the ${role} → ${res.status}`).toBe(true)
    }
  })

  test('the App Hub API gives each Invoicing and Inventory, and the claim names their areas', async () => {
    for (const [role, username] of Object.entries(users)) {
      const session = await apiLogin('acme-corp', username, PASSWORD)
      const { apps } = await apiGet(session, '/apps')
      expect({ role, apps: apps.map((a: any) => a.id).sort() }).toEqual({ role, apps: ['inventory', 'invoicing'] })
      const claims = JSON.parse(Buffer.from(session.token.split('.')[1], 'base64url').toString('utf8'))
      expect({ role, areas: claims.areas }).toEqual({ role, areas: role === 'seller' ? [] : ['orders'] })
    }
  })

  test('the portal is no place of theirs: /apps lands on Invoicing, and the switcher has no Portal tile', async ({ page }) => {
    await loginForApp(page, 'acme-corp', users.seller, PASSWORD)
    for (const path of ['/apps', '/dashboard', '/settings/users']) {
      await page.goto(path)
      await expect(page, path).toHaveURL(/\/invoicing\//, { timeout: 15000 })
    }
    await page.locator('button:has(.mdi-apps)').first().click()
    const tiles = page.locator('.v-overlay--active .app-tile')
    await expect(tiles.first()).toBeVisible()
    expect((await tiles.allInnerTexts()).map(t => t.trim()).sort()).toEqual(['Inventory', 'Invoicing'])
    await expect(page.locator('.v-overlay--active').getByText('Portal', { exact: true })).toHaveCount(0)
  })

  test('the Seller\'s invoicing menu: no Orders, no incoming documents, no payments, no Sequences', async ({ page }) => {
    await loginForApp(page, 'acme-corp', users.seller, PASSWORD)
    await page.goto('/invoicing/invoices')
    await expect(page.locator('.top-menu-inline')).toBeVisible({ timeout: 15000 })
    const groups = await topMenu(page)
    expect(groups.join('|')).not.toMatch(/orders|incoming|payments/i)
    expect(await menuTexts(page, /Configuration/)).toEqual(['Contacts', 'Devices'])
  })

  test('the Sales Consultant\'s has the Orders group too', async ({ page }) => {
    await loginForApp(page, 'acme-corp', users.sales_consultant, PASSWORD)
    await page.goto('/invoicing/invoices')
    await expect(page.locator('.top-menu-inline')).toBeVisible({ timeout: 15000 })
    expect((await topMenu(page)).join('|')).toMatch(/orders/i)
    expect((await topMenu(page)).join('|')).not.toMatch(/incoming|payments/i)
  })

  test('the inventory menu: products, categories, warehouses and the movement documents', async ({ page }) => {
    await loginForApp(page, 'acme-corp', users.seller, PASSWORD)
    await page.goto('/inventory/products')
    await expect(page.locator('.top-menu-inline')).toBeVisible({ timeout: 15000 })
    expect((await topMenu(page)).join('|')).not.toMatch(/price lists/i)
    expect(await menuTexts(page, /^Products$/)).toEqual(['Products', 'Categories'])
    expect(await menuTexts(page, /^Warehouse$/)).toEqual(['Warehouses', 'Stock Movement Documents'])
    // Read-only: no Create, and no Export.
    await expect(page.getByRole('link', { name: /create/i })).toHaveCount(0)
    await expect(page.getByRole('button', { name: /^export$/i })).toHaveCount(0)
  })

  test('the movement form offers Transfer only, and the list names it a stock movement', async ({ page }) => {
    await loginForApp(page, 'acme-corp', users.seller, PASSWORD)
    await page.goto('/inventory/movements')
    await expect(page.getByRole('link', { name: /new stock movement/i })).toBeVisible({ timeout: 15000 })
    await page.goto('/inventory/movements/new')
    const type = page.getByRole('combobox', { name: /type/i }).first()
    await expect(type).toBeVisible({ timeout: 15000 })
    await expect(page.locator('.v-select').first()).toContainText('Transfer')
    await page.locator('.v-select').first().locator('.v-field').click()
    const options = page.locator('.v-overlay--active .v-list-item')
    await expect(options.first()).toBeVisible()
    expect((await options.allInnerTexts()).map(t => t.trim())).toEqual(['Transfer'])
  })
})
