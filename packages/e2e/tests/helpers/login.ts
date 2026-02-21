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
  const response = await fetch('http://localhost:4001/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ orgSlug: org, username, password }),
  })
  const data = await response.json()
  const token = data.token

  // Register init script to set token BEFORE the app loads — this prevents
  // the domain app's router guard from redirecting to portal login
  await page.addInitScript((t) => {
    localStorage.setItem('lgr_token', t)
  }, token)

  // Navigate to app's base URL — init script runs before app scripts
  await page.goto('/', { waitUntil: 'networkidle' })
}
