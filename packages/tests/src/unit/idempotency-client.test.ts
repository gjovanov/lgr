import { describe, it, expect } from 'bun:test'
import { createIdempotentAction, isOutcomeUnknown } from 'ui-shared/composables/idempotency'

/**
 * The client half of #155: when a POS screen reuses its `Idempotency-Key`, and when it starts
 * a new attempt. Reusing it wrongly sends a new sale as a replay (the server answers 422 or
 * returns the old sale); dropping it wrongly lets a retry ring the basket up twice.
 */

const body = { type: 'sale', total: 24 }
const key = (a: ReturnType<typeof createIdempotentAction>, b: unknown = body) => a.headers(b)['Idempotency-Key']
const err = (status?: number, data?: unknown) => (status === undefined ? { message: 'Network Error' } : { response: { status, data } })

describe('Idempotency-Key on the client', () => {
  it('keeps the key while the outcome is unknown: no answer, a proxy timeout, still in progress', () => {
    for (const e of [err(), err(408), err(502), err(504), err(409, { code: 'idempotency_in_progress' })]) {
      const a = createIdempotentAction()
      const first = key(a)
      a.settle(e)
      expect(key(a)).toBe(first)
      expect(isOutcomeUnknown(e)).toBe(true)
    }
  })

  it('starts a new attempt after a definitive answer: success or the server\'s own refusal', () => {
    for (const e of [undefined, err(400, { message: 'Session is closed' }), err(503, { code: 'fiscal_error' }), err(409, { code: 'storno_in_progress' }), err(422)]) {
      const a = createIdempotentAction()
      const first = key(a)
      a.settle(e)
      expect(key(a)).not.toBe(first)
    }
  })

  it('a different body is a new attempt, even mid-retry — an edited cart is not a replay', () => {
    const a = createIdempotentAction()
    const first = key(a)
    a.settle(err())
    expect(key(a, { ...body, total: 36 })).not.toBe(first)
  })

  it('keys are long, random and accepted by the server\'s pattern', () => {
    const seen = new Set<string>()
    for (let i = 0; i < 100; i++) seen.add(key(createIdempotentAction()))
    expect(seen.size).toBe(100)
    for (const k of seen) expect(k).toMatch(/^[A-Za-z0-9._:-]{8,128}$/)
  })
})
