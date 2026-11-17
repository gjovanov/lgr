import { readIdempotencyKey } from './hot-path-key.js'

/**
 * FR-29.13 (§2.4): a request id on three creates — a supplier order, a customer order and a stock movement.
 *
 * The form sends its `Idempotency-Key` (`createIdempotentAction()`: one per attempt, kept while the outcome is
 * unknown), and the create stores it on the document it makes: `createdFrom.requestId` (source `form`) on an order,
 * `requestId` on a movement, each under a partial unique index on `{ orgId, … }`. So "was this done?" and "what was
 * done" are one read, as for the invoices' `clientKey` (`hot-path-key.ts`).
 *
 * - The same id twice makes one document, and the second request is answered with the first one's document.
 * - An id is the org's: the same id in another organization is another request.
 * - No id: the create behaves as it always did. The importers and the skills send none.
 *
 * Unlike an invoice's key, no hash of the body is kept: a repeated id is answered with the document it made,
 * whatever the second body says. The forms' key changes with the body (`createIdempotentAction`), so a form never
 * sends one id for two different documents.
 */

/** The request's id, or undefined. A malformed one is refused (400 `idempotency_key_invalid`), never ignored. */
export function readCreateRequestId(headers: Record<string, string | undefined>): string | undefined {
  return readIdempotencyKey(headers)
}

/**
 * Whether a write was refused because another document carries this request id: the driver's duplicate key on
 * `requestId` / `createdFrom.requestId`, or the DAL's `DuplicateError` naming that field.
 */
export function isRequestIdTaken(e: unknown): boolean {
  const err = e as { code?: unknown; fields?: unknown; keyPattern?: unknown; message?: unknown } | null | undefined
  if (err?.code === 'DUPLICATE') {
    const fields = err.fields && typeof err.fields === 'object' ? Object.keys(err.fields) : []
    return fields.some(f => f === 'requestId' || f === 'createdFrom.requestId')
  }
  if (err?.code !== 11000 && err?.code !== 11001) return false
  const pattern = err.keyPattern && typeof err.keyPattern === 'object' ? Object.keys(err.keyPattern) : []
  if (pattern.length) return pattern.some(f => f === 'requestId' || f === 'createdFrom.requestId')
  return /requestId/.test(String(err.message ?? ''))
}
