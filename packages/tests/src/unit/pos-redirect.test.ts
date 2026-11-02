import { describe, it, expect } from 'bun:test'
import { posRedirect } from '../../../portal-api/src/lib/pos-redirect'

/**
 * The POS app's old addresses keep working. The tills in the field store `/pos/` as their start
 * path and the shell opens it on the server, so this map is what stands between a morning's first
 * sale and the portal's landing page.
 */
describe('posRedirect', () => {
  it('the app root and the terminal go to the terminal', () => {
    for (const path of ['/pos', '/pos/', '/pos/terminal', '/pos/terminal/']) {
      expect(posRedirect(path), path).toBe('/invoicing/cash-sales/new')
    }
  })

  it('the journal and one of its documents', () => {
    expect(posRedirect('/pos/orders')).toBe('/invoicing/cash-sales')
    expect(posRedirect('/pos/orders/')).toBe('/invoicing/cash-sales')
    expect(posRedirect('/pos/orders/6a1b2c3d4e5f60718293a4b5')).toBe('/invoicing/cash-sales/6a1b2c3d4e5f60718293a4b5/view')
  })

  it('the sessions', () => {
    expect(posRedirect('/pos/sessions')).toBe('/invoicing/cash-register/sessions')
  })

  it('the devices: the list, a new one and one of them', () => {
    expect(posRedirect('/pos/devices')).toBe('/invoicing/configuration/devices')
    expect(posRedirect('/pos/devices/new')).toBe('/invoicing/configuration/devices/new')
    expect(posRedirect('/pos/devices/6a1b2c3d4e5f60718293a4b5')).toBe('/invoicing/configuration/devices/6a1b2c3d4e5f60718293a4b5')
  })

  it('anything else under /pos/ goes to the terminal', () => {
    for (const path of ['/pos/nope', '/pos/orders/1/extra', '/pos/sessions/1', '/pos/devices/1/edit', '/pos/pin/x']) {
      expect(posRedirect(path), path).toBe('/invoicing/cash-sales/new')
    }
  })

  it('keeps the query string', () => {
    expect(posRedirect('/pos/orders', '?method=cash_on_delivery&q=CS-1')).toBe('/invoicing/cash-sales?method=cash_on_delivery&q=CS-1')
    expect(posRedirect('/pos/orders/6a1b', '?a=1')).toBe('/invoicing/cash-sales/6a1b/view?a=1')
    expect(posRedirect('/pos/devices/6a1b', '?restore=abc')).toBe('/invoicing/configuration/devices/6a1b?restore=abc')
    expect(posRedirect('/pos/', '?a=%D0%9A')).toBe('/invoicing/cash-sales/new?a=%D0%9A')
  })

  it('the PIN pad, without `to`: it was relative to the old app', () => {
    expect(posRedirect('/pos/pin')).toBe('/invoicing/pin')
    expect(posRedirect('/pos/pin', '?to=%2Fterminal')).toBe('/invoicing/pin')
    expect(posRedirect('/pos/pin', '?to=%2Forders&lang=bg')).toBe('/invoicing/pin?lang=bg')
  })

  // ⚠ The trap of a prefix match, and of the POS API sharing the word.
  it('touches nothing that merely starts with /pos, and no API route', () => {
    for (const path of ['/posters', '/pos-archive', '/position/1', '/poss', '/', '/invoicing/cash-sales', '/inventory/pos']) {
      expect(posRedirect(path), path).toBeNull()
    }
    for (const path of ['/api/org/6a1b/trade/pos/session', '/api/org/6a1b/pos/payment-methods', '/api/pos', '/api/pos/terminal']) {
      expect(posRedirect(path), path).toBeNull()
    }
  })

  it('a file under /pos/ is a missing file, not a page', () => {
    for (const path of ['/pos/assets/index-abc123.js', '/pos/assets/index-abc123.css', '/pos/favicon.ico', '/pos/index.html']) {
      expect(posRedirect(path), path).toBeNull()
    }
  })

  // The answer goes into a `Location` header, so nothing in the path may lead off this origin. Each
  // path says what it gets: "may be null" was a line that let most of them through unasked.
  it('never leaves the origin, whatever the path says', () => {
    const TERMINAL = '/invoicing/cash-sales/new'
    const HOSTILE: Array<[string, string | null]> = [
      ['/pos//evil.example', null], // a dot in the last segment reads as a file: a plain 404
      ['/pos/orders//evil.example', null],
      ['/pos/orders/%2F%2Fevil.example', null],
      ['/pos/devices/%5Cevil.example', null],
      ['/pos//evil', TERMINAL],
      ['/pos/orders//evil', '/invoicing/cash-sales/evil/view'],
      ['/pos/orders/%2F%2Fevil', TERMINAL],
      ['/pos/devices/%5Cevil', TERMINAL],
      ['/pos/orders/a%0d%0aSet-Cookie:x=1', TERMINAL],
      ['/pos/orders/%0d%0aLocation:%20https:%2F%2Fevil', TERMINAL],
      ['/pos/orders/..%2F..%2Fapi', TERMINAL],
      ['/pos/orders/6a1b2c3d4e5f60718293a4b5/', '/invoicing/cash-sales/6a1b2c3d4e5f60718293a4b5/view'],
    ]
    for (const [path, expected] of HOSTILE) {
      const to = posRedirect(path)
      expect({ path, to }).toEqual({ path, to: expected })
      if (to) expect(to, path).toMatch(/^\/invoicing\/[a-z-]/)
    }
  })
})
