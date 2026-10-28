import { describe, it, expect } from 'bun:test'
import { isSameSiteRequest, isOtherOriginOfSameSite, sessionCookieValue, SESSION_COOKIE } from 'services/biz/session-token'

/**
 * FR-20.72 (plan step P0a-8): a request from a sibling subdomain of lgrai.app (an org's address,
 * `<org slug>.lgrai.app`) never authenticates by cookie. The integration side, through the real
 * auth plugins, is `integration/auth-precedence.flow.test.ts`; this pins the string rules.
 */

const APP = 'https://lgrai.app'

describe('isOtherOriginOfSameSite', () => {
  it('a subdomain of the app, at any depth, is another origin of its site', () => {
    expect(isOtherOriginOfSameSite('https://acme.lgrai.app', APP)).toBe(true)
    expect(isOtherOriginOfSameSite('https://a.b.lgrai.app', APP)).toBe(true)
  })

  it('so is the app host on another scheme or port', () => {
    expect(isOtherOriginOfSameSite('http://lgrai.app', APP)).toBe(true)
    expect(isOtherOriginOfSameSite('https://lgrai.app:8443', APP)).toBe(true)
  })

  it("the app's own origin is not", () => {
    expect(isOtherOriginOfSameSite('https://lgrai.app', APP)).toBe(false)
    expect(isOtherOriginOfSameSite('https://LGRAI.app', APP)).toBe(false)
  })

  it('a host that only ends in the same letters is another site', () => {
    expect(isOtherOriginOfSameSite('https://notlgrai.app', APP)).toBe(false)
    expect(isOtherOriginOfSameSite('https://lgrai.app.evil.example', APP)).toBe(false)
    expect(isOtherOriginOfSameSite('https://evil.example', APP)).toBe(false)
  })

  it('an opaque or unparseable origin is not judged a sibling', () => {
    expect(isOtherOriginOfSameSite('null', APP)).toBe(false)
    expect(isOtherOriginOfSameSite('', APP)).toBe(false)
    expect(isOtherOriginOfSameSite('https://acme.lgrai.app', 'not a url')).toBe(false)
  })
})

describe('isSameSiteRequest', () => {
  it('Sec-Fetch-Site decides when the browser sends it', () => {
    expect(isSameSiteRequest({ 'sec-fetch-site': 'same-site' }, APP)).toBe(true)
    expect(isSameSiteRequest({ 'sec-fetch-site': ' Same-Site ' }, APP)).toBe(true)
    for (const site of ['same-origin', 'cross-site', 'none']) {
      expect(isSameSiteRequest({ 'sec-fetch-site': site, origin: 'https://acme.lgrai.app' }, APP)).toBe(false)
    }
  })

  it('without it, Origin decides', () => {
    expect(isSameSiteRequest({ origin: 'https://acme.lgrai.app' }, APP)).toBe(true)
    expect(isSameSiteRequest({ origin: APP }, APP)).toBe(false)
    expect(isSameSiteRequest({ origin: 'https://evil.example' }, APP)).toBe(false)
  })

  it('a client that sends neither (a script) is unaffected', () => {
    expect(isSameSiteRequest({}, APP)).toBe(false)
    expect(isSameSiteRequest(undefined, APP)).toBe(false)
  })
})

describe('sessionCookieValue', () => {
  const jar = { [SESSION_COOKIE]: { value: 'host-token' }, auth: { value: 'planted-token' } }

  it('reads __Host-auth, and never the plain name a subdomain can plant', () => {
    expect(SESSION_COOKIE).toBe('__Host-auth')
    expect(sessionCookieValue(jar, {})).toBe('host-token')
    expect(sessionCookieValue({ auth: { value: 'planted-token' } }, {})).toBeUndefined()
  })

  it('presents nothing on a same-site request', () => {
    expect(sessionCookieValue(jar, { 'sec-fetch-site': 'same-site' })).toBeUndefined()
  })
})
