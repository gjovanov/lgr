import { test, expect } from '@playwright/test'
import { loginAsAdmin, loginForApp } from './helpers/login'
import { leaveNavDrawer, navDrawer, openNavDrawer } from './helpers/nav'

test.describe('Navigation', () => {
  test('should show sidebar navigation drawer after login', async ({ page }) => {
    await loginAsAdmin(page)

    // The v-navigation-drawer should be visible
    await expect(navDrawer(page)).toBeVisible()

    // Dashboard link is always visible in the sidebar (v-list-item with to="/dashboard")
    await expect(navDrawer(page).getByRole('link', { name: /dashboard/i })).toBeVisible()
  })

  test('should display portal nav items in sidebar', async ({ page }) => {
    await loginAsAdmin(page)

    const drawer = await openNavDrawer(page)

    // Portal sidebar items: Apps, Dashboard, Organization, Users & Roles, Invites, Billing, Audit Log
    const navItems = [
      'Apps',
      'Dashboard',
      'Organization',
      'Users',
      'Invites',
      'Billing',
      'Audit Log',
    ]

    for (const item of navItems) {
      await expect(
        drawer.locator('.v-list-item-title', { hasText: new RegExp(item, 'i') })
      ).toBeVisible()
    }
  })

  test('should navigate to settings/organization when clicking Organization link', async ({ page }) => {
    await loginAsAdmin(page)

    await (await openNavDrawer(page)).getByText('Organization').first().click()
    await page.waitForURL('**/settings/organization', { timeout: 10000 })
    await expect(page).toHaveURL(/settings\/organization/)
  })

  test('should navigate to settings/users when clicking Users link', async ({ page }) => {
    await loginAsAdmin(page)

    await (await openNavDrawer(page)).getByText(/users/i).first().click()
    await page.waitForURL('**/settings/users', { timeout: 10000 })
    await expect(page).toHaveURL(/settings\/users/)
  })

  test('should toggle sidebar drawer open and close', async ({ page }) => {
    await loginAsAdmin(page)

    // Sidebar should be visible initially
    const drawer = await openNavDrawer(page)
    await expect(drawer).toBeVisible()

    // The drawer uses the "permanent" prop, so it stays in the DOM.
    // Toggling v-model changes the --is-active class / translate transform.
    // Verify the nav icon button is clickable and triggers a state change.
    const navIcon = page.locator('.v-app-bar').locator('button').first()
    await leaveNavDrawer(page)
    await navIcon.click()

    // Wait for animation
    await page.waitForTimeout(500)

    // With "permanent", the drawer stays in DOM but Vuetify adds a translate
    // transform to slide it offscreen. Click again to toggle back.
    await navIcon.click()

    // Wait for animation
    await page.waitForTimeout(500)

    // The navigation drawer should still be visible (permanent drawer)
    await expect(drawer).toBeVisible()
  })

  test('should toggle theme between dark and light', async ({ page }) => {
    await loginAsAdmin(page)

    // Get the initial theme (use .first() as Vuetify may create multiple .v-application elements)
    const appEl = page.locator('.v-application').first()
    const initialClass = await appEl.getAttribute('class')
    const initialIsDark = initialClass?.includes('v-theme--dark')

    // Find the theme toggle button by its icon (mdi-weather-night or mdi-weather-sunny)
    const themeBtn = page.locator('.v-app-bar').locator('button').filter({
      has: page.locator('.mdi-weather-night, .mdi-weather-sunny'),
    })
    await expect(themeBtn).toBeVisible({ timeout: 5000 })
    await themeBtn.click()

    // Wait for theme class to change on the v-application element
    await page.waitForFunction(
      (wasDark) => {
        const cls = document.querySelector('.v-application')?.className || ''
        const isDark = cls.includes('v-theme--dark')
        return isDark !== wasDark
      },
      initialIsDark ?? false,
      { timeout: 5000 },
    )

    // After toggling, check theme changed
    const afterClass = await appEl.getAttribute('class')
    const afterIsDark = afterClass?.includes('v-theme--dark')

    // The theme should have changed
    expect(initialIsDark).not.toBe(afterIsDark)
  })

  test('should logout from the user menu in the app bar', async ({ page }) => {
    await loginAsAdmin(page)

    // Open the user menu by clicking the user button in the app bar (v-btn with v-avatar inside)
    await page.locator('.v-app-bar').locator('button').filter({ has: page.locator('.v-avatar') }).click()

    // Wait for menu to open
    await page.waitForTimeout(300)

    // Click the Sign Out menu item (v-list-item with i18n key: auth.logout = "Sign Out")
    await page.getByText(/sign out/i).click()

    // Should redirect to the login page
    await page.waitForURL('**/auth/login', { timeout: 10000 })
    await expect(page).toHaveURL(/auth\/login/)
  })
})

/**
 * FR-22 slice 6 — anywhere in one move: „+ New" in every top bar (FR-22.49), ★ pinning a blank
 * form and showing it on the App Hub and the dashboard (FR-22.51), and the form keys (FR-22.52).
 */
test.describe('Quick create, favourites and form keys (FR-22.49–.52)', () => {
  const base = process.env.BASE_URL || 'http://localhost:4001'

  async function firstInvoiceId(): Promise<string> {
    const res = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orgSlug: 'acme-corp', username: 'admin', password: 'test123' }),
    })
    const { token, org } = await res.json()
    const list = await fetch(`${base}/api/org/${org.id}/invoices?direction=outgoing&type=invoice&size=1`, { headers: { Authorization: `Bearer ${token}` } })
    const data = await list.json()
    const inv = (data.invoices || [])[0]
    expect(inv, 'the seed has an outgoing invoice').toBeTruthy()
    return inv._id || inv.id
  }

  test('„New" lists the daily documents and opens a blank one', async ({ page }) => {
    await loginForApp(page)
    await page.goto('/invoicing/invoices', { waitUntil: 'networkidle' })

    await page.getByTestId('new-document-menu').click()
    const items = page.getByTestId('new-document-list').locator('.v-list-item')
    await expect(items).toHaveCount(9)

    // In the same app it is a router move: no page load.
    await page.evaluate(() => { (window as any).__samePage = true })
    await items.filter({ hasText: 'Proforma' }).click()
    await page.waitForURL(/\/invoicing\/proforma\/new$/)
    await expect(page.getByRole('heading', { name: /new proforma/i })).toBeVisible()
    expect(await page.evaluate(() => (window as any).__samePage)).toBe(true)
  })

  test('„New" from an open invoice gives a blank invoice, not the open one', async ({ page }) => {
    await loginForApp(page)
    await page.goto(`/invoicing/invoices/${await firstInvoiceId()}/edit`, { waitUntil: 'networkidle' })
    await expect(page.getByRole('heading', { name: 'Edit Invoice' })).toBeVisible()

    await page.getByTestId('new-document-menu').click()
    await page.getByTestId('new-document-list').locator('.v-list-item').filter({ hasText: 'Outgoing invoice' }).click()
    await page.waitForURL(/\/invoicing\/invoices\/new$/)
    await expect(page.getByRole('heading', { name: 'New Invoice' })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Edit Invoice' })).toHaveCount(0)
  })

  test('★ pins a blank form, and the App Hub and the dashboard show it as a tile', async ({ page }) => {
    await loginForApp(page)
    await page.goto('/invoicing/invoices/new?type=credit_note', { waitUntil: 'networkidle' })

    await page.getByTestId('favorites-menu').click()
    const pin = page.getByTestId('favorites-pin-current')
    await expect(pin).toContainText('New credit note')
    await pin.click()

    for (const path of ['/apps', '/dashboard']) {
      await page.goto(path, { waitUntil: 'networkidle' })
      await expect(page.getByTestId('favorite-tile').filter({ hasText: 'New credit note' })).toBeVisible()
    }
    await page.getByTestId('favorite-tile').filter({ hasText: 'New credit note' }).click()
    await page.waitForURL(/\/invoicing\/invoices\/new\?type=credit_note$/)
    await expect(page.getByRole('heading', { name: 'New Credit Note' })).toBeVisible()
  })

  test('a new form focuses its first field, and Ctrl+S saves it', async ({ page }) => {
    await loginForApp(page)
    await page.goto('/invoicing/contacts/new', { waitUntil: 'networkidle' })

    await expect(page.getByRole('textbox', { name: /company name/i })).toBeFocused()
    await page.keyboard.type(`Shortcut Co ${Date.now()}`)

    // The button names its key.
    await page.getByRole('button', { name: 'Save', exact: true }).hover()
    await expect(page.locator('.v-overlay--active').filter({ hasText: /^Ctrl\+S/ })).toBeVisible()

    await page.keyboard.press('Control+s')
    await page.waitForURL(/\/invoicing\/contacts$/)
  })

  test('a new invoice starts in its customer field, with the list closed until typing', async ({ page }) => {
    await loginForApp(page)
    await page.goto('/invoicing/invoices/new', { waitUntil: 'networkidle' })

    const customer = page.getByRole('combobox', { name: /client/i })
    await expect(customer).toBeFocused()
    // The customers arrived while the field had the focus; Vuetify would open the list over the
    // form for that alone, where the next click would pick a customer by accident.
    await expect(customer).toHaveAttribute('aria-expanded', 'false')

    await page.keyboard.type('Tech')
    await expect(page.locator('.v-overlay--active .v-list-item').filter({ hasText: 'TechVision' }).first()).toBeVisible()
  })

  test('Esc closes a dialog (Vuetify\'s own default, kept)', async ({ page }) => {
    await loginForApp(page)
    await page.goto('/invoicing/invoices/new', { waitUntil: 'networkidle' })

    await page.getByRole('button', { name: 'Columns' }).first().click()
    const dialog = page.getByText('Choose which columns to show on line items.')
    await expect(dialog).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(dialog).toBeHidden()
  })
})
