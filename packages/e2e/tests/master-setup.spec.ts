import { test, expect } from '@playwright/test'
import { lan, master, masterSignIn } from './helpers/master'

/**
 * FR-20.16–20.18, AC 47 — a master, from its LAN, as a till sees it (`scripts/master-stack.ts`).
 *
 * What the shop's network may NOT do on its server: found an org (that is setup's, on the console),
 * reach the setup API or the internal routes over HTTP (they are the control socket's), or sign in
 * with a credential nobody chose. And what it must: show a signed-out person the master's own
 * sign-in page, never lgrai.app's marketing page (lgr#384, which only a till's window on a released
 * server found), and let the founder sign in with the password they set in setup.
 */
test.skip(!master.url, 'no master to run against: run packages/e2e/scripts/master-stack.ts')

test.describe('a master, from its LAN', () => {
  test('nothing founds an org there outside setup (FR-20.18)', async () => {
    for (const path of ['/api/auth/register', '/api/auth/orgs', '/api/oauth/pending/register']) {
      const r = await lan(path, { body: {} })
      expect(r.status, `POST ${path}: ${JSON.stringify(r.json)}`).toBe(404)
    }
  })

  test('the setup API and the internal routes are never served over HTTP (AC 47)', async () => {
    for (const path of ['/api/setup', '/api/setup/state', '/internal', '/internal/status', '/internal/replication']) {
      const r = await lan(path)
      expect(r.status, `GET ${path}`).toBe(404)
    }
  })

  test('there is no default credential to sign in with (FR-20.17)', async () => {
    const tried = [['admin', 'admin'], ['admin', 'admin123'], ['admin', 'test123'], ['owner', 'owner'], ['root', 'root']]
    for (const [username, password] of tried) {
      const r = await lan('/api/auth/login', { body: { username, password } })
      expect(r.status, `${username} / ${password}: ${JSON.stringify(r.json)}`).not.toBe(200)
      expect(r.json?.token, `${username} / ${password} was given a session`).toBeFalsy()
    }
  })

  test('a signed-out visitor is asked to sign in, never shown the landing page (lgr#384)', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' })
    await page.waitForURL(u => u.pathname.startsWith('/auth/login'), { timeout: 30000 })
    await expect(page.getByRole('textbox', { name: /username/i })).toBeVisible()
    // lgrai.app's marketing page, typed in by hand, sends a master's visitor to the same place.
    await page.goto('/landing', { waitUntil: 'domcontentloaded' })
    await page.waitForURL(u => u.pathname.startsWith('/auth/login'), { timeout: 30000 })
  })

  test('the founder signs in with the password set in setup, into the org setup founded', async ({ page }) => {
    await masterSignIn(page)
    const me = await page.evaluate(async () => {
      const token = sessionStorage.getItem('lgr_token') || localStorage.getItem('lgr_token') || ''
      const res = await fetch('/api/auth/me', { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' })
      return { status: res.status, body: await res.json().catch(() => null) }
    })
    expect(me.status).toBe(200)
    expect(me.body?.user?.email).toBe(master.email)
    expect(me.body?.org?.slug).toBe(master.slug)
  })
})
