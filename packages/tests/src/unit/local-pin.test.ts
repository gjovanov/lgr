import { describe, it, expect } from 'bun:test'
import { BACKOFF, backoffDelayMs, pinRuleViolation } from 'services/biz/identity/local-credentials.service'
import { permissionRefusal, pinScopeRefusal } from 'services/biz/route-permission'

/** FR-20.40 (plan step P1-5a): what a till PIN may be, how it slows down, and what its session reaches. */

describe('a PIN', () => {
  it('is 6 to 12 digits', () => {
    expect(pinRuleViolation('402613')).toBeNull()
    expect(pinRuleViolation('402613987125')).toBeNull()
    for (const p of ['40261', '4026139871250', '40261a', ' 402613', '']) expect(pinRuleViolation(p)).not.toBeNull()
  })

  it('is not one a person guesses first', () => {
    for (const p of ['000000', '777777', '123456', '012345', '987654', '3456789']) expect(pinRuleViolation(p)).not.toBeNull()
    expect(pinRuleViolation('123457')).toBeNull()
  })
})

describe('backing off', () => {
  it('lets three slips pass, then doubles from a second to a minute, and never stops', () => {
    expect([1, 2, 3].map(backoffDelayMs)).toEqual([0, 0, 0])
    expect([4, 5, 6, 7].map(backoffDelayMs)).toEqual([1_000, 2_000, 4_000, 8_000])
    expect(backoffDelayMs(50)).toBe(BACKOFF.maxMs)
    expect(backoffDelayMs(10_000)).toBe(BACKOFF.maxMs)
  })
})

describe("a PIN session's reach", () => {
  const pin = (role: string) => ({ role, permissions: ['pos.read', 'pos.write', 'payroll.read'], amr: ['pin'] })

  it('is the till', () => {
    for (const [method, route] of [
      ['GET', '/api/org/:orgId/trade/pos/catalog'], ['POST', '/api/org/:orgId/trade/pos/session/:id/transaction'],
      ['GET', '/api/org/:orgId/fiscal/device'], ['GET', '/api/org/:orgId/warehouse/product-category'],
      ['GET', '/api/org/:orgId'], ['GET', '/api/auth/me'], ['POST', '/api/auth/logout'], ['POST', '/api/auth/local/pin'],
    ]) expect(pinScopeRefusal(pin('sales'), method, route)).toBeNull()
  })

  it('is not the rest, for an admin either', () => {
    for (const role of ['sales', 'admin']) {
      for (const [method, route] of [
        ['GET', '/api/org/:orgId/payroll/payslip'], ['GET', '/api/org/:orgId/invoices'], ['PUT', '/api/org/:orgId'],
        ['POST', '/api/auth/switch'], ['POST', '/api/auth/password'], ['PUT', '/api/auth/local/pin'],
        ['GET', '/api/org/:orgId/warehouse/product'],
      ]) expect(permissionRefusal(pin(role), method, route)?.code).toBe('pin_session_scope')
    }
  })

  it('leaves a password session alone', () => {
    expect(pinScopeRefusal({ role: 'admin', permissions: [] }, 'GET', '/api/org/:orgId/payroll/payslip')).toBeNull()
    expect(permissionRefusal({ role: 'admin', permissions: [] }, 'GET', '/api/org/:orgId/payroll/payslip')).toBeNull()
  })
})
