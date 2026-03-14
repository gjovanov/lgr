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
      ],
    },
    {
      name: 'accounting',
      use: { ...devices['Desktop Chrome'], baseURL },
      testMatch: ['accounting.spec.ts', 'accounting-crud.spec.ts'],
    },
    {
      name: 'invoicing',
      use: { ...devices['Desktop Chrome'], baseURL },
      testMatch: ['invoicing.spec.ts', 'invoicing-crud.spec.ts', 'proforma-convert.spec.ts', 'credit-notes-fix.spec.ts', 'invoice-stock-adjustment.spec.ts', 'payment-orders.spec.ts', 'cash-orders.spec.ts', 'cash-sales.spec.ts', 'contact-inline-create.spec.ts', 'company-lookup.spec.ts', 'invoicing-product-autocomplete.spec.ts', 'tag-pricing.spec.ts'],
    },
    {
      name: 'warehouse',
      use: { ...devices['Desktop Chrome'], baseURL },
      testMatch: ['warehouse.spec.ts', 'warehouse-crud.spec.ts', 'tags.spec.ts', 'movements-product-filter.spec.ts', 'product-stock-page.spec.ts'],
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
