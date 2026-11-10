import { test, expect } from '@playwright/test'
import { signInAsMultiInAcme } from './helpers/org-switcher'
import { navDrawer } from './helpers/nav'
import { showOrgAs } from './helpers/env-badge'

/**
 * The left navigation's header (`OrgSelector`) beside the app bar, collapsed and on a phone.
 *
 * 2026-11-10: the PROD / DEV badge in the header's subtitle made the COLLAPSED rail's header 186 px tall beside a
 * 53 px app bar. A subtitle made of an inline element and a badge is not reached by Vuetify's one-line clamp, and
 * a rail gives it no width, so it wrapped a letter per line. The header must stay as high as the app bar (the two
 * share a bottom border), with a badge or without.
 */
test.describe.configure({ mode: 'serial' })

const MARKERS = [undefined, 'prod', 'dev'] as const

for (const environment of MARKERS) {
  test(`the collapsed rail's header is as high as the app bar (${environment ?? 'no badge'})`, async ({ page }) => {
    await page.setViewportSize({ width: 1366, height: 800 })
    if (environment) await showOrgAs(page, environment)
    await signInAsMultiInAcme(page)
    // The pointer off the rail, which folds it back; a new tab's pointer starts on it.
    await page.mouse.move(700, 400)

    if (environment) await expect(page.getByTestId(`env-badge-${environment}`).first()).toBeVisible({ timeout: 15000 })
    else await expect(page.locator('[data-testid^="env-badge-"]')).toHaveCount(0)

    const bar = await page.locator('.v-app-bar').boundingBox()
    const header = await page.locator('.org-header').boundingBox()
    expect(bar).not.toBeNull()
    expect(header).not.toBeNull()
    expect(header!.width).toBeLessThan(80) // the rail, not the expanded drawer
    expect(header!.height).toBeLessThanOrEqual(bar!.height + 2)
  })
}

test('on a phone the drawer opens from the bar and its chevron closes it', async ({ page }) => {
  await showOrgAs(page, 'prod')
  // Signed in at a desktop width (the helper reads the org's NAME in the bar, which a phone's icon-only button hides),
  // then the window narrows to a phone's.
  await signInAsMultiInAcme(page)
  await page.setViewportSize({ width: 390, height: 800 })

  const drawer = navDrawer(page)
  await expect(drawer).not.toHaveClass(/v-navigation-drawer--active/)
  await page.locator('.v-app-bar-nav-icon').click()
  await expect(drawer).toHaveClass(/v-navigation-drawer--active/)

  const bar = await page.locator('.v-app-bar').boundingBox()
  const header = await page.locator('.org-header').boundingBox()
  expect(header!.height).toBeLessThanOrEqual(bar!.height + 2)

  await page.locator('.org-header .v-btn').click()
  await expect(drawer).not.toHaveClass(/v-navigation-drawer--active/)
})
