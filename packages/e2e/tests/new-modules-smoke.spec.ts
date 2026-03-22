import { test, expect } from '@playwright/test'

/**
 * Smoke tests for the 7 new module UIs: sales, purchase, project, helpdesk, documents, subscriptions, planning.
 * Runs against the live deployment at https://lgrai.app/
 */

const BASE_URL = process.env.BASE_URL || 'https://lgrai.app'

async function loginForApp(page: import('@playwright/test').Page) {
  const response = await fetch(`${BASE_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ orgSlug: 'acme-corp', username: 'admin', password: 'test123' }),
  })
  const data = await response.json()
  const token = data.token
  const orgData = data.org

  await page.addInitScript(({ token, org }) => {
    localStorage.setItem('lgr_token', token)
    if (org) localStorage.setItem('lgr_org', JSON.stringify(org))
  }, { token, org: orgData })
}

/** Wait for the Vue app to mount and render */
async function waitForApp(page: import('@playwright/test').Page) {
  // Wait for the Vuetify v-application div (the inner one, not #app)
  await expect(page.locator('.v-application')).toBeVisible({ timeout: 15000 })
}

// ─── Module definitions ──────────────────────────────────────────────────────
interface ModuleSpec {
  name: string
  basePath: string
  defaultRoute: string
  listHeading: RegExp
  createRoute?: string
  createHeading?: RegExp
}

const modules: ModuleSpec[] = [
  {
    name: 'Sales',
    basePath: '/sales/',
    defaultRoute: '/sales/orders',
    listHeading: /sales orders|orders/i,
    createRoute: '/sales/orders/new',
    createHeading: /new.*order|sales.*order/i,
  },
  {
    name: 'Purchase',
    basePath: '/purchase/',
    defaultRoute: '/purchase/orders',
    listHeading: /purchase orders|orders/i,
    createRoute: '/purchase/orders/new',
    createHeading: /new.*order|purchase.*order/i,
  },
  {
    name: 'Project',
    basePath: '/project/',
    defaultRoute: '/project/',
    listHeading: /projects/i,
    createRoute: '/project/projects/new',
    createHeading: /new.*project|project/i,
  },
  {
    name: 'Helpdesk',
    basePath: '/helpdesk/',
    defaultRoute: '/helpdesk/',
    listHeading: /tickets/i,
    createRoute: '/helpdesk/tickets/new',
    createHeading: /new.*ticket|ticket/i,
  },
  {
    name: 'Documents',
    basePath: '/documents/',
    defaultRoute: '/documents/workspaces',
    listHeading: /workspaces|documents/i,
  },
  {
    name: 'Subscriptions',
    basePath: '/subscriptions/',
    defaultRoute: '/subscriptions/subscriptions',
    listHeading: /subscriptions/i,
    createRoute: '/subscriptions/subscriptions/new',
    createHeading: /new.*subscription|subscription/i,
  },
  {
    name: 'Planning',
    basePath: '/planning/',
    defaultRoute: '/planning/shifts',
    listHeading: /shifts|planning/i,
  },
]

// ─── Tests ───────────────────────────────────────────────────────────────────

for (const mod of modules) {
  test.describe(`${mod.name} Module`, () => {
    test(`should load ${mod.name} default page`, async ({ page }) => {
      await loginForApp(page)
      await page.goto(mod.basePath, { waitUntil: 'domcontentloaded' })

      // Wait for Vue app to mount
      await waitForApp(page)

      // Should not be a plain-text error page
      await expect(page.locator('body')).not.toContainText('Cannot GET', { timeout: 2000 })
    })

    test(`should show sidebar navigation in ${mod.name}`, async ({ page }) => {
      await loginForApp(page)
      await page.goto(mod.defaultRoute, { waitUntil: 'domcontentloaded' })

      await waitForApp(page)

      // Sidebar (v-navigation-drawer) should be visible
      const sidebar = page.locator('.v-navigation-drawer')
      await expect(sidebar).toBeVisible({ timeout: 10000 })
    })

    test(`should render content area in ${mod.name}`, async ({ page }) => {
      await loginForApp(page)
      await page.goto(mod.defaultRoute, { waitUntil: 'domcontentloaded' })

      await waitForApp(page)

      // Either a data table, card grid, list, or alert/info banner should be present
      const dataTable = page.locator('.v-data-table, .v-data-table-server')
      const cardGrid = page.locator('.v-card')
      const listView = page.locator('.v-list')
      const alert = page.locator('.v-alert')

      const hasTable = await dataTable.first().isVisible({ timeout: 10000 }).catch(() => false)
      const hasCards = await cardGrid.first().isVisible({ timeout: 2000 }).catch(() => false)
      const hasList = await listView.first().isVisible({ timeout: 2000 }).catch(() => false)
      const hasAlert = await alert.first().isVisible({ timeout: 2000 }).catch(() => false)

      expect(hasTable || hasCards || hasList || hasAlert).toBeTruthy()
    })

    test(`should display heading in ${mod.name} list view`, async ({ page }) => {
      await loginForApp(page)
      await page.goto(mod.defaultRoute, { waitUntil: 'domcontentloaded' })

      await waitForApp(page)

      // Look for a heading matching the module's expected content
      const heading = page.locator('h1, h2, h3, .text-h4, .text-h5, .text-h6').filter({ hasText: mod.listHeading })
      const headingVisible = await heading.first().isVisible({ timeout: 10000 }).catch(() => false)

      // If no heading found, at least the page title or toolbar should show the module name
      if (!headingVisible) {
        const toolbar = page.locator('.v-toolbar, .v-app-bar')
        await expect(toolbar.first()).toBeVisible({ timeout: 5000 })
      }
    })

    if (mod.createRoute) {
      test(`should navigate to create form in ${mod.name}`, async ({ page }) => {
        await loginForApp(page)
        await page.goto(mod.createRoute!, { waitUntil: 'domcontentloaded' })

        await waitForApp(page)

        // Should show a form or input fields
        const form = page.locator('.v-form, form')
        const formVisible = await form.first().isVisible({ timeout: 10000 }).catch(() => false)

        const inputs = page.locator('input, .v-text-field, .v-select')
        const hasInputs = await inputs.first().isVisible({ timeout: 5000 }).catch(() => false)

        expect(formVisible || hasInputs).toBeTruthy()
      })
    }
  })
}

// ─── Additional sub-page smoke tests ─────────────────────────────────────────

const subPages = [
  { name: 'Purchase: agreements', path: '/purchase/agreements' },
  { name: 'Purchase: reorder rules', path: '/purchase/reorder-rules' },
  { name: 'Helpdesk: teams', path: '/helpdesk/teams' },
  { name: 'Helpdesk: SLA policies', path: '/helpdesk/sla-policies' },
  { name: 'Helpdesk: knowledge base', path: '/helpdesk/knowledge' },
  { name: 'Documents: signatures', path: '/documents/signatures' },
  { name: 'Subscriptions: dashboard', path: '/subscriptions/dashboard' },
  { name: 'Planning: templates', path: '/planning/templates' },
  { name: 'Planning: appointments', path: '/planning/appointments' },
  { name: 'Planning: appointment types', path: '/planning/appointment-types' },
  { name: 'Project: timesheets', path: '/project/timesheets' },
  { name: 'Project: field service', path: '/project/field-service' },
  { name: 'Sales: quotation templates', path: '/sales/templates' },
]

test.describe('Module sub-pages', () => {
  for (const sub of subPages) {
    test(`${sub.name} page loads`, async ({ page }) => {
      await loginForApp(page)
      await page.goto(sub.path, { waitUntil: 'domcontentloaded' })
      await waitForApp(page)
      await expect(page.locator('body')).not.toContainText('Cannot GET', { timeout: 2000 })
    })
  }
})
