import type { Page } from '@playwright/test'

/**
 * Stub the company-lookup endpoint.
 *
 * ⚠ These tests used to drive the REAL lookup, which reaches eik.bg / VerifyVAT — a live
 * third party on a 50-request-per-month quota. That is a standing Known Issue in CLAUDE.md
 * ("VerifyVAT integration tests hit live API ... tests flaky/failing"), and it makes the
 * suite fail for reasons that have nothing to do with this codebase: quota exhausted, the
 * service slow, or simply no network on the machine running it. The symptom is an empty
 * Company Name and `expect(companyName.length).toBeGreaterThan(0)` receiving 0.
 *
 * What the spec is actually for is the UI wiring — type an identifier, press the lookup
 * button, and watch the company name and address fields populate. Stubbing the response
 * tests exactly that, deterministically, and stops a third party's rate limit from deciding
 * whether our build is green.
 *
 * ⚠ It does NOT test that the lookup service integration works. That belongs in an
 * integration test against the provider, run deliberately and not on every push.
 */
export async function stubCompanyLookup(
  page: Page,
  company: {
    companyName?: string
    taxNumber?: string
    vatNumber?: string
    address?: { street?: string; city?: string; postalCode?: string; country?: string }
  },
): Promise<void> {
  await page.route('**/invoicing/contact/lookup/**', async route => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ company }),
    })
  })
}
