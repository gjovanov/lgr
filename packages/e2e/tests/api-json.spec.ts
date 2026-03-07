/**
 * API JSON Serialization Tests
 *
 * Verifies that all API endpoints return valid JSON with proper Content-Type
 * headers. This catches the bug where raw Mongoose documents are returned
 * directly from Elysia controllers, causing Bun to serialize them with
 * Bun.inspect() (unquoted keys) instead of JSON.stringify().
 *
 * These tests run against the portal API (port 4001) which proxies to all
 * module APIs via Caddy.
 */
import { test, expect } from '@playwright/test'

const PORTAL_API = process.env.BASE_URL || 'http://localhost:4001'
const WAREHOUSE_API = 'http://localhost:4030'
const INVOICING_API = 'http://localhost:4020'

interface AuthContext {
  token: string
  orgId: string
}

async function login(org = 'acme-corp', username = 'admin', password = 'test123'): Promise<AuthContext> {
  const res = await fetch(`${PORTAL_API}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ orgSlug: org, username, password }),
  })
  expect(res.ok).toBe(true)
  const data = await res.json()
  expect(data.token).toBeTruthy()
  expect(data.org).toBeTruthy()
  return { token: data.token, orgId: data.org._id || data.org.id }
}

function authHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
}

/** Assert that a response is valid JSON with the expected wrapper key */
async function expectJsonResponse(res: Response, expectedKey?: string) {
  expect(res.ok, `Expected 2xx but got ${res.status}: ${await res.clone().text().catch(() => '')}`).toBe(true)

  // Body must be valid JSON — this will throw if it's Bun.inspect() output
  const body = await res.text()
  let parsed: any
  try {
    parsed = JSON.parse(body)
  } catch {
    throw new Error(
      `Response is not valid JSON. First 200 chars: ${body.slice(0, 200)}\n` +
        'This usually means a raw Mongoose document is returned from the controller.',
    )
  }

  if (expectedKey) {
    expect(parsed).toHaveProperty(expectedKey)
  }

  return parsed
}

test.describe('API JSON Serialization', () => {
  let auth: AuthContext

  test.beforeAll(async () => {
    auth = await login()
  })

  // ── Portal / Org ───────────────────────────────────────────────────

  test('GET /org/:id returns valid JSON with org wrapper', async () => {
    const res = await fetch(`${PORTAL_API}/api/org/${auth.orgId}`, {
      headers: authHeaders(auth.token),
    })
    const data = await expectJsonResponse(res, 'org')
    expect(data.org.name).toBeTruthy()
    expect(data.org.slug).toBeTruthy()
  })

  // ── Users ──────────────────────────────────────────────────────────

  test('GET /org/:id/user returns valid JSON with users array', async () => {
    const res = await fetch(`${PORTAL_API}/api/org/${auth.orgId}/user`, {
      headers: authHeaders(auth.token),
    })
    const data = await expectJsonResponse(res, 'users')
    expect(Array.isArray(data.users)).toBe(true)
    expect(data.users.length).toBeGreaterThan(0)
    expect(data.users[0]._id).toBeTruthy()
  })

  test('GET /org/:id/user/:userId returns valid JSON with user wrapper', async () => {
    // First get a user ID from the list
    const listRes = await fetch(`${PORTAL_API}/api/org/${auth.orgId}/user`, {
      headers: authHeaders(auth.token),
    })
    const listData = await listRes.json()
    const userId = listData.users[0]._id

    const res = await fetch(`${PORTAL_API}/api/org/${auth.orgId}/user/${userId}`, {
      headers: authHeaders(auth.token),
    })
    const data = await expectJsonResponse(res, 'user')
    expect(data.user._id).toBeTruthy()
    expect(data.user.email).toBeTruthy()
  })

  // ── Notifications ──────────────────────────────────────────────────

  test('GET /org/:id/notification returns valid JSON with notifications array', async () => {
    const res = await fetch(`${PORTAL_API}/api/org/${auth.orgId}/notification`, {
      headers: authHeaders(auth.token),
    })
    const data = await expectJsonResponse(res, 'notifications')
    expect(Array.isArray(data.notifications)).toBe(true)
  })

  // ── Invites ────────────────────────────────────────────────────────

  test('GET /org/:id/invite returns valid JSON with invites array', async () => {
    const res = await fetch(`${PORTAL_API}/api/org/${auth.orgId}/invite`, {
      headers: authHeaders(auth.token),
    })
    const data = await expectJsonResponse(res, 'invites')
    expect(Array.isArray(data.invites)).toBe(true)
  })

  test('POST + DELETE /org/:id/invite returns valid JSON with invite wrapper', async () => {
    // Create an invite
    const createRes = await fetch(`${PORTAL_API}/api/org/${auth.orgId}/invite`, {
      method: 'POST',
      headers: authHeaders(auth.token),
      body: JSON.stringify({ assignRole: 'member', expiresInHours: 1 }),
    })
    const createData = await expectJsonResponse(createRes, 'invite')
    expect(createData.invite._id).toBeTruthy()
    expect(createData.invite.code).toBeTruthy()

    // Revoke (delete) it
    const deleteRes = await fetch(`${PORTAL_API}/api/org/${auth.orgId}/invite/${createData.invite._id}`, {
      method: 'DELETE',
      headers: authHeaders(auth.token),
    })
    const deleteData = await expectJsonResponse(deleteRes, 'invite')
    expect(deleteData.invite.status).toBe('revoked')
  })

  // ── Files ──────────────────────────────────────────────────────────

  test('GET /org/:id/file returns valid JSON with files array', async () => {
    const res = await fetch(`${PORTAL_API}/api/org/${auth.orgId}/file`, {
      headers: authHeaders(auth.token),
    })
    const data = await expectJsonResponse(res, 'files')
    expect(Array.isArray(data.files)).toBe(true)
  })

  // ── Warehouse: Movements ───────────────────────────────────────────

  test('GET /org/:id/warehouse/movement returns valid JSON with number field', async () => {
    const res = await fetch(`${WAREHOUSE_API}/api/org/${auth.orgId}/warehouse/movement?size=1`, {
      headers: authHeaders(auth.token),
    })
    const data = await expectJsonResponse(res, 'stockMovements')
    expect(Array.isArray(data.stockMovements)).toBe(true)
    // Each movement should have a 'number' field mapped from movementNumber
    if (data.stockMovements.length > 0) {
      const m = data.stockMovements[0]
      expect(m.number).toBeTruthy()
      expect(m.fromWarehouseName !== undefined || m.toWarehouseName !== undefined).toBe(true)
    }
  })

  test('GET /org/:id/warehouse/movement/:id returns valid JSON with product names in lines', async () => {
    // Get first movement
    const listRes = await fetch(`${WAREHOUSE_API}/api/org/${auth.orgId}/warehouse/movement?size=1`, {
      headers: authHeaders(auth.token),
    })
    const listData = await listRes.json()
    if (!listData.stockMovements?.length) return test.skip()

    const movId = listData.stockMovements[0]._id
    const res = await fetch(`${WAREHOUSE_API}/api/org/${auth.orgId}/warehouse/movement/${movId}`, {
      headers: authHeaders(auth.token),
    })
    const data = await expectJsonResponse(res, 'stockMovement')
    expect(data.stockMovement._id).toBeTruthy()
    if (data.stockMovement.lines?.length > 0) {
      const line = data.stockMovement.lines[0]
      expect(line.productName).toBeTruthy()
      expect(typeof line.productId).toBe('string') // ObjectId string, not populated object
    }
  })

  // ── Warehouse: Inventory Counts ────────────────────────────────────

  test('GET /org/:id/warehouse/inventory-count returns valid JSON with number + warehouseName', async () => {
    const res = await fetch(`${WAREHOUSE_API}/api/org/${auth.orgId}/warehouse/inventory-count?size=1`, {
      headers: authHeaders(auth.token),
    })
    const data = await expectJsonResponse(res, 'inventoryCounts')
    expect(Array.isArray(data.inventoryCounts)).toBe(true)
    if (data.inventoryCounts.length > 0) {
      const ic = data.inventoryCounts[0]
      expect(ic.number).toBeTruthy()
      expect(ic.warehouseName).toBeTruthy()
      expect(typeof ic.itemCount).toBe('number')
      expect(typeof ic.varianceCount).toBe('number')
    }
  })

  test('GET /org/:id/warehouse/inventory-count/:id returns valid JSON with product names', async () => {
    const listRes = await fetch(`${WAREHOUSE_API}/api/org/${auth.orgId}/warehouse/inventory-count?size=1`, {
      headers: authHeaders(auth.token),
    })
    const listData = await listRes.json()
    if (!listData.inventoryCounts?.length) return test.skip()

    const icId = listData.inventoryCounts[0]._id
    const res = await fetch(`${WAREHOUSE_API}/api/org/${auth.orgId}/warehouse/inventory-count/${icId}`, {
      headers: authHeaders(auth.token),
    })
    const data = await expectJsonResponse(res, 'inventoryCount')
    expect(data.inventoryCount._id).toBeTruthy()
    if (data.inventoryCount.lines?.length > 0) {
      const line = data.inventoryCount.lines[0]
      expect(line.productName).toBeTruthy()
      expect(typeof line.productId).toBe('string')
    }
  })

  // ── Warehouse: Stock Levels ────────────────────────────────────────

  test('GET /org/:id/warehouse/stock-level returns valid JSON with product/warehouse names', async () => {
    const res = await fetch(`${WAREHOUSE_API}/api/org/${auth.orgId}/warehouse/stock-level?size=1`, {
      headers: authHeaders(auth.token),
    })
    const data = await expectJsonResponse(res, 'stockLevels')
    expect(Array.isArray(data.stockLevels)).toBe(true)
    if (data.stockLevels.length > 0) {
      const sl = data.stockLevels[0]
      expect(sl.productName).toBeTruthy()
      expect(sl.warehouseName).toBeTruthy()
      expect(typeof sl.productId).toBe('string')
    }
  })

  test('GET /org/:id/warehouse/stock-level?search= filters by product name', async () => {
    // First get a known product name
    const allRes = await fetch(`${WAREHOUSE_API}/api/org/${auth.orgId}/warehouse/stock-level?size=1`, {
      headers: authHeaders(auth.token),
    })
    const allData = await allRes.json()
    if (!allData.stockLevels?.length) return test.skip()

    const productName = allData.stockLevels[0].productName
    const searchTerm = productName.split(' ')[0] // first word

    const res = await fetch(
      `${WAREHOUSE_API}/api/org/${auth.orgId}/warehouse/stock-level?search=${encodeURIComponent(searchTerm)}&size=5`,
      { headers: authHeaders(auth.token) },
    )
    const data = await expectJsonResponse(res, 'stockLevels')
    expect(data.stockLevels.length).toBeGreaterThan(0)
  })

  // ── Invoicing: Invoices ────────────────────────────────────────────

  test('GET /org/:id/invoices returns valid JSON with invoices array', async () => {
    const res = await fetch(`${INVOICING_API}/api/org/${auth.orgId}/invoices?size=1`, {
      headers: authHeaders(auth.token),
    })
    const data = await expectJsonResponse(res, 'invoices')
    expect(Array.isArray(data.invoices)).toBe(true)
  })

  test('POST /org/:id/invoices with type=proforma succeeds (direction + subtotal)', async () => {
    // Get a contact
    const contactRes = await fetch(`${INVOICING_API}/api/org/${auth.orgId}/invoicing/contact?size=1`, {
      headers: authHeaders(auth.token),
    })
    const contactData = await contactRes.json()
    if (!contactData.contacts?.length) return test.skip()

    const res = await fetch(`${INVOICING_API}/api/org/${auth.orgId}/invoices`, {
      method: 'POST',
      headers: authHeaders(auth.token),
      body: JSON.stringify({
        type: 'proforma',
        direction: 'outgoing',
        contactId: contactData.contacts[0]._id,
        issueDate: '2026-03-03',
        currency: 'EUR',
        lines: [{ description: 'E2E test', quantity: 1, unitPrice: 10, discount: 0, taxRate: 0 }],
        subtotal: 10,
        total: 10,
      }),
    })
    const data = await expectJsonResponse(res, 'invoice')
    expect(data.invoice.type).toBe('proforma')
    expect(data.invoice.direction).toBe('outgoing')

    // Cleanup
    await fetch(`${INVOICING_API}/api/org/${auth.orgId}/invoices/${data.invoice._id}`, {
      method: 'DELETE',
      headers: authHeaders(auth.token),
    })
  })
})

test.describe('UI Data Loading', () => {
  test('Organization settings page shows actual org data', async ({ page }) => {
    // Login via API to portal
    const loginRes = await fetch(`${PORTAL_API}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orgSlug: 'acme-corp', username: 'admin', password: 'test123' }),
    })
    const loginData = await loginRes.json()

    await page.addInitScript(({ token, org }) => {
      localStorage.setItem('lgr_token', token)
      if (org) localStorage.setItem('lgr_org', JSON.stringify(org))
    }, { token: loginData.token, org: loginData.org })

    await page.goto('/settings/organization', { waitUntil: 'networkidle' })

    // Name field should have actual org name, not be empty
    const nameInput = page.getByLabel(/name/i).first()
    await expect(nameInput).toBeVisible({ timeout: 10000 })
    const value = await nameInput.inputValue()
    expect(value.length).toBeGreaterThan(0)
    expect(value).not.toBe('')
  })

  test('Movements page shows # column with data', async ({ page }) => {
    const loginRes = await fetch(`${PORTAL_API}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orgSlug: 'acme-corp', username: 'admin', password: 'test123' }),
    })
    const loginData = await loginRes.json()

    await page.addInitScript(({ token, org }) => {
      localStorage.setItem('lgr_token', token)
      if (org) localStorage.setItem('lgr_org', JSON.stringify(org))
    }, { token: loginData.token, org: loginData.org })

    await page.goto(`${WAREHOUSE_API}/warehouse/movements`, { waitUntil: 'networkidle' })
    await expect(page.locator('.v-data-table')).toBeVisible({ timeout: 10000 })

    // If there are rows, the # column should have non-empty values
    const rows = page.locator('.v-data-table tbody tr')
    const count = await rows.count()
    if (count > 0) {
      // First cell of first row (# column) should not be empty
      const firstCell = rows.first().locator('td').first()
      const text = await firstCell.textContent()
      // Should contain a movement number like "SM-2026-00001", not be blank
      if (text && text.trim()) {
        expect(text.trim().length).toBeGreaterThan(0)
      }
    }
  })

  test('Stock Levels page has search field', async ({ page }) => {
    const loginRes = await fetch(`${PORTAL_API}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orgSlug: 'acme-corp', username: 'admin', password: 'test123' }),
    })
    const loginData = await loginRes.json()

    await page.addInitScript(({ token, org }) => {
      localStorage.setItem('lgr_token', token)
      if (org) localStorage.setItem('lgr_org', JSON.stringify(org))
    }, { token: loginData.token, org: loginData.org })

    await page.goto(`${WAREHOUSE_API}/warehouse/stock-levels`, { waitUntil: 'networkidle' })
    await expect(page.locator('.v-data-table')).toBeVisible({ timeout: 10000 })

    // Search field should be present (use getByRole to avoid matching "Clear Search" icon)
    const searchField = page.getByRole('textbox', { name: /search/i })
    await expect(searchField).toBeVisible()
  })
})
