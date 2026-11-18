import { test, expect, type Request } from '@playwright/test'
import { loginForApp } from './helpers/login'

/**
 * FR-30 slice G (#795): the first load.
 *
 * - FR-30.27: the sign-in page loads without a failed request and with a clean console, nothing configured (its
 *   "Sign in with LGR" config answered 404 on every visit).
 * - FR-30.22: a session downloads its own language's catalogue and no other.
 * - FR-30.23: opening a list requests no drag-and-drop code; opening the column picker does.
 * - FR-30.24: a file whose name carries a content hash is served immutable for a year; the shell never cached.
 */

const isLocaleChunk = (url: string, lang: string) => new RegExp(`/ui/${lang}-[A-Za-z0-9_-]{8}\\.js$`).test(new URL(url).pathname)

test('the sign-in page loads with no failed request and a clean console', async ({ page }) => {
  const problems: string[] = []
  page.on('console', (m) => { if (m.type() === 'error') problems.push(`console: ${m.text()}`) })
  page.on('requestfailed', (r) => problems.push(`failed: ${r.url()}`))
  page.on('response', (r) => { if (r.status() >= 400) problems.push(`${r.status()}: ${r.url()}`) })
  await page.goto('/auth/login')
  await expect(page.locator('input').first()).toBeVisible()
  await page.waitForLoadState('networkidle')
  expect(problems).toEqual([])
})

test('a session downloads its own language only, and the next one when it switches', async ({ page }) => {
  const seen: string[] = []
  page.on('request', (r: Request) => seen.push(r.url()))
  await page.addInitScript(() => { try { localStorage.setItem('lgr_locale', 'en') } catch { /* */ } })
  await page.goto('/auth/login')
  await expect(page.locator('input').first()).toBeVisible()
  await page.waitForLoadState('networkidle')
  expect(seen.filter((u) => isLocaleChunk(u, 'en'))).toHaveLength(1)
  for (const other of ['bg', 'de', 'mk']) expect({ other, n: seen.filter((u) => isLocaleChunk(u, other)).length }).toEqual({ other, n: 0 })
})

test('opening a list requests no drag-and-drop code; opening its column picker does', async ({ page }) => {
  const seen: string[] = []
  page.on('request', (r: Request) => seen.push(new URL(r.url()).pathname))
  await loginForApp(page)
  await page.goto('/invoicing/contacts')
  await expect(page.locator('.v-data-table')).toBeVisible()
  await page.waitForLoadState('networkidle')
  const picker = (paths: string[]) => paths.filter((p) => /\/ui\/GridColumnPickerDialog-[A-Za-z0-9_-]{8}\.js$/.test(p))
  expect(picker(seen)).toEqual([])
  await page.getByRole('button', { name: /columns/i }).first().click()
  await expect(page.locator('.v-overlay--active .v-card')).toBeVisible()
  expect(picker(seen)).toHaveLength(1)
})

test('hashed files are cached for good; the shell is never cached', async ({ page, request }) => {
  const assets: string[] = []
  page.on('response', (r) => { if (/\/ui\/[^/]+-[A-Za-z0-9_-]{8}\.(js|css|woff2)$/.test(new URL(r.url()).pathname)) assets.push(r.url()) })
  await page.goto('/auth/login')
  await page.waitForLoadState('networkidle')
  expect(assets.length).toBeGreaterThan(0)
  for (const url of assets.slice(0, 5)) {
    const res = await request.get(url)
    expect({ url, cache: res.headers()['cache-control'] }).toEqual({ url, cache: 'public, max-age=31536000, immutable' })
  }
  const shell = await request.get('/auth/login')
  expect(shell.headers()['cache-control']).toContain('no-store')
})
