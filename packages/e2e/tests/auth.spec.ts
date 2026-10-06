import { test, expect } from '@playwright/test'

test.describe('Authentication', () => {
  test('should show login page', async ({ page }) => {
    await page.goto('/auth/login')
    // v-card-title renders as a div, not a heading element
    await expect(page.locator('.v-card-title', { hasText: /sign in/i })).toBeVisible()
  })

  test('has no organization field until asked for', async ({ page }) => {
    await page.goto('/auth/login', { waitUntil: 'networkidle' })
    await expect(page.getByRole('textbox', { name: /username or email/i })).toBeVisible()
    await expect(page.getByRole('textbox', { name: /organization/i })).toHaveCount(0)

    await page.getByRole('link', { name: /specific organization/i }).click()
    await expect(page.getByRole('textbox', { name: /organization/i })).toBeVisible()
  })

  test('should login by email and land in the only org', async ({ page }) => {
    await page.goto('/auth/login', { waitUntil: 'networkidle' })

    // Seeded credentials: admin@acme.com / test123, a member of acme-corp only
    await page.getByRole('textbox', { name: /username/i }).fill('admin@acme.com')
    await page.getByRole('textbox', { name: /password/i }).fill('test123')
    await page.getByRole('button', { name: /sign in/i }).click()

    await page.waitForURL('**/dashboard', { timeout: 15000 })
    await expect(page).toHaveURL(/dashboard/)
    await expect(page.getByTestId('org-switcher')).toContainText('Acme')
  })

  test('should login to a named org with the legacy username path', async ({ page }) => {
    await page.goto('/auth/login', { waitUntil: 'networkidle' })

    await page.getByRole('link', { name: /specific organization/i }).click()
    await page.getByRole('textbox', { name: /organization/i }).fill('acme-corp')
    await page.getByRole('textbox', { name: /username/i }).fill('admin')
    await page.getByRole('textbox', { name: /password/i }).fill('test123')
    await page.getByRole('button', { name: /sign in/i }).click()

    await page.waitForURL('**/dashboard', { timeout: 15000 })
  })

  test('a username two people share asks for the email or the org', async ({ page }) => {
    await page.goto('/auth/login', { waitUntil: 'networkidle' })

    // "admin" is a username in acme-corp AND in beta-inc: two different people.
    await page.getByRole('textbox', { name: /username/i }).fill('admin')
    await page.getByRole('textbox', { name: /password/i }).fill('test123')
    await page.getByRole('button', { name: /sign in/i }).click()

    await expect(page.locator('.v-alert')).toContainText(/several people use this username/i, { timeout: 10000 })
    await expect(page.getByRole('textbox', { name: /organization/i })).toBeVisible()
    await expect(page).toHaveURL(/auth\/login/)
  })

  test('should reject invalid credentials', async ({ page }) => {
    await page.goto('/auth/login', { waitUntil: 'networkidle' })

    await page.getByRole('textbox', { name: /username/i }).fill('admin@acme.com')
    await page.getByRole('textbox', { name: /password/i }).fill('wrong-password')
    await page.getByRole('button', { name: /sign in/i }).click()

    await expect(page.locator('.v-alert')).toContainText(/not right/i, { timeout: 10000 })
    await expect(page).toHaveURL(/auth\/login/)
  })

  test('should show error for non-existent organization', async ({ page }) => {
    await page.goto('/auth/login', { waitUntil: 'networkidle' })

    await page.getByRole('link', { name: /specific organization/i }).click()
    await page.getByRole('textbox', { name: /organization/i }).fill('non-existent-org')
    await page.getByRole('textbox', { name: /username/i }).fill('admin')
    await page.getByRole('textbox', { name: /password/i }).fill('test123')
    await page.getByRole('button', { name: /sign in/i }).click()

    // Error appears in a v-alert
    await expect(page.locator('.v-alert')).toBeVisible({ timeout: 10000 })
  })

  test('an OAuth refusal shows a translated message for its code, never text from the URL', async ({ page }) => {
    await page.goto('/auth/login?error=no_account', { waitUntil: 'networkidle' })
    await expect(page.locator('.v-alert')).toContainText(/no LGR account/i)

    await page.goto('/auth/login?error=You+have+won+a+prize', { waitUntil: 'networkidle' })
    await expect(page.locator('.v-alert')).toContainText(/sign-in failed/i)
    await expect(page.getByText(/won a prize/i)).toHaveCount(0)
  })

  test('should redirect to landing when not authenticated', async ({ page }) => {
    await page.goto('/dashboard')
    await expect(page).toHaveURL(/\/landing/)
  })

  test('should show register page', async ({ page }) => {
    await page.goto('/auth/register')
    // v-card-title renders as a div, not a heading element
    await expect(page.locator('.v-card-title', { hasText: /create account/i })).toBeVisible()
  })
})

// S-06 — registration no longer returns the activation code, so the emailed link (and asking for a
// new one) is the only way to finish it. None of these change any data.
test.describe('Account activation (S-06)', () => {
  test('a bad link says so, offers a new one, and leaves no code in the address bar', async ({ page }) => {
    await page.goto('/auth/activate#userId=000000000000000000000000&code=zzzzzzz')

    await expect(page.getByText(/invalid or has expired/i)).toBeVisible({ timeout: 10000 })
    // The code rides in the fragment and the page clears it before posting it.
    expect(new URL(page.url()).hash).toBe('')
    await expect(page.getByRole('button', { name: /send a new link/i })).toBeVisible()
  })

  test('asking for a new link gives the same answer for any address', async ({ page }) => {
    await page.goto('/auth/activate', { waitUntil: 'networkidle' })

    await page.getByRole('textbox', { name: /email/i }).fill('nobody-e2e@lgr.test')
    await page.getByRole('button', { name: /send a new link/i }).click()

    await expect(page.getByText(/a new link is on its way/i)).toBeVisible({ timeout: 10000 })
  })

  test('the sign-in page links to it', async ({ page }) => {
    await page.goto('/auth/login', { waitUntil: 'networkidle' })

    await page.getByRole('link', { name: /activation email didn.t arrive/i }).click()

    await page.waitForURL('**/auth/activate')
    await expect(page.getByRole('button', { name: /send a new link/i })).toBeVisible()
  })
})
