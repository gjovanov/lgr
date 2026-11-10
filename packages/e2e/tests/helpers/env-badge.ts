import type { Page } from '@playwright/test'

/**
 * Make the org this tab is in read as `environment` (the PROD / DEV badge).
 *
 * The marker is the server's (`Org.settings.environment`, written only by `scripts/org-clone.ts`), so a spec
 * cannot set it through the app. It adds it to every answer that names the org the shell shows: the sign-in, a
 * switch and `/auth/me`. Install it BEFORE signing in. It lives in a helper module, not the spec, because a
 * spec here cannot type-import from `@playwright/test` (CLAUDE.md, E2E gotcha 2).
 */
export async function showOrgAs(page: Page, environment: 'prod' | 'dev') {
  for (const path of ['me', 'login', 'switch']) {
    await page.route(`**/api/auth/${path}`, async route => {
      const response = await route.fetch()
      const body = await response.json().catch(() => null)
      if (body?.org) body.org.environment = environment
      await route.fulfill({ response, json: body })
    })
  }
}
