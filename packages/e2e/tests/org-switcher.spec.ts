import { test, expect } from '@playwright/test'
import { ACME, BETA, signInAsMultiInAcme, signOut, switchTo } from './helpers/org-switcher'

/**
 * Multi-org sign-in, Phase 3: one person, one sign-in, every org they work in, and each browser
 * tab in its own org.
 *
 * Serial: the person's "last org" lives on the server, so the cases share it on purpose.
 */
test.describe.configure({ mode: 'serial' })

test('signs in once and switches org from the top bar', async ({ page }) => {
  await signInAsMultiInAcme(page)
  await switchTo(page, BETA)
  await switchTo(page, ACME)
})

test('two tabs stay in two different orgs', async ({ context }) => {
  const first = await context.newPage()
  await signInAsMultiInAcme(first)

  // A new tab starts where the person last was, then goes its own way.
  const second = await context.newPage()
  await second.goto('/apps', { waitUntil: 'networkidle' })
  await expect(second.getByTestId('org-switcher')).toContainText(ACME, { timeout: 15000 })
  await switchTo(second, BETA)

  // The first tab did not follow, even after a reload.
  await first.reload({ waitUntil: 'networkidle' })
  await expect(first.getByTestId('org-switcher')).toContainText(ACME, { timeout: 15000 })
  await expect(second.getByTestId('org-switcher')).toContainText(BETA)
})

test('signing out in one tab signs out the other', async ({ context }) => {
  const first = await context.newPage()
  await signInAsMultiInAcme(first)

  const second = await context.newPage()
  await second.goto('/apps', { waitUntil: 'networkidle' })
  await expect(second.getByTestId('org-switcher')).toBeVisible({ timeout: 15000 })

  await signOut(first)
  await first.waitForURL('**/auth/login', { timeout: 10000 })
  await second.waitForURL('**/auth/login', { timeout: 10000 })
})

test('the org picker lists both orgs', async ({ page }) => {
  await signInAsMultiInAcme(page)
  await page.goto('/orgs', { waitUntil: 'networkidle' })
  await expect(page.getByTestId('org-picker-org')).toHaveCount(2)
  await expect(page.getByTestId('org-picker-org').filter({ hasText: ACME })).toBeVisible()
  await expect(page.getByTestId('org-picker-org').filter({ hasText: BETA })).toBeVisible()
})
