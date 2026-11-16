/**
 * FR-10 (#19) — the gates on "email this document", as pure functions.
 *
 * They live outside the controller for one reason: they are the part of the feature the
 * acceptance criteria are written about ("read-only user 403", "drafts blocked", "a double
 * click does not send twice"), and Elysia's `handle()` does not route under `bun test` in
 * this repo — a bare `new Elysia().get('/x')` answers NOT_FOUND — so an HTTP-level test of
 * the endpoint is not available. Pure functions are testable without a server, and the
 * controller keeps exactly one expression per gate.
 *
 * Order matters and is asserted by the tests: recipient → existence → direction → status →
 * duplicate. It mirrors what the endpoint did before the extraction, byte for byte.
 */

import { DOC_KINDS, can as grantCan, kindOfDocument, readsKind, writesKind, type Grant } from 'config/access'
import { isValidRecipient, type DocEmailSkip } from 'config/doc-email'
import { grantOf, type AccessCaller } from 'services/biz/access/evaluate'
import { canExport, canWrite } from './export-access.js'

// The recipient pattern is `config/doc-email`'s since the batch dialog reads it too; it is still exported from here.
// So is the double-click window (FR-10.6), which every kind of mailed document reads.
export { EMAIL_RE, RESEND_WINDOW_MS, isValidRecipient } from 'config/doc-email'

export interface EmailBlock {
  status: 400 | 403 | 404 | 422 | 429
  message: string
}

type MaybeUser = { permissions?: string[]; role?: string } | null | undefined
type EmailableDoc = { direction?: string; status?: string } | null | undefined

/**
 * `null` means "go ahead". Everything else is the status + message the endpoint returns.
 *
 * `recentSend` is the caller's answer to "has this exact document gone to this exact address
 * in the last minute, successfully?" — a FAILED previous attempt is deliberately not a
 * block: the failure is precisely why the user is clicking again.
 */
export function emailRequestBlock(input: {
  user: MaybeUser
  to: unknown
  /** `null` when the document does not exist in this org. */
  invoice: EmailableDoc
  recentSend?: boolean
}): EmailBlock | null {
  // Emailing a customer is an outward business action, not a read: the read-only roles
  // (member, nra_auditor) may print but must not send on the org's behalf.
  if (!canWrite(input.user)) {
    return { status: 403, message: 'Forbidden' }
  }
  if (!isValidRecipient(input.to)) {
    return { status: 400, message: 'A valid recipient email is required' }
  }
  if (!input.invoice) {
    return { status: 404, message: 'Document not found' }
  }
  if (input.invoice.direction !== 'outgoing') {
    return { status: 422, message: 'Only outgoing documents can be emailed' }
  }
  // A draft number ("DRF-INV-…") in a customer's inbox is worse than no email at all.
  if (input.invoice.status === 'draft') {
    return { status: 422, message: 'Issue the document before emailing it' }
  }
  if (input.recentSend) {
    return { status: 429, message: 'This document was just emailed to that address. Try again in a minute.' }
  }
  return null
}

// ── Several documents in one request (2026-11-16): `POST invoicing/export/email` and its preview ──────────────────
//
// One document is one ROW of the answer, never the request's status: a draft among ten ticked invoices is skipped
// and the other nine go. So each rule answers a reason (`config/doc-email#DocEmailSkip`) or null, and the SAME
// function decides the preview and the mail request, which therefore cannot disagree. `just_sent` is the one reason
// only the request can give: it needs the address.
//
// ⚠ Wider than the single route above on purpose: an INCOMING document (a supplier's bill, forwarded to a colleague
// or the accountant) goes. And held to the caller's kinds (FR-27.6), which the single route is not.

type EmailableInvoice = { direction?: string | null; type?: string | null; status?: string | null } | null | undefined

/** May this session e-mail ANY document of the invoice collection: it works on one of its three kinds. The request's 403. */
export function mayEmailInvoices(grant: Grant | null | undefined): boolean {
  return DOC_KINDS.some(kind => writesKind(grant, kind, 'edit'))
}

/**
 * Why ONE document of the invoice collection does not go, or null when it does.
 *
 * Order, asserted by the tests: not in this org, or of a kind the caller does not READ (one answer for both, so a
 * role learns nothing about a kind it does not read) → of a kind it reads but does not WRITE → a draft → the
 * double-click window.
 */
export function invoiceEmailSkip(input: {
  grant: Grant | null | undefined
  /** `null` when the id names no document of this org. */
  invoice: EmailableInvoice
  recentSend?: boolean
}): DocEmailSkip | null {
  if (!input.invoice) return 'not_found'
  const kind = kindOfDocument(input.invoice)
  if (!readsKind(input.grant, kind)) return 'not_found'
  // Mailing a partner is an outward act on the org's behalf, not a read: it takes the kind's work.
  if (!writesKind(input.grant, kind, 'edit')) return 'forbidden'
  // A draft number ("DRF-INV-…") in a customer's inbox is worse than no email at all.
  if (input.invoice.status === 'draft') return 'draft'
  if (input.recentSend) return 'just_sent'
  return null
}

/** What mailing a supplier order's sheet takes: what its export route asks, and the work on orders that mailing is. */
export interface OrderEmailAccess {
  /** The orders' reads: what reaches `GET invoicing/orders/:id/export` at all (its route rule, and FR-26's area). */
  reads: boolean
  /** `canExport`, which that route asks itself. */
  exports: boolean
  /** `orders.create` or `orders.edit`: a read-only role prints a sheet and mails none. */
  writes: boolean
}

export function orderEmailAccess(user: AccessCaller | null | undefined): OrderEmailAccess {
  const grant = user ? grantOf(user) : null
  return {
    reads: grantCan(grant, ['orders.view', 'orders.browse', 'orders.lookup']),
    exports: canExport(user),
    writes: grantCan(grant, ['orders.create', 'orders.edit']),
  }
}

/** The request's 403: the answer is the same for every order, so a caller who may mail none is told once. */
export function mayEmailOrders(access: OrderEmailAccess): boolean {
  return access.reads && access.exports && access.writes
}

/**
 * Why ONE supplier-order sheet (an order's supplier group) does not go, or null when it does.
 *
 * Order: a caller the sheet's export would answer 403, or who does not work on orders (`forbidden`, before
 * anything about the order is said) → no such order or group in this org → a draft → the double-click window.
 */
export function orderEmailSkip(input: {
  access: OrderEmailAccess
  /** `null` when the id names no order of this org. */
  order: { status?: string | null } | null | undefined
  /** The order's supplier group the item names; falsy when it names none of this order. */
  group: unknown
  recentSend?: boolean
}): DocEmailSkip | null {
  if (!mayEmailOrders(input.access)) return 'forbidden'
  if (!input.order || !input.group) return 'not_found'
  if (input.order.status === 'draft') return 'draft'
  if (input.recentSend) return 'just_sent'
  return null
}
