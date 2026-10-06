import { defineConfig, devices } from '@playwright/test'

const baseURL = process.env.BASE_URL || 'http://localhost:4001'

export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 1,
  workers: process.env.CI ? 1 : 4,
  timeout: 30000,
  reporter: 'html',
  use: {
    baseURL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    actionTimeout: 10000,
  },
  projects: [
    {
      name: 'portal',
      use: { ...devices['Desktop Chrome'], baseURL },
      testMatch: [
        'auth.spec.ts',
        'oauth.spec.ts',
        'invite.spec.ts',
        'settings.spec.ts',
        'app-hub.spec.ts',
        'dashboard.spec.ts',
        'navigation.spec.ts',
        'locale.spec.ts',
        'api-json.spec.ts',
        // gjovanov/lgr#31 P2 — three shipped portal screens that had no spec at all.
        'audit-log.spec.ts',
        'digest.spec.ts',
        'backup.spec.ts',
        // FR-06 (#14): grouped with portal because it exercises the App Hub tile and the
        // cross-SPA redirects out of invoicing, not the invoicing grids themselves.
        'reports.spec.ts',
        // Multi-org sign-in: the org menu, the picker and per-tab orgs.
        'org-switcher.spec.ts',
      ],
    },
    {
      // gjovanov/lgr#31 — API-only, no browser work, so it is kept out of `portal`: a
      // cross-tenant regression should be runnable (and readable) on its own in seconds.
      name: 'security',
      use: { ...devices['Desktop Chrome'], baseURL },
      // FR-14.37 (C15 §2): the Desktops endpoints belong here for the same reason the
      // cross-tenant spec does — they are the boundary, and a boundary regression should be
      // runnable on its own in seconds rather than behind twenty minutes of grids.
      testMatch: ['tenant-isolation.spec.ts', 'desktops-security.spec.ts'],
    },
    {
      /**
       * C15 §3 (FR-14.37) — the desktop shell, driven over WebView2's CDP endpoint.
       *
       * ⚠ Its own project because it shares nothing with the rest: no `baseURL` (it talks to the
       * stub hub on loopback) and no browser launched by Playwright (it attaches to a running app).
       *
       * ⚠ **Run it with `--workers=1`.** There is one app and one debugging port — C08's
       * single-instance plugin guarantees exactly that — so parallel workers fight over both. The
       * spec is `mode: 'serial'` internally, which orders ITS cases but does not stop a second
       * worker picking up another file alongside it; `fullyParallel: false` here plus the
       * `--workers=1` in `desktop-ci.yml` is what actually holds.
       *
       * ⚠ The timeout is generous on purpose: one case waits out the unreachable page's retry
       * backoff, which is the behaviour a till depends on when the shop's internet comes back.
       */
      name: 'desktop-app',
      testMatch: ['desktop-app.spec.ts'],
      fullyParallel: false,
      timeout: 180000,
      retries: 0,
    },
    {
      name: 'accounting',
      use: { ...devices['Desktop Chrome'], baseURL },
      testMatch: ['accounting.spec.ts', 'accounting-crud.spec.ts'],
    },
    {
      name: 'invoicing-inventory',
      use: { ...devices['Desktop Chrome'], baseURL },
      testMatch: ['invoicing.spec.ts', 'invoicing-crud.spec.ts', 'invoicing-export.spec.ts', 'proforma-convert.spec.ts', 'credit-notes-fix.spec.ts', 'invoice-stock-adjustment.spec.ts', 'payment-orders.spec.ts', 'cash-orders.spec.ts', 'cash-sales.spec.ts', 'contact-inline-create.spec.ts', 'company-lookup.spec.ts', 'invoicing-product-autocomplete.spec.ts', 'tag-pricing.spec.ts', 'warehouse.spec.ts', 'warehouse-crud.spec.ts', 'tags.spec.ts', 'movements-product-filter.spec.ts', 'product-stock-page.spec.ts', 'stock-validation.spec.ts', 'pos-transactions.spec.ts', 'pos-devices.spec.ts', 'pos-terminal.spec.ts'],
    },
    {
      // Needs a deterministic OCR sidecar — see the header of doc-import.spec.ts for how
      // to start the stub. Kept out of `invoicing-inventory` so a normal run isn't gated
      // on that extra process.
      name: 'doc-import',
      use: { ...devices['Desktop Chrome'], baseURL },
      testMatch: ['doc-import.spec.ts'],
      timeout: 180000,
    },
    {
      name: 'payroll',
      use: { ...devices['Desktop Chrome'], baseURL },
      testMatch: ['payroll.spec.ts', 'payroll-crud.spec.ts'],
    },
    {
      name: 'hr',
      use: { ...devices['Desktop Chrome'], baseURL },
      testMatch: ['hr.spec.ts', 'hr-crud.spec.ts'],
    },
    {
      name: 'crm',
      use: { ...devices['Desktop Chrome'], baseURL },
      testMatch: ['crm.spec.ts', 'crm-crud.spec.ts'],
    },
    {
      name: 'erp',
      use: { ...devices['Desktop Chrome'], baseURL },
      testMatch: ['erp.spec.ts', 'erp-crud.spec.ts'],
    },
    {
      name: 'new-modules',
      use: { ...devices['Desktop Chrome'], baseURL },
      testMatch: ['new-modules-smoke.spec.ts'],
    },
    {
      name: 'full-walkthrough',
      use: {
        ...devices['Desktop Chrome'],
        baseURL: process.env.BASE_URL || 'https://lgrai.app',
        video: 'on',
        viewport: { width: 1920, height: 1080 },
        actionTimeout: 15000,
      },
      testMatch: ['full-walkthrough.spec.ts'],
      timeout: 600000,
      retries: 0,
    },
  ],
  webServer: process.env.CI || process.env.BASE_URL
    ? undefined
    : {
        command: 'cd ../.. && bun run start',
        url: 'http://localhost:4001',
        reuseExistingServer: true,
        timeout: 60000,
      },
})
