import { test, expect } from '@playwright/test'

test.describe('OAuth Login', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/auth/login')
    await page.waitForLoadState('networkidle')
  })

  test('shows all OAuth provider buttons on login page', async ({ page }) => {
    for (const provider of ['Google', 'Facebook', 'GitHub', 'LinkedIn', 'Microsoft']) {
      await expect(page.getByRole('button', { name: provider })).toBeVisible()
    }
  })

  test('OAuth buttons are disabled when org slug is empty', async ({ page }) => {
    for (const provider of ['Google', 'Facebook', 'GitHub', 'LinkedIn', 'Microsoft']) {
      await expect(page.getByRole('button', { name: provider })).toBeDisabled()
    }
  })

  test('OAuth buttons become enabled after entering org slug', async ({ page }) => {
    await page.getByRole('textbox', { name: /organization/i }).fill('acme-corp')

    for (const provider of ['Google', 'Facebook', 'GitHub', 'LinkedIn', 'Microsoft']) {
      await expect(page.getByRole('button', { name: provider })).toBeEnabled()
    }
  })

  test('clicking Google OAuth button navigates to OAuth API', async ({ page }) => {
    await page.getByRole('textbox', { name: /organization/i }).fill('acme-corp')

    // Intercept at the API level to prevent actual OAuth redirect
    await page.route('**/api/oauth/google**', (route) =>
      route.fulfill({ status: 200, contentType: 'text/html', body: 'intercepted' }),
    )

    await page.getByRole('button', { name: 'Google' }).click()
    await page.waitForURL('**/api/oauth/google**', { timeout: 10000 })

    expect(page.url()).toContain('/api/oauth/google')
    expect(page.url()).toContain('org_slug=acme-corp')
  })

  test('clicking GitHub OAuth button navigates to OAuth API', async ({ page }) => {
    await page.getByRole('textbox', { name: /organization/i }).fill('acme-corp')

    await page.route('**/api/oauth/github**', (route) =>
      route.fulfill({ status: 200, contentType: 'text/html', body: 'intercepted' }),
    )

    await page.getByRole('button', { name: 'GitHub' }).click()
    await page.waitForURL('**/api/oauth/github**', { timeout: 10000 })

    expect(page.url()).toContain('/api/oauth/github')
    expect(page.url()).toContain('org_slug=acme-corp')
  })

  test('OAuth callback page with no handoff in progress shows error', async ({ page }) => {
    // The credential is the single-use httpOnly `oauth_handoff` cookie the callback sets, so a
    // cold visit has nothing to redeem and the server answers with one flat refusal.
    await page.goto('/auth/oauth-callback')
    await expect(page.getByText(/No sign-in is in progress/i)).toBeVisible({ timeout: 10000 })
    await expect(page.getByText('Back to login')).toBeVisible()
  })

  /**
   * The regression this replaced: the callback used to receive the session JWT as `?token=` and
   * the view stored whatever it was handed, so anyone could sign a visitor into their own account
   * with a link. The callback now reads nothing from the URL at all.
   */
  test('a token planted in the callback URL does not sign anyone in', async ({ page }) => {
    await page.goto('/auth/oauth-callback?token=planted-token-value')

    // It is refused like any other unauthenticated visit…
    await expect(page.getByText(/No sign-in is in progress/i)).toBeVisible({ timeout: 10000 })
    // …the parameter is gone from the address bar, so it cannot be re-shared or bookmarked…
    expect(page.url()).not.toContain('planted-token-value')
    // …and nothing was stored.
    expect(await page.evaluate(() => localStorage.getItem('lgr_token'))).toBeNull()
  })
})

test.describe('OAuth Registration', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/auth/register')
    await page.waitForLoadState('networkidle')
  })

  test('shows all OAuth provider buttons on register page', async ({ page }) => {
    for (const provider of ['Google', 'Facebook', 'GitHub', 'LinkedIn', 'Microsoft']) {
      await expect(page.getByRole('button', { name: provider })).toBeVisible()
    }
  })

  test('OAuth register buttons are always enabled (no org slug required)', async ({ page }) => {
    for (const provider of ['Google', 'Facebook', 'GitHub', 'LinkedIn', 'Microsoft']) {
      await expect(page.getByRole('button', { name: provider })).toBeEnabled()
    }
  })

  test('clicking Google OAuth register button navigates with mode=register', async ({ page }) => {
    await page.route('**/api/oauth/google**', (route) =>
      route.fulfill({ status: 200, contentType: 'text/html', body: 'intercepted' }),
    )

    await page.getByRole('button', { name: 'Google' }).click()
    await page.waitForURL('**/api/oauth/google**', { timeout: 10000 })

    expect(page.url()).toContain('/api/oauth/google')
    expect(page.url()).toContain('mode=register')
  })

  /**
   * The prefill comes from the server, through the httpOnly `oauth_pending` cookie the callback
   * set. The cookie cannot be minted here without a real provider, so the endpoint's answer is
   * stubbed: what is under test is that the view asks the SERVER, not its own URL.
   */
  test('register page with ?oauth=1 pre-fills from the server and hides password', async ({ page }) => {
    await page.route('**/api/oauth/pending', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ provider: 'google', email: 'test@example.com', name: 'Test User' }),
      }),
    )

    await page.goto('/auth/register?oauth=1')
    await page.waitForLoadState('networkidle')

    // Email should be pre-filled
    const emailInput = page.locator('input[type="email"]')
    await expect(emailInput).toHaveValue('test@example.com')

    // Password field should not be visible
    await expect(page.locator('input[type="password"]')).toHaveCount(0)

    // OAuth buttons should be hidden (already in OAuth flow)
    await expect(page.getByRole('button', { name: 'Google' })).toHaveCount(0)
  })

  /**
   * The regression this replaced (security review S-19): the callback used to send
   * `?oauth_token=<JWT>` and the view posted back whatever token the URL held, so a planted link
   * chose whose identity the new account carried. The token is now removed from the address bar
   * and never used.
   */
  test('a sign-up token planted in the register URL is removed and not used', async ({ page }) => {
    const payload = { type: 'oauth_pending', email: 'planted@example.com', name: 'Planted User', provider: 'google', providerId: 'g-123' }
    const planted = `header.${btoa(JSON.stringify(payload)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')}.signature`

    await page.goto(`/auth/register?oauth_token=${encodeURIComponent(planted)}`)
    await page.waitForLoadState('networkidle')

    // The parameter is gone from the address bar…
    await expect.poll(() => page.url()).not.toContain('oauth_token')
    // …nothing from it reached the form…
    await expect(page.locator('input[type="email"]')).toHaveValue('')
    // …and this is the ordinary register form, password and provider buttons included.
    await expect(page.locator('input[type="password"]')).toHaveCount(1)
    await expect(page.getByRole('button', { name: 'Google' })).toBeVisible()
  })

  test('?oauth=1 without a sign-up in progress shows the refusal and the ordinary form', async ({ page }) => {
    await page.goto('/auth/register?oauth=1')

    await expect(page.getByText(/No sign-up is in progress/i)).toBeVisible({ timeout: 10000 })
    await expect(page.locator('input[type="password"]')).toHaveCount(1)
  })
})
