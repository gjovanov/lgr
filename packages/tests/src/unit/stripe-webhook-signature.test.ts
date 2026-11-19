import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createHmac } from 'node:crypto'
import { config } from 'config'
import { stripeService } from 'services/biz/stripe.service'
import { captureRejection } from '../helpers/capture-rejection'

/**
 * A webhook is verified by the Stripe SDK build the RUNTIME loads, and under Bun that is the worker
 * build: stripe's package.json maps the `bun` export condition to it. Its signature check runs on
 * SubtleCrypto, which has no synchronous form, so `constructEvent` threw on every event ("cannot be
 * used in a synchronous context") and the route answered 400 to all of them, signed or not.
 *
 * These go through the real SDK, signed the way Stripe signs (`t=<ts>,v1=<HMAC-SHA256 of "t.payload">`),
 * with an event type the handler does not act on, so nothing touches the database.
 */
const SECRET = 'whsec_unit_signature_test'
const saved = { secretKey: config.stripe.secretKey, webhookSecret: config.stripe.webhookSecret }

beforeAll(() => {
  config.stripe.secretKey = 'sk_test_unit_signature_test'
  config.stripe.webhookSecret = SECRET
})
afterAll(() => {
  config.stripe.secretKey = saved.secretKey
  config.stripe.webhookSecret = saved.webhookSecret
})

const now = () => Math.floor(Date.now() / 1000)

function sign(payload: string, secret = SECRET, t = now()): string {
  return `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${payload}`).digest('hex')}`
}

const payload = JSON.stringify({
  id: 'evt_unit_signature',
  object: 'event',
  api_version: '2025-03-31.basil',
  created: now(),
  type: 'customer.created',
  data: { object: { id: 'cus_unit_signature', object: 'customer' } },
})

describe('a Stripe webhook', () => {
  test('signed as Stripe signs it, is accepted', async () => {
    expect(await stripeService.handleWebhook(payload, sign(payload))).toEqual({ received: true })
  })

  test('signed with another secret, is refused for its signature', async () => {
    const err = await captureRejection(stripeService.handleWebhook(payload, sign(payload, 'whsec_someone_else')))
    expect(err).toBeTruthy()
    expect(String(err?.message)).toContain('No signatures found matching the expected signature')
  })

  test('altered after it was signed, is refused for its signature', async () => {
    const err = await captureRejection(stripeService.handleWebhook(payload.replace('cus_unit', 'cus_other'), sign(payload)))
    expect(err).toBeTruthy()
    expect(String(err?.message)).toContain('No signatures found matching the expected signature')
  })

  test('signed longer ago than the tolerance, is refused for its age', async () => {
    const err = await captureRejection(stripeService.handleWebhook(payload, sign(payload, SECRET, now() - 3600)))
    expect(err).toBeTruthy()
    expect(String(err?.message)).toContain('Timestamp outside the tolerance zone')
  })

  // Left to the SDK, an unset secret is refused as "Zero-length key is not supported", which names
  // neither the setting nor the fix.
  test('with no webhook secret configured, is refused saying which setting is missing', async () => {
    config.stripe.webhookSecret = ''
    try {
      const err = await captureRejection(stripeService.handleWebhook(payload, sign(payload)))
      expect(err).toBeTruthy()
      expect(String(err?.message)).toBe('STRIPE_WEBHOOK_SECRET is not configured')
    } finally {
      config.stripe.webhookSecret = SECRET
    }
  })
})
