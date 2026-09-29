import { describe, it, expect } from 'bun:test'
import { classifyTokenHandoff, isDevTokenHandoffOrigin } from 'ui-shared/nav/navigate'

/**
 * FR-14.24 — login fixation through `?token=`.
 *
 * Every `*-ui` router used to write a `?token=` query parameter straight into `localStorage`
 * on ANY origin, while only the SENDING side (`appHref`) was limited to the local dev ports.
 * So `https://lgrai.app/apps?token=<attacker's JWT>` signed the visitor's browser into the
 * attacker's account and org.
 *
 * `classifyTokenHandoff` is the receiving gate. It is pure when handed a location, which is
 * what makes these cases assertable without a browser.
 */

const PROD = { hostname: 'lgrai.app', port: '' }
const PROD_443 = { hostname: 'lgrai.app', port: '443' }
const PORTAL_DEV = { hostname: 'localhost', port: '4000' }
const UNIFIED_DEV = { hostname: 'localhost', port: '4001' }
const INVOICING_DEV = { hostname: 'localhost', port: '4021' }
const LOOPBACK_IP = { hostname: '127.0.0.1', port: '4021' }

describe('isDevTokenHandoffOrigin', () => {
  it('accepts localhost on every dev port we serve from', () => {
    for (const loc of [PORTAL_DEV, UNIFIED_DEV, INVOICING_DEV, LOOPBACK_IP]) {
      expect(isDevTokenHandoffOrigin(loc)).toBe(true)
    }
  })

  it('includes 4001 — the domain apps\' "back to Portal" hop targets it cross-origin', () => {
    expect(isDevTokenHandoffOrigin(UNIFIED_DEV)).toBe(true)
  })

  it('refuses production, whatever the port', () => {
    expect(isDevTokenHandoffOrigin(PROD)).toBe(false)
    expect(isDevTokenHandoffOrigin(PROD_443)).toBe(false)
  })

  it('refuses a localhost-lookalike hostname', () => {
    expect(isDevTokenHandoffOrigin({ hostname: 'localhost.evil.example', port: '4021' })).toBe(false)
    expect(isDevTokenHandoffOrigin({ hostname: 'notlocalhost', port: '4021' })).toBe(false)
  })

  it('refuses localhost on a port that is not ours', () => {
    expect(isDevTokenHandoffOrigin({ hostname: 'localhost', port: '8080' })).toBe(false)
    expect(isDevTokenHandoffOrigin({ hostname: 'localhost', port: '' })).toBe(false)
  })
})

describe('classifyTokenHandoff — the exposure this closes', () => {
  it('REJECTS a token on a production origin (the fixation case)', () => {
    const h = classifyTokenHandoff({ token: 'attacker.jwt.here', org: 'attacker-org' }, { loc: PROD })
    expect(h.action).toBe('reject')
    // A reject carries no credential, so there is nothing a caller could store by accident.
    expect(h).toEqual({ action: 'reject' })
  })

  it('REJECTS an `org` on its own on a production origin', () => {
    expect(classifyTokenHandoff({ org: 'someone-elses-org' }, { loc: PROD }).action).toBe('reject')
  })

  it('REJECTS a token even when only `token` and no `org` is present', () => {
    expect(classifyTokenHandoff({ token: 'x' }, { loc: PROD_443 }).action).toBe('reject')
  })
})

describe('classifyTokenHandoff — the dev handoff still works', () => {
  it('accepts token+org on a per-app Vite dev port', () => {
    expect(classifyTokenHandoff({ token: 'tok', org: 'acme' }, { loc: INVOICING_DEV })).toEqual({
      action: 'accept',
      token: 'tok',
      org: 'acme',
    })
  })

  it('accepts on 4001, so "back to Portal" in dev keeps its session', () => {
    expect(classifyTokenHandoff({ token: 'tok', org: 'acme' }, { loc: UNIFIED_DEV }).action).toBe('accept')
  })

  it('accepts a token with no org', () => {
    expect(classifyTokenHandoff({ token: 'tok' }, { loc: PORTAL_DEV })).toEqual({
      action: 'accept',
      token: 'tok',
      org: undefined,
    })
  })

  it('rejects an org handed over with no token, even in dev — an org alone signs nobody in', () => {
    expect(classifyTokenHandoff({ org: 'acme' }, { loc: INVOICING_DEV }).action).toBe('reject')
  })
})

describe('classifyTokenHandoff — everything else is left alone', () => {
  it('does nothing when there is no token and no org', () => {
    expect(classifyTokenHandoff({}, { loc: PROD }).action).toBe('none')
    expect(classifyTokenHandoff({ page: '2', search: 'bolt' }, { loc: INVOICING_DEV }).action).toBe('none')
  })

  it('does nothing when `skip` is set — portal-ui\'s OAuth callback owns its own `token`', () => {
    expect(classifyTokenHandoff({ token: 'oauth-code' }, { skip: true, loc: PORTAL_DEV }).action).toBe('none')
    // ⚠ And on production too: the callback view consumes it, the router must not touch it.
    expect(classifyTokenHandoff({ token: 'oauth-code' }, { skip: true, loc: PROD }).action).toBe('none')
  })

  it('ignores a repeated parameter, which vue-router hands over as an array', () => {
    // `?token=a&token=b` → `['a','b']`. Not a string, so not a handoff — and never stored.
    expect(classifyTokenHandoff({ token: ['a', 'b'] }, { loc: INVOICING_DEV }).action).toBe('none')
  })

  it('ignores a valueless parameter (`?token`), which vue-router gives as null', () => {
    expect(classifyTokenHandoff({ token: null }, { loc: INVOICING_DEV }).action).toBe('none')
  })
})
