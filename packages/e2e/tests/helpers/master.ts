import type { Page } from '@playwright/test'

/**
 * The master the `master` project runs against, as `scripts/master-stack.ts` started it: every URL
 * is its stand-in LAN front, which stamps a request `lan` with a paired desktop's token, as the
 * supervisor's ingress passes a till's (FR-20.32). Empty outside that script, and the specs skip.
 */
export const master = {
  url: process.env.E2E_MASTER_URL || '',
  orgId: process.env.E2E_MASTER_ORG || '',
  slug: process.env.E2E_MASTER_SLUG || '',
  email: process.env.E2E_MASTER_EMAIL || '',
  password: process.env.E2E_MASTER_PASSWORD || '',
  desktopId: process.env.E2E_MASTER_DESKTOP || '',
  lanUrl: process.env.E2E_MASTER_LAN_URL || '',
  fingerprint: process.env.E2E_MASTER_FINGERPRINT || '',
  words: process.env.E2E_MASTER_WORDS || '',
}

/** A request through the front. Native fetch: Playwright's APIRequestContext mis-parses Set-Cookie (`login.ts`). */
export async function lan(path: string, init: { method?: string; body?: unknown; token?: string } = {}) {
  const res = await fetch(`${master.url}${path}`, {
    method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
    headers: {
      ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(init.token ? { Authorization: `Bearer ${init.token}` } : {}),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  })
  let json: any = null
  try { json = await res.json() } catch { /* not JSON */ }
  return { status: res.status, json }
}

/** The founder, through the sign-in page, as a person at the till does it. */
export async function masterSignIn(page: Page) {
  await page.goto('/auth/login', { waitUntil: 'domcontentloaded' })
  await page.getByRole('textbox', { name: /username/i }).fill(master.email)
  await page.getByRole('textbox', { name: /password/i }).fill(master.password)
  await page.getByRole('button', { name: /sign in/i }).click()
  await page.waitForURL(u => !u.pathname.startsWith('/auth/'), { timeout: 30000 })
}
