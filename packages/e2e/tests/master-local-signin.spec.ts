import { test, expect } from '@playwright/test'
import { lan, master, tunnel } from './helpers/master'

/**
 * FR-20.40 (plan step P1-5) — a till's PIN, on a master (`scripts/master-stack.ts`).
 *
 * The founder sets a PIN with their password; at the till the pad takes their operator code and
 * that PIN, and the session it gives reaches the till and nothing else (`pinScopeRefusal`). Wrong
 * PINs slow the next try (three free, then 1 s, doubling to 60 s) and never lock anyone out, which
 * is trap 32: a shop must not be locked out of its own till. And a PIN never signs in from the
 * internet: through the tunnel the pad is not offered and its route answers 404.
 */
test.skip(!master.url, 'no master to run against: run packages/e2e/scripts/master-stack.ts')
// ⚠ In order, in one worker (the project is not fully parallel): the wrong PINs below slow THIS
// till's next try too. Not `serial`, which would skip the rest after a first failure and hide them.

const PIN = '482613'
let operatorCode = ''

test.beforeAll(async () => {
  const signedIn = await lan('/api/auth/login', { body: { username: master.email, password: master.password } })
  expect(signedIn.status, JSON.stringify(signedIn.json)).toBe(200)
  operatorCode = String(signedIn.json?.user?.operatorCode || '')
  expect(operatorCode, 'the founder has an operator code').toMatch(/^\d{1,8}$/)
  const set = await lan('/api/auth/local/pin', { method: 'PUT', token: signedIn.json.token, body: { password: master.password, pin: PIN } })
  expect(set.status, JSON.stringify(set.json)).toBe(200)
})

test.describe('a till\'s PIN on a master', () => {
  test('the till offers the pad, and the operator signs in there into the till and nothing else', async ({ page }) => {
    const methods = await lan('/api/auth/local/methods')
    expect(methods.json).toMatchObject({ pin: true, pinLength: { min: 6, max: 12 } })

    await page.goto('/invoicing/pin', { waitUntil: 'domcontentloaded' })
    await page.getByTestId('pin-operator').locator('input').fill(operatorCode)
    await page.getByTestId('pin-pin').locator('input').fill(PIN)
    await page.getByTestId('pin-submit').click()
    await page.waitForURL(u => !u.pathname.endsWith('/pin'), { timeout: 30000 })

    const reach = await page.evaluate(async (orgId) => {
      const token = sessionStorage.getItem('lgr_token') || localStorage.getItem('lgr_token') || ''
      const get = async (path: string) => {
        const res = await fetch(path, { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' })
        return { status: res.status, body: await res.json().catch(() => null) }
      }
      return { me: await get('/api/auth/me'), desktops: await get(`/api/org/${orgId}/desktops`) }
    }, master.orgId)
    expect(reach.me.status).toBe(200)
    expect(reach.me.body?.user?.email).toBe(master.email)
    // The Desktops page is the admin's, not the till's: a PIN does not reach it.
    expect(reach.desktops.status).toBe(403)
    expect(reach.desktops.body?.code).toBe('pin_session_scope')
  })

  test('three wrong PINs are free, the fourth slows the next try, and nothing ever locks', async () => {
    const wrong = () => lan('/api/auth/local/pin', { body: { operatorCode, pin: '000000' } })
    for (let i = 1; i <= 3; i++) {
      const r = await wrong()
      expect(r.status, `wrong PIN ${i}`).toBe(401)
      expect(r.json).toMatchObject({ code: 'invalid_pin' })
      expect(r.json?.retryAfterSeconds, `wrong PIN ${i} is free`).toBeUndefined()
    }
    const fourth = await wrong()
    expect(fourth.status).toBe(401)
    expect(fourth.json).toMatchObject({ code: 'invalid_pin', retryAfterSeconds: 1 })
    // Inside the wait even the right PIN is asked to wait: the delay is the operator's, whatever they type.
    const early = await lan('/api/auth/local/pin', { body: { operatorCode, pin: PIN } })
    expect(early.status).toBe(429)
    expect(early.json?.code).toBe('pin_backoff')
    await new Promise(r => setTimeout(r, (Number(early.json?.retryAfterSeconds) || 1) * 1000 + 300))
    const right = await lan('/api/auth/local/pin', { body: { operatorCode, pin: PIN } })
    expect(right.status, JSON.stringify(right.json)).toBe(200)
    const claims = JSON.parse(Buffer.from(String(right.json?.token).split('.')[1], 'base64url').toString('utf8'))
    expect(claims.amr).toEqual(['pin'])
  })

  test('through the tunnel the pad is not offered and a PIN never signs in', async () => {
    const methods = await tunnel('/api/auth/local/methods')
    expect(methods.status).toBe(200)
    expect(methods.json).toMatchObject({ pin: false })
    const r = await tunnel('/api/auth/local/pin', { body: { operatorCode, pin: PIN } })
    expect(r.status).toBe(404)
    expect(r.json?.token).toBeFalsy()
  })
})
