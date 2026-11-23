import { Elysia, t } from 'elysia'
import { AppAuthService } from '../auth/app-auth.service.js'
import { emailMovements, previewMovementEmail } from '../lib/movement-email.js'

/**
 * The movements list's ticked movements, by e-mail (2026-11-16): `config/doc-email`'s two endpoints for the kind
 * `movement`, as `api/src/invoicing/controllers/doc-email.controller.ts` has them for invoices and supplier orders.
 *
 * ⚠ Neither is named "send": `POST /invoices/:id/send` ISSUES a document.
 *
 * ⚠ Both are reached by the rule of every write under `warehouse/movement` (the work on movements, or a Seller's
 * transfers), in both route tables, so a role that mails no movement has its 403 from the auth plugin before the
 * body is validated. Which movement goes is `lib/movement-email-guards.ts`'s.
 *
 * ⚠ The preview is a POST that reads, and is deliberately NOT in `route-class.ts#READ_ONLY_WRITES`: it prepares a
 * mail an org away from its home could not send, so it answers 409 there with the mail request.
 *
 * ⚠ Mounted beside `movementController`, whose `POST /:id/confirm` shares the prefix: `email` is a fixed segment and
 * the router takes it before a parameter, which `movement-email.flow.test.ts` asserts over the real route table.
 *
 * The sizes are checked in the handlers, never as `maxItems`: a 422 from the schema would not carry
 * `selection_too_large` and the route's own `max`.
 */
const kind = t.Literal('movement')

export const movementEmailController = new Elysia({ prefix: '/org/:orgId/warehouse/movement' })
  .use(AppAuthService)
  .post(
    '/email/preview',
    async ({ params: { orgId }, body, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })
      const reply = await previewMovementEmail({ orgId, user: user as any, ids: body.ids })
      return reply.status === 200 ? reply.body : status(reply.status, reply.body)
    },
    { isSignIn: true, body: t.Object({ kind, ids: t.Array(t.String()) }) },
  )
  .post(
    '/email',
    async ({ params: { orgId }, body, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })
      const reply = await emailMovements({
        orgId,
        user: user as any,
        to: body.to,
        items: body.items,
        subject: body.subject,
        message: body.message,
        locale: body.locale,
      })
      return reply.status === 200 ? reply.body : status(reply.status, reply.body)
    },
    {
      isSignIn: true,
      body: t.Object({
        kind,
        to: t.String(),
        items: t.Array(t.Object({ id: t.String() })),
        subject: t.Optional(t.String()),
        message: t.Optional(t.String()),
        locale: t.Optional(t.String()),
      }),
    },
  )
