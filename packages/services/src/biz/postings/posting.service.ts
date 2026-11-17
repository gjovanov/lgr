/**
 * Postings that are neither lost nor doubled (FR-29 slice D, §2.5).
 *
 * 1. **Owed, in the state change's transaction** (FR-29.15): `enqueuePosting(orgId, posting, { session })` writes the
 *    job beside the issue, the payment, the close or the booking that owes it. An org that does not post owes nothing.
 * 2. **Tried at once** (FR-29.16): the route still emits its event after the commit, and the handler runs the job
 *    (`settlePosting`), so the entry appears as fast as it always did.
 * 3. **Retried**: the `postings` scheduler drains what is still queued, with a growing delay, on every pod. A lease
 *    keeps two pods off one job at the same moment, and the key on the entry (`JournalEntry.postingKey`) keeps one entry
 *    per posting whatever happens. After `POSTING_MAX_ATTEMPTS` failures a job is `failed`, and stays visible until an
 *    accountant asks for it again (`retryPosting`).
 */
import type { ClientSession } from 'mongoose'
import { randomBytes } from 'node:crypto'
import { PostingJob, type IPostingJob } from 'db/models'
import { homeScope } from 'db/home/home'
import { logger } from '../../logger/logger.js'
import { postingKeyOf, postingSettingsOf, postsEvent, type OwedPosting } from './posting-rules.js'
import { postInvoiceJournal, postMovementValuation, postPaymentJournal, postPosSessionJournal } from './post-entries.js'

/** How many times a job is tried before it is `failed` and waits for a person. */
export const POSTING_MAX_ATTEMPTS = 8
/** How long one run holds a job. A posting is a few writes: this is a crash's bound, not a run's. */
export const POSTING_LEASE_MS = 2 * 60_000
/** The first retry's delay; each further one doubles it, up to `POSTING_MAX_DELAY_MS`. */
export const POSTING_FIRST_DELAY_MS = 30_000
export const POSTING_MAX_DELAY_MS = 6 * 3600_000

/** The delay before the next try, after `attempts` failures. */
export function postingRetryDelay(attempts: number): number {
  return Math.min(POSTING_MAX_DELAY_MS, POSTING_FIRST_DELAY_MS * 2 ** Math.max(0, attempts - 1))
}

/**
 * Write the job that says this posting is owed, in the caller's transaction when it passes one. Nothing when the org
 * does not post this event; nothing new when the job is there already. Answers the key, or null when nothing is owed.
 */
export async function enqueuePosting(orgId: string, posting: OwedPosting, opts: { session?: ClientSession } = {}): Promise<string | null> {
  if (!postsEvent(await postingSettingsOf(orgId), posting)) return null
  const postingKey = postingKeyOf(posting)
  const refs: Record<string, unknown> = { event: posting.event, ...(posting.userId ? { userId: posting.userId } : {}) }
  if (posting.event === 'invoice.posted') refs.invoiceId = posting.invoiceId
  if (posting.event === 'payment.recorded') {
    refs.invoiceId = posting.invoiceId
    if (posting.paymentId) refs.paymentId = posting.paymentId
    else if (posting.receiptId) refs.receiptId = posting.receiptId
  }
  if (posting.event === 'stock.movement.confirmed') refs.movementId = posting.movementId
  if (posting.event === 'pos.session.closed') refs.sessionId = posting.sessionId
  await PostingJob.updateOne(
    { orgId, postingKey },
    { $setOnInsert: { ...refs, state: 'queued', attempts: 0, nextAttemptAt: new Date() } },
    { upsert: true, ...(opts.session ? { session: opts.session } : {}) },
  ).exec()
  return postingKey
}

/** The machinery's own errors are kept as a reference, never their text (S-12): the accountant reads `lastError`. */
const MACHINERY = /^(Mongo|BSON|Mongoose|TypeError|ReferenceError|RangeError|SyntaxError|CastError|ValidationError|ValidatorError|VersionError|StrictModeError)/
const SERVER_PATH = /node_modules|[A-Za-z]:[\\/]|\/(?:app|home|root|tmp|usr|var|opt|etc|srv|mnt|data|run)\//

function errorToKeep(e: unknown): { kept: string; ref: string } {
  const ref = randomBytes(5).toString('hex')
  const name = e instanceof Error ? e.name : ''
  const message = e instanceof Error ? e.message : String(e)
  const internal = !(e instanceof Error) || MACHINERY.test(name) || SERVER_PATH.test(message) || !message
  return { kept: internal ? `Internal error (ref ${ref})` : message.slice(0, 300), ref }
}

/** Make the entry the job owes: its id, or null when there was nothing to post. */
function postFor(job: IPostingJob): Promise<string | null> {
  const orgId = String(job.orgId)
  const postingKey = job.postingKey
  const userId = job.userId ? String(job.userId) : 'system'
  switch (job.event) {
    case 'invoice.posted':
      return postInvoiceJournal({ orgId, invoiceId: String(job.invoiceId), userId, postingKey })
    case 'payment.recorded':
      return postPaymentJournal({
        orgId, invoiceId: String(job.invoiceId), userId, postingKey, auditPayment: !!job.userId,
        ...(job.paymentId ? { paymentId: job.paymentId } : { receiptId: String(job.receiptId ?? '') }),
      })
    case 'stock.movement.confirmed':
      return postMovementValuation({ orgId, movementId: String(job.movementId), postingKey })
    case 'pos.session.closed':
      return postPosSessionJournal({ orgId, sessionId: String(job.sessionId), userId, postingKey })
  }
}

export type PostingOutcome = 'done' | 'retry' | 'failed' | 'not_due'

/**
 * Run one job, when it is queued and nobody holds it (`force`: a failed one too, which an accountant asked for again).
 * `not_due` when another run holds it or it is done already.
 */
export async function runPosting(orgId: string, postingKey: string, opts: { force?: boolean } = {}): Promise<PostingOutcome> {
  const now = new Date()
  const until = new Date(now.getTime() + POSTING_LEASE_MS)
  const job = await PostingJob.findOneAndUpdate(
    {
      orgId, postingKey,
      state: opts.force ? { $in: ['queued', 'failed'] } : 'queued',
      $or: [{ leaseUntil: { $exists: false } }, { leaseUntil: null }, { leaseUntil: { $lt: now } }],
    },
    { $set: { leaseUntil: until, ...(opts.force ? { state: 'queued' } : {}) } },
    { new: true },
  ).exec()
  if (!job) return 'not_due'
  const held = { _id: job._id, orgId, leaseUntil: until }
  try {
    const entryId = await postFor(job)
    await PostingJob.updateOne(held, {
      $set: { state: 'done', doneAt: new Date(), ...(entryId ? { journalEntryId: entryId } : {}) },
      $unset: { leaseUntil: 1, lastError: 1 },
    }).exec()
    return 'done'
  } catch (e) {
    const attempts = (job.attempts || 0) + 1
    const failed = attempts >= POSTING_MAX_ATTEMPTS
    const { kept, ref } = errorToKeep(e)
    logger.error({ orgId, postingKey, event: job.event, attempts, ref, err: e }, failed ? 'A posting failed for good' : 'A posting failed and will be tried again')
    await PostingJob.updateOne(held, {
      $set: { attempts, lastError: kept, state: failed ? 'failed' : 'queued', nextAttemptAt: new Date(Date.now() + postingRetryDelay(attempts)) },
      $unset: { leaseUntil: 1 },
    }).exec()
    return failed ? 'failed' : 'retry'
  }
}

/**
 * The event's handler: the posting is owed (written now, if the state change's transaction did not, for a door that
 * owes it without one) and run at once. Never throws: the job keeps any failure, and the drain tries it again.
 */
export async function settlePosting(orgId: string, posting: OwedPosting): Promise<PostingOutcome | null> {
  try {
    const key = await enqueuePosting(orgId, posting)
    if (!key) return null
    return await runPosting(orgId, key)
  } catch (e) {
    logger.error({ orgId, event: posting.event, err: e }, 'A posting could not be owed or run; the drain will find it if it was written')
    return null
  }
}

/**
 * The scheduler's tick: the queued jobs that are due, of the orgs homed here, oldest first. Every pod may run it: the
 * lease decides who runs a job, the key that it posts once.
 */
export async function drainPostings(opts: { limit?: number; now?: Date } = {}): Promise<{ done: number; retry: number; failed: number }> {
  const now = opts.now ?? new Date()
  const due = await PostingJob.find(
    { state: 'queued', nextAttemptAt: { $lte: now }, ...(await homeScope()) },
    { orgId: 1, postingKey: 1 },
  ).sort({ nextAttemptAt: 1 }).limit(opts.limit ?? 200).lean().exec()
  const tally = { done: 0, retry: 0, failed: 0 }
  for (const j of due) {
    const outcome = await runPosting(String(j.orgId), j.postingKey)
    if (outcome !== 'not_due') tally[outcome]++
  }
  if (due.length) logger.info({ due: due.length, ...tally }, 'Postings drained')
  return tally
}

/** An accountant's "try again": a failed or queued job of this org, at once. */
export async function retryPosting(orgId: string, jobId: string): Promise<PostingOutcome | null> {
  const job = await PostingJob.findOne({ _id: jobId, orgId }, { postingKey: 1, state: 1 }).lean().exec()
  if (!job || job.state === 'done') return null
  return runPosting(orgId, job.postingKey, { force: true })
}

export interface OpenPosting {
  id: string
  event: string
  state: 'queued' | 'failed'
  attempts: number
  nextAttemptAt?: Date
  lastError?: string
  createdAt: Date
  invoiceId?: string
  movementId?: string
  sessionId?: string
}

/** An org's postings that are owed or failed, newest first, and how many of each. */
export async function openPostings(orgId: string, opts: { limit?: number } = {}): Promise<{ owed: number; failed: number; postings: OpenPosting[] }> {
  const open = { orgId, state: { $in: ['queued', 'failed'] } }
  const [rows, owed, failed] = await Promise.all([
    PostingJob.find(open).sort({ createdAt: -1 }).limit(opts.limit ?? 100).lean().exec(),
    PostingJob.countDocuments({ orgId, state: 'queued' }).exec(),
    PostingJob.countDocuments({ orgId, state: 'failed' }).exec(),
  ])
  return {
    owed,
    failed,
    postings: rows.map(j => ({
      id: String(j._id),
      event: j.event,
      state: j.state === 'failed' ? 'failed' : 'queued',
      attempts: j.attempts || 0,
      nextAttemptAt: j.nextAttemptAt,
      lastError: j.lastError,
      createdAt: j.createdAt,
      ...(j.invoiceId ? { invoiceId: String(j.invoiceId) } : {}),
      ...(j.movementId ? { movementId: String(j.movementId) } : {}),
      ...(j.sessionId ? { sessionId: String(j.sessionId) } : {}),
    })),
  }
}

/** Health: the postings owed and failed across the orgs homed here (counts only). */
export async function postingHealth(): Promise<{ owed: number; failed: number; orgsWithFailed: number }> {
  const scope = await homeScope()
  const [owed, failed, orgs] = await Promise.all([
    PostingJob.countDocuments({ state: 'queued', ...scope }).exec(),
    PostingJob.countDocuments({ state: 'failed', ...scope }).exec(),
    PostingJob.distinct('orgId', { state: 'failed', ...scope }).exec(),
  ])
  return { owed, failed, orgsWithFailed: orgs.length }
}
