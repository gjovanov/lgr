import { expect, type Page } from '@playwright/test'
import { leaveNavDrawer } from './nav'

/**
 * Multi-org sign-in helpers. They live in a helper module, not the spec, because a spec here
 * cannot type-import from `@playwright/test` (CLAUDE.md, E2E gotcha 2).
 */

export const ACME = /acme corp/i
export const BETA = /beta inc/i

/**
 * Sign in as `multi@lgr.test` (seed: manager in Acme Corp, accountant in Beta Inc) and end up in
 * Acme. The first sign-in ever has no org chosen yet and shows the picker; later ones land where
 * the person (or this browser) was last.
 */
export async function signInAsMultiInAcme(page: Page) {
  await page.goto('/auth/login', { waitUntil: 'networkidle' })
  await page.getByRole('textbox', { name: /username/i }).fill('multi@lgr.test')
  await page.getByRole('textbox', { name: /password/i }).fill('test123')
  await page.getByRole('button', { name: /sign in/i }).click()
  await page.waitForURL(/\/(orgs|dashboard)/, { timeout: 15000 })
  if (page.url().includes('/orgs')) {
    await expect(page.getByTestId('org-picker-org')).toHaveCount(2)
    await page.getByTestId('org-picker-org').filter({ hasText: ACME }).click()
    await page.waitForURL('**/apps', { timeout: 15000 })
  }
  await expect(page.getByTestId('org-switcher')).toBeVisible({ timeout: 15000 })
  if (!ACME.test((await page.getByTestId('org-switcher').textContent()) ?? '')) await switchTo(page, ACME)
}

/** Open the org menu in the top bar and enter the org matching `name`. */
export async function switchTo(page: Page, name: RegExp) {
  await leaveNavDrawer(page)
  await page.getByTestId('org-switcher').click()
  await page.getByTestId('org-switcher-org').filter({ hasText: name }).click()
  await expect(page.getByTestId('org-switcher')).toContainText(name, { timeout: 15000 })
}

/** Sign out from the user menu in the app bar. */
export async function signOut(page: Page) {
  await page.locator('.v-app-bar').getByRole('button').filter({ has: page.locator('.v-avatar') }).click()
  await page.getByRole('listitem').filter({ hasText: /sign out/i }).click()
}
