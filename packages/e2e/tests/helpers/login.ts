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
