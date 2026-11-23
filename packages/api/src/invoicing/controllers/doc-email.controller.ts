import { Elysia, t } from 'elysia'
import { AppAuthService } from '../auth/app-auth.service.js'
import { mayEmailKind, previewDocEmail, sendDocEmail } from '../lib/doc-email.js'
import { ColumnValidationError, normaliseColumns } from './invoice-export.controller.js'

/**
 * The ticked documents of a list, by e-mail (2026-11-16). Two routes beside the exports they print with:
 *
 *   POST /org/:orgId/invoicing/export/email/preview   { kind, ids }                → { documents: [...] }
 *   POST /org/:orgId/invoicing/export/email           { kind, to, items, … }       → { to, mails, queued, results }
 *
 * `kind` is `invoice` (any document of the invoice collection), `order` (a supplier order's sheets) or
 * `internal-order` (a customer order's sheet). The preview writes nothing; the mail is ONE recipient and at most ten
 * documents per request, and answers 200 with a row per document. Everything they decide is `lib/doc-email.ts`'s,
 * which a test calls without a server.
 *
 * ⚠ Not "send": `POST /invoices/:id/send` ISSUES a document. The single route, `POST export/:id/email`, stays as it
 * was (one outgoing document, its own statuses).
 *
 * ⚠ The sizes are checked in the handler, never as a schema's `maxItems`: a selection over the limit is
 * 422 `{ code: 'selection_too_large', max }`, which the dialog reads, and a schema refusal carries no code.
 */

const kind = t.Union([t.Literal('invoice'), t.Literal('order'), t.Literal('internal-order')])

export const docEmailController = new Elysia({ prefix: '/org/:orgId/invoicing/export' })
  .use(AppAuthService)
  .post(
    '/email/preview',
    async ({ params: { orgId }, body, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })
      const reply = await previewDocEmail({ orgId, user: user as any, kind: body.kind, ids: body.ids })
      return reply.status === 200 ? reply.body : status(reply.status, reply.body)
    },
    { isSignIn: true, body: t.Object({ kind, ids: t.Array(t.String()) }) },
  )
  .post(
    '/email',
    async ({ params: { orgId }, body, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })
      // Before the body's own faults: a session that may mail no document of the kind is told that, and nothing else.
      if (!mayEmailKind(body.kind, user as any)) return status(403, { message: 'Forbidden' })
      let columns: string[] | undefined
      try {
        // An invoice's printed line columns. A kind that prints none ignores them.
        columns = body.kind === 'invoice' ? normaliseColumns(body.columns) : undefined
      } catch (e: any) {
        if (!(e instanceof ColumnValidationError)) throw e
        return status(400, { message: e.message })
      }
      const reply = await sendDocEmail({
        orgId,
        user: user as any,
        kind: body.kind,
        to: body.to,
        items: body.items,
        subject: body.subject,
        message: body.message,
        locale: body.locale,
        columns,
      })
      return reply.status === 200 ? reply.body : status(reply.status, reply.body)
    },
    {
      isSignIn: true,
      body: t.Object({
        kind,
        to: t.String(),
        items: t.Array(t.Object({ id: t.String(), groupId: t.Optional(t.String()) })),
        subject: t.Optional(t.String()),
        message: t.Optional(t.String()),
        locale: t.Optional(t.String()),
        columns: t.Optional(t.Array(t.String())),
      }),
    },
  )
