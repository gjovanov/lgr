import { test, expect } from '@playwright/test'

const PORTAL_API = process.env.BASE_URL || 'http://localhost:4001'

// Use native fetch for API-only tests (Playwright's APIRequestContext has a
// Set-Cookie URL parsing bug in v1.58)
async function apiPost(path: string, body?: unknown, token?: string) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (token) headers['Authorization'] = `Bearer ${token}`
  const res = await fetch(`${PORTAL_API}${path}`, {
    method: 'POST',
    headers,
    body: body ? JSON.stringify(body) : undefined,
  })
  return { status: res.status, ok: res.ok, json: () => res.json() }
}

async function apiGet(path: string, token: string) {
  const res = await fetch(`${PORTAL_API}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  return { status: res.status, ok: res.ok, json: () => res.json() }
}

test.describe('App Hub', () => {
  test('should list available apps via API', async () => {
    // First login to get a token
    const loginRes = await apiPost('/api/auth/login', {
      orgSlug: 'acme-corp',
      username: 'admin',
      password: 'test123',
    })
    expect(loginRes.ok).toBeTruthy()
    const loginData = await loginRes.json()
    const token = loginData.token
    const orgId = loginData.org.id

    // Fetch apps
    const appsRes = await apiGet(`/api/org/${orgId}/apps`, token)
    expect(appsRes.ok).toBeTruthy()
    const appsData = await appsRes.json()

    expect(appsData.apps).toBeDefined()
    expect(appsData.apps.length).toBe(7)

    // All apps should be enabled for acme-corp (professional plan, all seeded)
    const enabledApps = appsData.apps.filter((a: any) => a.enabled)
    expect(enabledApps.length).toBe(7)

    // Check accounting app structure
    const accounting = appsData.apps.find((a: any) => a.id === 'accounting')
    expect(accounting).toBeDefined()
    expect(accounting.name).toBe('Accounting')
    expect(accounting.icon).toBe('mdi-chart-bar')
    expect(accounting.color).toBe('#4caf50')
    expect(accounting.port).toBe(4010)
    expect(accounting.enabled).toBe(true)
  })

  test('should have all 7 apps enabled for beta-inc (freemium model)', async () => {
    // Login as beta-inc admin
    const loginRes = await apiPost('/api/auth/login', {
      orgSlug: 'beta-inc',
      username: 'admin',
      password: 'test123',
    })
    const loginData = await loginRes.json()
    const token = loginData.token
    const orgId = loginData.org.id

    // Fetch apps
    const appsRes = await apiGet(`/api/org/${orgId}/apps`, token)
    const appsData = await appsRes.json()

    // Beta has all 7 apps enabled (freemium model)
    const enabledApps = appsData.apps.filter((a: any) => a.enabled)
    expect(enabledApps.length).toBe(7)
  })

  test('should allow deactivation and re-activation', async () => {
    // Login as beta-inc admin
    const loginRes = await apiPost('/api/auth/login', {
      orgSlug: 'beta-inc',
      username: 'admin',
      password: 'test123',
    })
    const loginData = await loginRes.json()
    const token = loginData.token
    const orgId = loginData.org.id

    // Deactivate payroll
    const deactivateRes = await apiPost(`/api/org/${orgId}/apps/payroll/deactivate`, undefined, token)
    expect(deactivateRes.ok).toBeTruthy()
    const deactivateData = await deactivateRes.json()
    expect(deactivateData.app.enabled).toBe(false)

    // Re-activate payroll
    const activateRes = await apiPost(`/api/org/${orgId}/apps/payroll/activate`, undefined, token)
    expect(activateRes.ok).toBeTruthy()
    const activateData = await activateRes.json()
    expect(activateData.app.id).toBe('payroll')
    expect(activateData.app.enabled).toBe(true)
  })

  test('should require admin role for activation', async () => {
    // Login as non-admin user
    const loginRes = await apiPost('/api/auth/login', {
      orgSlug: 'acme-corp',
      username: 'accountant',
      password: 'test123',
    })
    const loginData = await loginRes.json()
    const token = loginData.token
    const orgId = loginData.org.id

    // Non-admin can list apps
    const appsRes = await apiGet(`/api/org/${orgId}/apps`, token)
    expect(appsRes.ok).toBeTruthy()

    // Non-admin cannot activate
    const activateRes = await apiPost(`/api/org/${orgId}/apps/crm/activate`, undefined, token)
    expect(activateRes.status).toBe(403)
  })

  test('should navigate from App Hub to domain app without bouncing back', async ({ page }) => {
    test.setTimeout(60000)
    const base = process.env.BASE_URL || 'http://localhost:4001'
    const isRemote = !base.includes('localhost')

    // Block analytics script that can prevent load from completing
    await page.route('**/purestat.js', route => route.abort())

    // Login via Portal UI
    await page.goto(`${base}/auth/login`)
    await expect(page.getByRole('textbox', { name: /organization/i })).toBeVisible({ timeout: 15000 })
    await page.getByRole('textbox', { name: /organization/i }).fill('acme-corp')
    await page.getByRole('textbox', { name: /username/i }).fill('admin')
    await page.getByRole('textbox', { name: /password/i }).fill('test123')
    await page.getByRole('button', { name: /sign in/i }).click()
    await page.waitForURL('**/dashboard', { timeout: 15000 })

    // Navigate to App Hub
    await page.goto(`${base}/apps`)

    // Wait for the Accounting card to appear
    const accountingCard = page.getByText('Accounting')
    await expect(accountingCard).toBeVisible({ timeout: 10000 })

    // Click the card — use noWaitAfter since it triggers cross-origin navigation
    await accountingCard.click({ noWaitAfter: true })

    // Wait for the page to navigate to the accounting app
    const accountingPattern = isRemote ? /\/accounting\// : /localhost:4010\/accounting/
    await page.waitForURL(accountingPattern, { timeout: 30000 })

    // Confirm we landed on the accounting app (not bounced back to portal)
    expect(page.url()).toMatch(accountingPattern)

    // The router guard will strip the token param via window.location.replace
    // and the app will reload. Wait for that to complete.
    await expect(async () => {
      expect(page.url()).not.toContain('token=')
    }).toPass({ timeout: 15000 })
  })

  test('should filter apps by user permissions', async () => {
    // Login as accountant (only has accounting + invoicing permissions)
    const loginRes = await apiPost('/api/auth/login', {
      orgSlug: 'acme-corp',
      username: 'accountant',
      password: 'test123',
    })
    const loginData = await loginRes.json()
    const token = loginData.token
    const orgId = loginData.org.id

    const appsRes = await apiGet(`/api/org/${orgId}/apps`, token)
    const appsData = await appsRes.json()

    // Accountant has accounting.read and invoicing.read permissions
    const appIds = appsData.apps.map((a: any) => a.id)
    expect(appIds).toContain('accounting')
    expect(appIds).toContain('invoicing')

    // Should NOT see warehouse, payroll, hr, crm, erp
    expect(appIds).not.toContain('warehouse')
    expect(appIds).not.toContain('payroll')
    expect(appIds).not.toContain('hr')
    expect(appIds).not.toContain('crm')
    expect(appIds).not.toContain('erp')
  })
})
