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
    const event = getStripe().webhooks.constructEvent(payload, signature, config.stripe.webhookSecret)
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
          await Org.findByIdAndUpdate(org._id, {
            'subscription.status': sub.status,
            'subscription.currentPeriodEnd': new Date(sub.current_period_end * 1000),
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
        const subId = typeof invoice.subscription === 'string' ? invoice.subscription : invoice.subscription?.id
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
