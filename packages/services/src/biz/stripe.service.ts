import Stripe from 'stripe'
import { config, PLANS, type PlanId } from 'config'
import { Org } from 'db/models'

let _stripe: Stripe | null = null
function getStripe() {
  if (!_stripe) {
    if (!config.stripe.secretKey) throw new Error('STRIPE_SECRET_KEY is not configured')
    _stripe = new Stripe(config.stripe.secretKey)
  }
  return _stripe
}

/**
 * FR-32.4 (#797): where a webhook's payload says when the period ends and which subscription an
 * invoice is for. A webhook is sent in the ACCOUNT's (or the endpoint's) API version, not the SDK's.
 * From 2025-03-31 (basil) the period end is on each subscription item and an invoice names its
 * subscription under `parent.subscription_details`; before it, both were top-level fields. Both
 * shapes are read, the new one first, so the handler is right whichever version the account sends.
 */
type LegacySubscription = { current_period_end?: number | null }
type LegacyInvoice = { subscription?: string | { id: string } | null }

export function periodEndOf(sub: Stripe.Subscription): Date | null {
  const ends = (sub.items?.data ?? []).map(i => i.current_period_end).filter((n): n is number => typeof n === 'number')
  const end = ends.length ? Math.max(...ends) : (sub as unknown as LegacySubscription).current_period_end
  return typeof end === 'number' ? new Date(end * 1000) : null
}

export function subscriptionIdOf(invoice: Stripe.Invoice): string | null {
  const ref = invoice.parent?.subscription_details?.subscription ?? (invoice as unknown as LegacyInvoice).subscription
  if (!ref) return null
  return typeof ref === 'string' ? ref : ref.id
}

export const stripeService = {
  async createCheckoutSession(orgId: string, planId: PlanId, userEmail: string) {
    const org = await Org.findById(orgId)
    if (!org) throw new Error('Organization not found')

    let customerId = org.subscription?.stripeCustomerId
    if (!customerId) {
      const customer = await getStripe().customers.create({ email: userEmail, metadata: { orgId, orgSlug: org.slug } })
      customerId = customer.id
      await Org.findByIdAndUpdate(orgId, { 'subscription.stripeCustomerId': customerId })
    }

    const priceId = config.stripe.priceIds[planId as keyof typeof config.stripe.priceIds]
    if (!priceId) throw new Error('Invalid plan')

    const session = await getStripe().checkout.sessions.create({
      customer: customerId,
      mode: 'subscription',
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${config.oauth.frontendUrl}/settings/billing?success=true`,
      cancel_url: `${config.oauth.frontendUrl}/settings/billing?canceled=true`,
      metadata: { orgId, planId },
    })
    return { url: session.url }
  },

  async createPortalSession(orgId: string) {
    const org = await Org.findById(orgId)
    if (!org?.subscription?.stripeCustomerId) throw new Error('No billing account')
    const session = await getStripe().billingPortal.sessions.create({
      customer: org.subscription.stripeCustomerId,
      return_url: `${config.oauth.frontendUrl}/settings/billing`,
    })
    return { url: session.url }
  },

  async handleWebhook(payload: string, signature: string) {
    // Under Bun the SDK is its worker build (the `bun` export condition), which verifies on SubtleCrypto:
    // there the synchronous `constructEvent` throws on every event. The async form works everywhere.
    const event = await getStripe().webhooks.constructEventAsync(payload, signature, config.stripe.webhookSecret)
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object as Stripe.Checkout.Session
        const orgId = session.metadata?.orgId
        const planId = session.metadata?.planId
        if (orgId && planId) {
          await Org.findByIdAndUpdate(orgId, {
            'subscription.plan': planId,
            'subscription.stripeSubscriptionId': session.subscription as string,
            'subscription.status': 'active',
            'subscription.cancelAtPeriodEnd': false,
          })
        }
        break
      }
      case 'customer.subscription.updated': {
        const sub = event.data.object as Stripe.Subscription
        const org = await Org.findOne({ 'subscription.stripeCustomerId': sub.customer as string })
        if (org) {
          const periodEnd = periodEndOf(sub)
          await Org.findByIdAndUpdate(org._id, {
            'subscription.status': sub.status,
            ...(periodEnd ? { 'subscription.currentPeriodEnd': periodEnd } : {}),
            'subscription.cancelAtPeriodEnd': sub.cancel_at_period_end,
          })
        }
        break
      }
      case 'customer.subscription.deleted': {
        const sub = event.data.object as Stripe.Subscription
        const org = await Org.findOne({ 'subscription.stripeCustomerId': sub.customer as string })
        if (org) {
          await Org.findByIdAndUpdate(org._id, {
            'subscription.plan': 'free',
            'subscription.status': 'canceled',
            'subscription.stripeSubscriptionId': null,
          })
        }
        break
      }
      case 'invoice.payment_failed': {
        const invoice = event.data.object as Stripe.Invoice
        const subId = subscriptionIdOf(invoice)
        if (subId) {
          const org = await Org.findOne({ 'subscription.stripeSubscriptionId': subId })
          if (org) {
            await Org.findByIdAndUpdate(org._id, { 'subscription.status': 'past_due' })
          }
        }
        break
      }
    }
    return { received: true }
  },

  getPlans() {
    return Object.values(PLANS).map(p => ({ id: p.id, name: p.name, price: p.price, limits: p.limits }))
  },
}
