import type { Locator, Page } from '@playwright/test'

/**
 * The main sidebar.
 *
 * ⚠ NOT `page.locator('.v-navigation-drawer')`, which every spec used to write and which now
 * matches TWO elements — Vuetify strict mode then fails with "resolved to 2 elements" before
 * any assertion runs. `ui-shell/PendingChangesPanel.vue` is a second drawer (`location="right"`,
 * temporary) mounted by the module layout (`ui-shell/ModuleLayout.vue`) on every page, so the bare selector is ambiguous on
 * every screen in the product.
 *
 * Scoped on Vuetify's own left/right modifier rather than a `data-testid`, because adding one
 * to `AppShell.vue` would mean rebuilding the web app to run a test.
 */
export function navDrawer(page: Page): Locator {
  return page.locator('.v-navigation-drawer--left')
}

/**
 * The sidebar, expanded, with its item titles actually visible.
 *
 * ⚠ `AppShell.vue` sets `const rail = ref(true)` — the sidebar now starts COLLAPSED, with
 * `expand-on-hover`. In rail mode every `.v-list-item-title` is still in the DOM but `hidden`,
 * so an assertion on nav text fails with "unexpected value hidden" while a DOM dump shows the
 * element present and looking perfectly fine. Hovering is what the user does to read the
 * labels, and it is what a spec has to do before asserting on them.
 */
/**
 * Switch UI language.
 *
 * ⚠ There is no longer a `BG` button to click. FR-05 (#12) turned the locale switcher into a
 * `v-menu`: ONE button showing the CURRENT locale, which opens a list of the others. Specs that
 * did `getByRole('button', { name: 'BG' })` now time out at 10s against an element that has not
 * existed for months — and the timeout says only "waiting for locator", never that the control
 * changed shape.
 */
export async function switchLocale(page: Page, code: string): Promise<void> {
  // The activator carries the translate icon; its label is whatever locale is active now, so it
  // cannot be found by the code being switched TO.
  await page.locator('.v-app-bar button').filter({ has: page.locator('.mdi-translate') }).click()
  await page.locator('.v-overlay-container .v-list-item').filter({ hasText: new RegExp(`^${code}$`, 'i') }).click()
  await page.waitForTimeout(300)
}

/**
 * Takes the pointer off the drawer, which then folds back to its rail. Expanded, it covers the left
 * of the top bar, and a click there never reaches the bar. Do this before clicking the bar: a person's
 * hand does it on the way, and a new tab's pointer starts at (0,0), which is on the rail.
 */
export async function leaveNavDrawer(page: Page) {
  await page.mouse.move(640, 360)
}

export async function openNavDrawer(page: Page): Promise<Locator> {
  const drawer = navDrawer(page)
  await drawer.waitFor({ state: 'visible' })
  await drawer.hover()
  // The expand is a width transition; the titles become visible as it settles.
  await drawer.locator('.v-list-item-title').first().waitFor({ state: 'visible' })
  return drawer
}

/** CR Sessions' files: a page nothing has opened by the time a test says they are gone. */
export const SESSION_FILES = /\/ui\/PosSessionsView-[^/]+\.(js|css)$/

/** A deploy: these files are gone from under this document. The next document has what it needs. */
export async function filesGone(page: Page, files: RegExp = SESSION_FILES) {
  let deployed = true
  page.on('request', (r) => { if (r.isNavigationRequest() && r.frame() === page.mainFrame()) deployed = false })
  await page.route(files, route => (deployed ? route.abort() : route.continue()))
}
