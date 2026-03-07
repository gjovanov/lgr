import { defineConfig, devices } from '@playwright/test'

// BASE_URL only overrides the portal project; domain apps always use their fixed ports
const portalURL = process.env.BASE_URL || 'http://localhost:4001'

export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 1,
  workers: process.env.CI ? 1 : 4,
  timeout: 30000,
  reporter: 'html',
  use: {
    baseURL: portalURL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    actionTimeout: 10000,
  },
  projects: [
    {
      name: 'portal',
      use: { ...devices['Desktop Chrome'], baseURL: portalURL },
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
      use: { ...devices['Desktop Chrome'], baseURL: 'http://localhost:4010' },
      testMatch: ['accounting.spec.ts', 'accounting-crud.spec.ts'],
    },
    {
      name: 'invoicing',
      use: { ...devices['Desktop Chrome'], baseURL: 'http://localhost:4020' },
      testMatch: ['invoicing.spec.ts', 'invoicing-crud.spec.ts', 'proforma-convert.spec.ts', 'credit-notes-fix.spec.ts', 'invoice-stock-adjustment.spec.ts', 'payment-orders.spec.ts', 'cash-orders.spec.ts'],
    },
    {
      name: 'warehouse',
      use: { ...devices['Desktop Chrome'], baseURL: 'http://localhost:4030' },
      testMatch: ['warehouse.spec.ts', 'warehouse-crud.spec.ts', 'tags.spec.ts', 'movements-product-filter.spec.ts', 'product-stock-dialog.spec.ts'],
    },
    {
      name: 'payroll',
      use: { ...devices['Desktop Chrome'], baseURL: 'http://localhost:4040' },
      testMatch: ['payroll.spec.ts', 'payroll-crud.spec.ts'],
    },
    {
      name: 'hr',
      use: { ...devices['Desktop Chrome'], baseURL: 'http://localhost:4050' },
      testMatch: ['hr.spec.ts', 'hr-crud.spec.ts'],
    },
    {
      name: 'crm',
      use: { ...devices['Desktop Chrome'], baseURL: 'http://localhost:4060' },
      testMatch: ['crm.spec.ts', 'crm-crud.spec.ts'],
    },
    {
      name: 'erp',
      use: { ...devices['Desktop Chrome'], baseURL: 'http://localhost:4070' },
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
