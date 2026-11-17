import { describe, it, expect } from 'bun:test'
import type Stripe from 'stripe'
import { periodEndOf, subscriptionIdOf } from 'services/biz/stripe.service'

/**
 * FR-32.4 (#797): the two Stripe fields the type-check found. A webhook comes in the account's
 * API version, not the SDK's: from 2025-03-31 the period end is on the subscription's items and an
 * invoice names its subscription under `parent.subscription_details`. Both shapes are read.
 */
const at = (iso: string) => Math.floor(Date.parse(iso) / 1000)

describe('periodEndOf', () => {
  it('reads the items (2025-03-31 and later), the latest of them', () => {
    const sub = { items: { data: [{ current_period_end: at('2026-12-01T00:00:00Z') }, { current_period_end: at('2027-01-01T00:00:00Z') }] } }
    expect(periodEndOf(sub as unknown as Stripe.Subscription)?.toISOString()).toBe('2027-01-01T00:00:00.000Z')
  })

  it('reads the top-level field of an older version', () => {
    const sub = { current_period_end: at('2026-12-01T00:00:00Z'), items: { data: [{}] } }
    expect(periodEndOf(sub as unknown as Stripe.Subscription)?.toISOString()).toBe('2026-12-01T00:00:00.000Z')
  })

  it('is null when the payload carries neither, and the period end is then left as stored', () => {
    expect(periodEndOf({ items: { data: [] } } as unknown as Stripe.Subscription)).toBeNull()
  })
})

describe('subscriptionIdOf', () => {
  it('reads parent.subscription_details (2025-03-31 and later), as an id or an expanded object', () => {
    expect(subscriptionIdOf({ parent: { subscription_details: { subscription: 'sub_new' } } } as unknown as Stripe.Invoice)).toBe('sub_new')
    expect(subscriptionIdOf({ parent: { subscription_details: { subscription: { id: 'sub_obj' } } } } as unknown as Stripe.Invoice)).toBe('sub_obj')
  })

  it('reads the top-level field of an older version', () => {
    expect(subscriptionIdOf({ subscription: 'sub_old' } as unknown as Stripe.Invoice)).toBe('sub_old')
    expect(subscriptionIdOf({ subscription: { id: 'sub_old_obj' }, parent: null } as unknown as Stripe.Invoice)).toBe('sub_old_obj')
  })

  it('is null for an invoice of no subscription', () => {
    expect(subscriptionIdOf({ parent: null } as unknown as Stripe.Invoice)).toBeNull()
  })
})
