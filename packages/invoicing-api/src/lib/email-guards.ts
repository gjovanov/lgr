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

import { canWrite } from './export-access.js'

/** Deliberately permissive — the real validation is the provider bouncing it. */
export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/

/** FR-10.6: a second identical send inside this window is treated as a double-click. */
export const RESEND_WINDOW_MS = 60_000

export function isValidRecipient(to: unknown): boolean {
  return EMAIL_RE.test(String(to ?? '').trim())
}

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
