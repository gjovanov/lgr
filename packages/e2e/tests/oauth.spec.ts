import { test, expect } from '@playwright/test'

// Override base URL for dev mode (Vite at 4000, not API at 4001)
test.use({ baseURL: 'http://localhost:4000' })

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

  test('clicking Google OAuth button redirects to Google', async ({ page }) => {
    await page.getByRole('textbox', { name: /organization/i }).fill('acme-corp')

    // Intercept the navigation to Google to prevent leaving the page
    await page.route('**/accounts.google.com/**', (route) => route.abort())

    const [request] = await Promise.all([
      page.waitForRequest(
        (req) => req.url().includes('accounts.google.com'),
        { timeout: 10000 },
      ),
      page.getByRole('button', { name: 'Google' }).click(),
    ])

    expect(request.url()).toContain('accounts.google.com')
    expect(request.url()).toContain('client_id=')
    expect(request.url()).toContain('redirect_uri=')
    expect(request.url()).toContain('state=')
  })

  test('clicking GitHub OAuth button redirects to GitHub', async ({ page }) => {
    await page.getByRole('textbox', { name: /organization/i }).fill('acme-corp')

    await page.route('**/github.com/**', (route) => route.abort())

    const [request] = await Promise.all([
      page.waitForRequest(
        (req) => req.url().includes('github.com/login/oauth'),
        { timeout: 10000 },
      ),
      page.getByRole('button', { name: 'GitHub' }).click(),
    ])

    expect(request.url()).toContain('github.com/login/oauth/authorize')
    expect(request.url()).toContain('client_id=')
    expect(request.url()).toContain('state=')
  })

  test('OAuth callback page without token shows error', async ({ page }) => {
    await page.goto('/auth/oauth-callback')
    await expect(page.getByText('No token received from OAuth provider')).toBeVisible({ timeout: 5000 })
    await expect(page.getByText('Back to login')).toBeVisible()
  })

  test('OAuth callback page with invalid token shows error', async ({ page }) => {
    await page.goto('/auth/oauth-callback?token=invalid-mock-token')
    // fetchMe will fail with invalid token — page should show error or redirect to login
    await expect(
      page.getByText('Failed to complete OAuth login').or(page.getByText('Sign In')),
    ).toBeVisible({ timeout: 10000 })
  })
})
