import type { Page } from '@playwright/test'

export async function loginAsAdmin(page: Page) {
  await page.goto('/auth/login', { waitUntil: 'networkidle' })
  await page.getByRole('textbox', { name: /organization/i }).fill('acme-corp')
  await page.getByRole('textbox', { name: /username/i }).fill('admin')
  await page.getByRole('textbox', { name: /password/i }).fill('test123')
  await page.getByRole('button', { name: /sign in/i }).click()
  await page.waitForURL('**/dashboard', { timeout: 15000 })
}

export async function loginAs(page: Page, org: string, username: string, password: string) {
  await page.goto('/auth/login', { waitUntil: 'networkidle' })
  await page.getByRole('textbox', { name: /organization/i }).fill(org)
  await page.getByRole('textbox', { name: /username/i }).fill(username)
  await page.getByRole('textbox', { name: /password/i }).fill(password)
  await page.getByRole('button', { name: /sign in/i }).click()
  await page.waitForURL('**/dashboard', { timeout: 15000 })
}

export async function loginForApp(page: Page, org = 'acme-corp', username = 'admin', password = 'test123') {
  // Get token from portal API using native fetch (Playwright's APIRequestContext
  // has a bug in v1.58 where Set-Cookie response headers cause URL parsing errors)
  const apiBase = process.env.BASE_URL || 'http://localhost:4001'
  const response = await fetch(`${apiBase}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ orgSlug: org, username, password }),
  })
  const data = await response.json()
  const token = data.token
  const orgData = data.org

  // Register init script to set token AND org BEFORE the app loads — this prevents
  // the domain app's router guard from redirecting to portal login and ensures
  // the app store has org context for API calls
  await page.addInitScript(({ token, org }) => {
    localStorage.setItem('lgr_token', token)
    if (org) localStorage.setItem('lgr_org', JSON.stringify(org))
  }, { token, org: orgData })

  // Navigate to app's base URL — init script runs before app scripts
  await page.goto('/', { waitUntil: 'networkidle' })
}
