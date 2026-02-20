import { test, expect } from '@playwright/test'

test.describe('App Hub', () => {
  // Helper to login as admin
  async function loginAsAdmin(page: any) {
    await page.goto('/auth/login', { waitUntil: 'networkidle' })
    await page.getByRole('textbox', { name: /organization/i }).fill('acme-corp')
    await page.getByRole('textbox', { name: /username/i }).fill('admin')
    await page.getByRole('textbox', { name: /password/i }).fill('test123')
    await page.getByRole('button', { name: /sign in/i }).click()
    await page.waitForURL('**/dashboard', { timeout: 15000 })
  }

  test('should list available apps via API', async ({ request }) => {
    // First login to get a token
    const loginRes = await request.post('/api/auth/login', {
      data: {
        orgSlug: 'acme-corp',
        username: 'admin',
        password: 'test123',
      },
    })
    expect(loginRes.ok()).toBeTruthy()
    const loginData = await loginRes.json()
    const token = loginData.token
    const orgId = loginData.org.id

    // Fetch apps
    const appsRes = await request.get(`/api/org/${orgId}/apps`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    expect(appsRes.ok()).toBeTruthy()
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

  test('should activate and deactivate apps via API', async ({ request }) => {
    // Login as beta-inc admin (starter plan, 3 apps seeded)
    const loginRes = await request.post('/api/auth/login', {
      data: {
        orgSlug: 'beta-inc',
        username: 'admin',
        password: 'test123',
      },
    })
    const loginData = await loginRes.json()
    const token = loginData.token
    const orgId = loginData.org.id

    // Fetch current apps
    const appsRes = await request.get(`/api/org/${orgId}/apps`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    const appsData = await appsRes.json()

    // Beta has 3 enabled (accounting, invoicing, warehouse) out of visible apps
    const enabledBefore = appsData.apps.filter((a: any) => a.enabled).length
    expect(enabledBefore).toBe(3)

    // Activate a 4th app (payroll) - should work on starter plan (limit: 4)
    const activateRes = await request.post(`/api/org/${orgId}/apps/payroll/activate`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    expect(activateRes.ok()).toBeTruthy()
    const activateData = await activateRes.json()
    expect(activateData.app.id).toBe('payroll')
    expect(activateData.app.enabled).toBe(true)

    // Try to activate a 5th app (hr) - should fail on starter plan (limit: 4)
    const failRes = await request.post(`/api/org/${orgId}/apps/hr/activate`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    expect(failRes.status()).toBe(400)
    const failData = await failRes.json()
    expect(failData.message).toContain('maximum of 4')

    // Deactivate payroll to clean up
    const deactivateRes = await request.post(`/api/org/${orgId}/apps/payroll/deactivate`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    expect(deactivateRes.ok()).toBeTruthy()
    const deactivateData = await deactivateRes.json()
    expect(deactivateData.app.enabled).toBe(false)
  })

  test('should require admin role for activation', async ({ request }) => {
    // Login as non-admin user
    const loginRes = await request.post('/api/auth/login', {
      data: {
        orgSlug: 'acme-corp',
        username: 'accountant',
        password: 'test123',
      },
    })
    const loginData = await loginRes.json()
    const token = loginData.token
    const orgId = loginData.org.id

    // Non-admin can list apps
    const appsRes = await request.get(`/api/org/${orgId}/apps`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    expect(appsRes.ok()).toBeTruthy()

    // Non-admin cannot activate
    const activateRes = await request.post(`/api/org/${orgId}/apps/crm/activate`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    expect(activateRes.status()).toBe(403)
  })

  test('should filter apps by user permissions', async ({ request }) => {
    // Login as accountant (only has accounting + invoicing permissions)
    const loginRes = await request.post('/api/auth/login', {
      data: {
        orgSlug: 'acme-corp',
        username: 'accountant',
        password: 'test123',
      },
    })
    const loginData = await loginRes.json()
    const token = loginData.token
    const orgId = loginData.org.id

    const appsRes = await request.get(`/api/org/${orgId}/apps`, {
      headers: { Authorization: `Bearer ${token}` },
    })
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
