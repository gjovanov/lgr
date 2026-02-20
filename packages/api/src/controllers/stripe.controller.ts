import { Elysia, t } from 'elysia'
import { AuthService } from '../auth/auth.service.js'
import { stripeService } from 'services/biz/stripe.service'

export const stripeController = new Elysia({ prefix: '/stripe' })
  .use(AuthService)
  .get('/plans', async () => {
    return { plans: stripeService.getPlans() }
  })
  .post('/checkout', async ({ body, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    if (user.role !== 'admin') return status(403, { message: 'Admin only' })
    const result = await stripeService.createCheckoutSession(user.orgId, body.planId, user.email)
    return result
  }, {
    isSignIn: true,
    body: t.Object({ planId: t.String() }),
  })
  .post('/portal', async ({ user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    if (user.role !== 'admin') return status(403, { message: 'Admin only' })
    const result = await stripeService.createPortalSession(user.orgId)
    return result
  }, {
    isSignIn: true,
  })
  .post('/webhook', async ({ request, status }) => {
    const signature = request.headers.get('stripe-signature')
    if (!signature) return status(400, { message: 'Missing signature' })
    const payload = await request.text()
    try {
      return await stripeService.handleWebhook(payload, signature)
    } catch (e: any) {
      return status(400, { message: e.message })
    }
  })
