import { describe, it, expect } from 'bun:test'
import { pickSessionToken, asSessionUser } from 'services/biz/session-token'

/**
 * The two rules every auth plugin applies (S-22), pinned where a refactor would trip on them first.
 *
 * ⚠ The empty-bearer cases are LOAD-BEARING. Ten ops scripts set `Authorization: Bearer ${TOKEN}`
 * unconditionally, so their very first call (`POST /api/auth/login`, before any token exists) sends
 * `Bearer ` with nothing after it: adjust-stock, check-doc-sequences, compare-products,
 * create-missing-products, import-cash-register-sales, import-purchase-invoices,
 * import-sales-invoices, receive-new-products, receive-stock, transfer-stock. If an empty bearer
 * ever counted as an INVALID token (a 401, never rescued) instead of no header, every one of them
 * would fail to sign in. Spotted by the doc-import session reviewing S-22 on 2026-10-04.
 */
describe('pickSessionToken', () => {
  it('treats an empty bearer as no header at all', () => {
    for (const header of ['Bearer ', 'Bearer', 'bearer ', '  Bearer   ', 'BEARER\t']) {
      expect(pickSessionToken(header, undefined)).toBe('')
      expect(pickSessionToken(header, 'cookie-token')).toBe('cookie-token')
    }
  })

  it('uses a non-empty header exclusively, never the cookie', () => {
    expect(pickSessionToken('Bearer header-token', 'cookie-token')).toBe('header-token')
    expect(pickSessionToken('bearer header-token', 'cookie-token')).toBe('header-token')
    // A header without the prefix is the raw token, as it always was.
    expect(pickSessionToken('raw-token', 'cookie-token')).toBe('raw-token')
    // Even a header that will fail verification is not swapped for the cookie.
    expect(pickSessionToken('Bearer not-a-jwt', 'cookie-token')).toBe('not-a-jwt')
  })

  it('falls back to the cookie only when no header is sent', () => {
    expect(pickSessionToken(undefined, 'cookie-token')).toBe('cookie-token')
    expect(pickSessionToken('', 'cookie-token')).toBe('cookie-token')
    expect(pickSessionToken(undefined, undefined)).toBe('')
    expect(pickSessionToken(undefined, { not: 'a string' })).toBe('')
  })
})

describe('asSessionUser', () => {
  const session = { id: 'u1', orgId: 'o1', email: 'a@b.c', permissions: [] }

  it('accepts session-shaped claims', () => {
    expect(asSessionUser(session)).toEqual(session as any)
  })

  it('refuses anything that is not a session', () => {
    expect(asSessionUser(false)).toBeNull()
    expect(asSessionUser(null)).toBeNull()
    expect(asSessionUser('a string')).toBeNull()
    expect(asSessionUser({ orgId: 'o1' })).toBeNull()
    expect(asSessionUser({ id: 'u1' })).toBeNull()
    expect(asSessionUser({ id: '', orgId: 'o1' })).toBeNull()
    expect(asSessionUser({ id: 1, orgId: 'o1' })).toBeNull()
    expect(asSessionUser({ ...session, type: 'oauth_pending' })).toBeNull()
  })
})
