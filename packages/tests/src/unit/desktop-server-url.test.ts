import { describe, it, expect } from 'bun:test'
import { normaliseServerUrl, isLoopbackHost } from '../../../desktop-ui/src/server-url'

/**
 * FR-14.11 — onboarding upgrades `http://` to `https://` **except for loopback**.
 *
 * ⚠ The exception is load-bearing in both directions. Without it a developer's
 * `http://localhost:4001` becomes an https URL nothing is listening on, and the shell cannot
 * talk to a dev hub at all. With it applied too loosely — anything *containing* "localhost" —
 * `http://localhost.evil.example` stays in clear on a real network, carrying a session cookie.
 */
describe('onboarding server address (FR-14.11)', () => {
  it('upgrades http to https on a real host', () => {
    expect(normaliseServerUrl('http://lgrai.app')).toEqual({ url: 'https://lgrai.app', upgraded: true })
  })

  it('leaves https alone', () => {
    expect(normaliseServerUrl('https://lgrai.app')).toEqual({ url: 'https://lgrai.app', upgraded: false })
  })

  it('assumes https for a bare host, because that is what people type', () => {
    expect(normaliseServerUrl('lgrai.app')).toEqual({ url: 'https://lgrai.app', upgraded: false })
  })

  for (const host of ['localhost', '127.0.0.1', '127.0.0.5', '[::1]']) {
    it(`leaves loopback ${host} on http`, () => {
      const got = normaliseServerUrl(`http://${host}:4001`)
      expect(got.upgraded).toBe(false)
      expect(got.url).toContain('http://')
      expect(got.url).not.toContain('https://')
    })
  }

  it('does NOT treat a host that merely contains "localhost" as loopback', () => {
    // ⚠ The whole point of deciding on the hostname rather than on the string.
    const got = normaliseServerUrl('http://localhost.evil.example')
    expect(got.upgraded).toBe(true)
    expect(got.url).toBe('https://localhost.evil.example')
  })

  it('does NOT treat 127.0.0.1.evil.example as loopback', () => {
    expect(isLoopbackHost('127.0.0.1.evil.example')).toBe(false)
    expect(normaliseServerUrl('http://127.0.0.1.evil.example').upgraded).toBe(true)
  })

  it('drops a port that only meant something under http', () => {
    // Keeping :80 turns a working address into a dead one, which reads as "my address is
    // wrong" rather than "the scheme changed".
    expect(normaliseServerUrl('http://lgrai.app:80')).toEqual({ url: 'https://lgrai.app', upgraded: true })
  })

  it('keeps a non-default port', () => {
    expect(normaliseServerUrl('http://hub.example:8443').url).toBe('https://hub.example:8443')
  })

  it('reduces to an origin, because the path comes from the assignment', () => {
    // FR-14.16: `startPath` is the desktop's assignment, never something pasted into setup.
    expect(normaliseServerUrl('https://lgrai.app/pos/?token=abc').url).toBe('https://lgrai.app')
  })

  it('refuses what is not a server address', () => {
    for (const bad of ['', '   ', 'file:///etc/passwd', 'lgr://enroll', 'javascript:alert(1)']) {
      expect(normaliseServerUrl(bad).url).toBeNull()
    }
  })
})
