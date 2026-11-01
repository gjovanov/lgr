import { test, expect } from '@playwright/test'
import { loginForApp } from './helpers/login'
import { closeTillSession, ringTillSale } from './helpers/cash-register'

/**
 * No sale without a connected printer (2026-10-31). Beta Inc keeps the rule on — the demo org,
 * acme-corp, turns it off — and has no fiscal device: its till takes a cart but will not complete
 * the sale, and says why. The server refuses it too (`till-printer-gate.flow.test.ts`).
 *
 * And a session's transaction count opens that session's own cash-register documents.
 *
 * Fixtures: in beta-inc a store holding one article, made per worker through the API, and a
 * session on it; in acme-corp one till sale (`ringTillSale`). Both sessions are closed at the end.
 */
const apiBase = process.env.BASE_URL || 'http://localhost:4001'

interface Api { token: string; orgId: string }
async function login(orgSlug: string): Promise<Api> {
  const res = await (await fetch(`${apiBase}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ orgSlug, username: 'admin', password: 'test123' }),
  })).json()
  return { token: res.token, orgId: res.org?.id || res.org?._id }
}
async function call(api: Api, method: string, path: string, body?: unknown) {
  const res = await fetch(`${apiBase}/api/org/${api.orgId}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${api.token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  expect(res.ok, `${method} ${path} → ${res.status}`).toBe(true)
  return res.json()
}

let beta: Api
let betaSessionId = ''
let productName = ''

test.beforeAll(async () => {
  beta = await login('beta-inc')
  const ts = Date.now()
  const { warehouse } = await call(beta, 'POST', '/warehouse/warehouse', { name: `E2E Gate ${ts}`, code: `GATE-${ts}`, type: 'store' })
  const warehouseId = warehouse.id || warehouse._id
  productName = `E2E Gate bolt ${ts}`
  const { product } = await call(beta, 'POST', '/warehouse/product', {
    sku: `E2E-GATE-${ts}`, name: productName, category: 'Test', type: 'goods', unit: 'pcs',
    purchasePrice: 1, sellingPrice: 2, taxRate: 0,
  })
  const { stockMovement } = await call(beta, 'POST', '/warehouse/movement', {
    type: 'receipt', date: new Date().toISOString(), toWarehouseId: warehouseId,
    lines: [{ productId: product.id || product._id, quantity: 5, unitCost: 1, totalCost: 5 }], totalAmount: 5,
  })
  await call(beta, 'POST', `/warehouse/movement/${stockMovement.id || stockMovement._id}/confirm`, {})
  const { session } = await call(beta, 'POST', '/trade/pos/session', { warehouseId, openingBalance: 0, currency: 'USD' })
  betaSessionId = session.id || session._id
})

test.afterAll(async () => {
  if (betaSessionId) await call(beta, 'POST', `/trade/pos/session/${betaSessionId}/close`, { closingBalance: 0 })
})

test('with no printer connected the till takes a cart but will not complete the sale, and says why', async ({ page }) => {
  await loginForApp(page, 'beta-inc', 'admin', 'test123')
  await page.goto('/invoicing/cash-sales/new')
  await page.getByRole('textbox', { name: /Search products/i }).fill(productName)
  const card = page.getByTestId('register-card').filter({ hasText: productName })
  await expect(card).toBeVisible({ timeout: 15000 })
  await card.click()

  await expect(page.getByTestId('printer-required')).toContainText('No fiscal printer is set up for this warehouse')
  await expect(page.getByTestId('complete-sale')).toBeDisabled()
})

test('a session\'s transaction count opens its own cash-register documents', async ({ page }) => {
  const sale = await ringTillSale()
  try {
    await loginForApp(page)
    await page.goto('/invoicing/cash-register/sessions')
    const link = page.locator(`[data-testid="session-documents"][href*="session=${sale.sessionId}"]`)
    await expect(link).toBeVisible({ timeout: 15000 })
    await link.click()

    await expect(page).toHaveURL(new RegExp(`/invoicing/cash-sales\\?.*session=${sale.sessionId}`))
    await expect(page.getByTestId('journal-session-chip')).toBeVisible()
    await expect(page.locator('.v-data-table tbody tr').filter({ hasText: sale.number })).toBeVisible({ timeout: 10000 })
  } finally {
    await closeTillSession(sale.sessionId)
  }
})
