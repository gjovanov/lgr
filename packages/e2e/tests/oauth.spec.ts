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

  test('register page with oauth_token pre-fills email and hides password', async ({ page }) => {
    // Create a fake JWT-like token with base64url payload
    const payload = { type: 'oauth_pending', email: 'test@example.com', name: 'Test User', provider: 'google', providerId: 'g-123' }
    const fakeToken = `header.${btoa(JSON.stringify(payload)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')}.signature`

    await page.goto(`/auth/register?oauth_token=${encodeURIComponent(fakeToken)}`)
    await page.waitForLoadState('networkidle')

    // Email should be pre-filled
    const emailInput = page.locator('input[type="email"]')
    await expect(emailInput).toHaveValue('test@example.com')

    // Password field should not be visible
    await expect(page.locator('input[type="password"]')).toHaveCount(0)

    // OAuth buttons should be hidden (already in OAuth flow)
    await expect(page.getByRole('button', { name: 'Google' })).toHaveCount(0)
  })
})
