import { createHash } from 'node:crypto'
import type { Model } from 'mongoose'

/**
 * Idempotency for the hot path (FR-20.37, #155).
 *
 * A client sends one `Idempotency-Key` per attempt and reuses it on a retry: a timeout at the
 * till, a proxy's 504, a double click. The key lives ON THE DOCUMENT the request creates
 * (`clientKey`, unique per org), never in a side table, so "was this done?" and "what was done"
 * are one read and cannot disagree.
 *
 * - **Same key, same body** → the first outcome, finishing any step a crash interrupted.
 * - **Same key, different body** → 422. A key names one request; reusing it for another is a
 *   client bug, and acting on it would hand back somebody else's receipt.
 * - **No key** → today's behaviour. That is the kill switch: a client stops sending it.
 */

/** Printable, bounded: a UUID fits, a request body pasted by mistake does not. */
const KEY_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/

export class IdempotencyError extends Error {
  constructor(public statusCode: number, public code: string, message: string) {
    super(message)
    this.name = 'IdempotencyError'
  }
}

/**
 * The request's key, if it sent one. A malformed key is refused rather than ignored: a client
 * that believes it is protected must not silently run unprotected.
 */
export function readIdempotencyKey(headers: Record<string, string | undefined>): string | undefined {
  const raw = headers['idempotency-key']
  if (raw === undefined || raw === '') return undefined
  if (!KEY_PATTERN.test(raw)) {
    throw new IdempotencyError(400, 'idempotency_key_invalid', 'Idempotency-Key must be 8–128 characters of A–Z a–z 0–9 . _ : -')
  }
  return raw
}

/** JSON with object keys sorted at every depth, so two equal bodies always hash the same. */
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`).join(',')}}`
  }
  return JSON.stringify(value ?? null)
}

/**
 * What a retry must repeat exactly. `scope` folds in what the URL names (the session, the
 * operation), so one key reused on another route is a different request, not a replay.
 */
export function requestHash(scope: string, body: unknown): string {
  return createHash('sha256').update(scope).update('\0').update(stable(body)).digest('hex')
}

/** Throws 422 when a stored request does not match this one. */
export function assertSameRequest(stored: string | undefined, hash: string): void {
  if (stored !== hash) {
    throw new IdempotencyError(422, 'idempotency_key_reused', 'This Idempotency-Key was already used for a different request')
  }
}

/** MongoDB's duplicate-key error on the `{orgId, clientKey}` index. */
export function isDuplicateKey(err: unknown): boolean {
  const e = err as { code?: number; keyPattern?: Record<string, unknown>; message?: string }
  return e?.code === 11000 && (!e.keyPattern || 'clientKey' in e.keyPattern || /clientKey/.test(e.message ?? ''))
}

/**
 * How long one request may hold a keyed document. Generous: a fiscal device on a slow serial
 * line takes seconds per receipt, and a lease that lapsed mid-print would let a waiter resume
 * and print again. A crashed holder is resumed only after this has passed.
 */
export const LEASE_MS = 120_000

/**
 * Take the lease on a keyed document that is not finished. Returns the document when this
 * caller now holds it, null when someone else does.
 */
export async function takeLease(model: Model<any>, orgId: string, id: unknown): Promise<any | null> {
  const now = new Date()
  return model.findOneAndUpdate(
    {
      _id: id,
      orgId,
      completedAt: { $exists: false },
      $or: [{ leaseUntil: { $exists: false } }, { leaseUntil: null }, { leaseUntil: { $lt: now } }],
    },
    { $set: { leaseUntil: new Date(now.getTime() + LEASE_MS) } },
    { new: true },
  ).lean().exec()
}

/**
 * Keep a lease for as long as the work under it runs, renewed at once and then every `everyMs`.
 * Returns what stops it. A print queued behind a Z takes minutes, and a lease set once at the insert
 * lapses under it: a lapsed lease reads as a dead request, and what finishes a dead request would
 * then finish a live one. A process that dies stops renewing, which is what a lease is for.
 */
export function keepLease(model: Model<any>, id: unknown, everyMs = LEASE_MS / 3): () => void {
  const renew = () => {
    model.updateOne(
      { _id: id, completedAt: { $exists: false }, leaseUntil: { $exists: true } },
      { $set: { leaseUntil: new Date(Date.now() + LEASE_MS) } },
    ).exec().catch(() => { /* the next one, or the lease lapses, which is the safe way round */ })
  }
  renew()
  const timer = setInterval(renew, everyMs)
  timer.unref?.()
  return () => clearInterval(timer)
}

/** How long a duplicate waits for the request doing the work before answering 409. */
export const WAIT_MS = 30_000

/**
 * Wait for another request to finish a keyed document. Returns it once `completedAt` is set,
 * or null if the holder is still busy after `WAIT_MS` (the client retries later with the same
 * key) or its lease lapsed (the caller may take over).
 */
export async function waitForCompletion(
  model: Model<any>,
  orgId: string,
  id: unknown,
  { waitMs = WAIT_MS, pollMs = 150 }: { waitMs?: number; pollMs?: number } = {},
): Promise<{ doc: any | null; leaseLapsed: boolean }> {
  const deadline = Date.now() + waitMs
  for (;;) {
    const doc = await model.findOne({ _id: id, orgId }).lean().exec() as any
    if (!doc) return { doc: null, leaseLapsed: false }
    if (doc.completedAt) return { doc, leaseLapsed: false }
    if (!doc.leaseUntil || new Date(doc.leaseUntil).getTime() < Date.now()) return { doc, leaseLapsed: true }
    if (Date.now() >= deadline) return { doc: null, leaseLapsed: false }
    await new Promise(r => setTimeout(r, pollMs))
  }
}
