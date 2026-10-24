/**
 * FR-20.22 (plan step P1-10) — is the server's clock right, and may it set a fiscal device?
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { clockTrusted, forgetClockVerification, formatStep, lastClockVerification, verifyClock, TIME_SOURCES } from 'fiscal/clock'

afterEach(() => forgetClockVerification())

const DAY = 86_400_000

/** A fetch answering each source as `answers` says: a time in ms, or a failure. */
function fakeFetch(answers: Record<string, number | 'fail'>) {
  return (async (url: string) => {
    const name = TIME_SOURCES.find(s => s.url === url)!.name
    const a = answers[name]
    if (a === undefined || a === 'fail') throw Object.assign(new Error('connection reset'), { code: 'ECONNRESET' })
    if (name === 'cloudflare') return new Response(`fl=1\nts=${(a / 1000).toFixed(3)}\nip=1.2.3.4\n`)
    return new Response(null, { status: 204, headers: { date: new Date(a).toUTCString() } })
  }) as unknown as typeof fetch
}

/** A clock stand-in: the wall clock at `wall`, and a monotonic counter that the test moves. */
function clocks(wall: number) {
  let mono = 1_000_000
  return { now: () => wall + (mono - 1_000_000), mono: () => mono, advance: (ms: number) => { mono += ms } }
}

describe('verifyClock', () => {
  test('against Cloudflare, to the millisecond, read at the middle of the round trip', async () => {
    const real = Date.parse('2026-10-25T00:00:00Z')
    const c = clocks(real + 1500) // our clock is 1.5 s ahead
    const check = await verifyClock({ fetch: fakeFetch({ cloudflare: real }), now: c.now, mono: c.mono })
    expect(check.state).toBe('verified')
    if (check.state !== 'verified') return
    expect(check.source).toBe('cloudflare')
    expect(check.driftMs).toBe(1500)
    expect(check.precisionMs).toBeLessThanOrEqual(1)
  })

  test('falls to the next source, whose precision is a second', async () => {
    const real = Date.parse('2026-10-25T00:00:00Z')
    const c = clocks(real)
    const check = await verifyClock({ fetch: fakeFetch({ cloudflare: 'fail', google: real }), now: c.now, mono: c.mono })
    expect(check).toMatchObject({ state: 'verified', source: 'google', driftMs: 0 })
    if (check.state === 'verified') expect(check.precisionMs).toBeGreaterThanOrEqual(1000)
  })

  test('reaching nothing is UNKNOWN, never drift 0, and keeps no verification', async () => {
    const c = clocks(Date.now())
    const check = await verifyClock({ fetch: fakeFetch({}), now: c.now, mono: c.mono })
    expect(check.state).toBe('unknown')
    expect((check as any).driftMs).toBeUndefined()
    if (check.state === 'unknown') expect(check.reason).toContain('cloudflare: ECONNRESET')
    expect(lastClockVerification()).toBeUndefined()
  })
})

describe('clockTrusted', () => {
  test('never verified: no', () => {
    expect(clockTrusted()).toEqual({ ok: false, reason: 'the server clock has not been verified since it started' })
  })

  test('verified and close: yes, for 24 hours of monotonic time', async () => {
    const real = Date.parse('2026-10-25T00:00:00Z')
    const c = clocks(real + 800)
    await verifyClock({ fetch: fakeFetch({ cloudflare: real }), now: c.now, mono: c.mono })
    expect(clockTrusted({ now: c.now(), mono: c.mono() }).ok).toBe(true)
    c.advance(DAY - 1000)
    expect(clockTrusted({ now: c.now(), mono: c.mono() }).ok).toBe(true)
    c.advance(2000)
    expect(clockTrusted({ now: c.now(), mono: c.mono() })).toEqual({ ok: false, reason: 'the server clock has not been verified for over 24 hours' })
  })

  test('AC 58: a clock three days wrong, even verified as such, sets no device', async () => {
    const real = Date.parse('2026-10-25T00:00:00Z')
    const c = clocks(real + 3 * DAY)
    await verifyClock({ fetch: fakeFetch({ cloudflare: real }), now: c.now, mono: c.mono })
    const t = clockTrusted({ now: c.now(), mono: c.mono() })
    expect(t.ok).toBe(false)
    if (!t.ok) expect(t.reason).toBe('the server clock is off by +3 d 0 h (cloudflare)')
  })

  test('a wall clock set back after its verification is no longer trusted', async () => {
    const real = Date.parse('2026-10-25T00:00:00Z')
    const c = clocks(real)
    await verifyClock({ fetch: fakeFetch({ cloudflare: real }), now: c.now, mono: c.mono })
    c.advance(60_000)
    // A minute later on the monotonic clock, the wall clock reads three days earlier.
    const t = clockTrusted({ now: c.now() - 3 * DAY, mono: c.mono() })
    expect(t.ok).toBe(false)
    if (!t.ok) expect(t.reason).toBe('the server clock has moved by -3 d 0 h since it was verified')
  })
})

describe('formatStep', () => {
  test('for people', () => {
    expect(formatStep(800)).toBe('+800 ms')
    expect(formatStep(-125_000)).toBe('-2 min 5 s')
    expect(formatStep(3 * DAY + 3_600_000 + 5000)).toBe('+3 d 1 h')
    expect(formatStep(90_000)).toBe('+1 min 30 s')
  })
})
