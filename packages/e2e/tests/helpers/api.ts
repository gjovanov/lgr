/**
 * Minimal authenticated API access for specs that need a fixture the seed does not provide.
 *
 * Uses native `fetch` rather than Playwright's APIRequestContext for the same reason
 * `helpers/login.ts` does — see the note there about Set-Cookie breaking URL parsing in v1.58.
 */

const API = process.env.BASE_URL || 'http://localhost:4001'

export interface ApiSession {
  token: string
  orgId: string
}

export async function apiLogin(
  orgSlug = 'acme-corp',
  username = 'admin',
  password = 'test123',
): Promise<ApiSession> {
  const res = await fetch(`${API}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ orgSlug, username, password }),
  })
  if (!res.ok) throw new Error(`login failed (${res.status}) — is the DB seeded?`)
  const data = await res.json()
  return { token: data.token, orgId: data.org._id || data.org.id }
}

export async function apiPost(session: ApiSession, path: string, body: unknown): Promise<Response> {
  return fetch(`${API}/api/org/${session.orgId}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.token}` },
    body: JSON.stringify(body),
  })
}

export async function apiDelete(session: ApiSession, path: string): Promise<Response> {
  return fetch(`${API}/api/org/${session.orgId}${path}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${session.token}` },
  })
}

export async function apiGet(session: ApiSession, path: string): Promise<any> {
  const res = await fetch(`${API}/api/org/${session.orgId}${path}`, {
    headers: { Authorization: `Bearer ${session.token}` },
  })
  return res.json()
}

/**
 * The newest ACTIVE contact of a side, for a fixture that needs "a supplier" or "a customer".
 *
 * ⚠ Never `contacts[0]`. The list is newest first and keeps deactivated contacts, and the specs that
 * make contacts of their own (`product-suppliers*`, `product-orders`) deactivate them when they
 * finish. The suite runs in file-name order in one database, so for every later spec the first
 * contact is one of those, and a deactivated one is refused where it matters:
 * `POST /invoicing/bills/from-receipt` (422 `supplier_not_found`), and a new supplier order or
 * customer order (`supplier_inactive`, `client_inactive`).
 *
 * Undefined when the side has no active contact: the caller says what it expected of the seed.
 */
export async function activeContact(session: ApiSession, side: 'customer' | 'supplier'): Promise<any> {
  const { contacts } = await apiGet(session, `/invoicing/contact?type=${side}&size=100`)
  return (contacts || []).find((c: any) => c.isActive !== false)
}

/**
 * Make sure at least one ProductCategory exists, and return its name.
 *
 * ⚠ The seed does NOT create any. It gives products a `category` STRING ('Electronics',
 * 'Hardware', …) but no `ProductCategory` documents, and since the ProductsView filter was
 * changed to load from `/warehouse/product-category` instead of deriving the list from the
 * first page of products, that dropdown is empty in every seeded environment. A spec that
 * opens it and clicks the first option therefore waits 10s for an option that cannot exist.
 */
export async function ensureProductCategory(name = 'E2E Category'): Promise<string> {
  const session = await apiLogin()
  const existing = await apiGet(session, '/warehouse/product-category/?size=1')
  if (existing?.total > 0) {
    const first = existing.categories?.[0] ?? existing.items?.[0]
    if (first?.name) return first.name
  }
  await apiPost(session, '/warehouse/product-category/', { name, isActive: true })
  return name
}
