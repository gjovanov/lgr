import { readFileSync } from 'node:fs'
import { config, nodeRole } from 'config'
import { EmailLog, Invoice, Outbox } from 'db/models'
import { logger } from '../../logger/logger.js'
import { fetchWithTimeout } from '../outbound-fetch.js'

/**
 * FR-20.86 (plan step P2-6) — a master's outbox, drained through global's relay (FR-20.59).
 *
 * Each item goes to `POST <global>/api/node/v1/relay/mail` with the node access token the supervisor
 * keeps fresh in `state/node-token.json` (`LGR_NODE_TOKEN_FILE`), through the supervisor's egress
 * proxy like every outbound call of a master's API.
 *
 * - **Sent:** the EmailLog row turns `sent`, and an emailed invoice's send history is updated now,
 *   not when it was queued.
 * - **Retried** with backoff (1 minute doubling to an hour) when global cannot be reached, answers
 *   5xx, is rate-limiting this server, or has mail turned off for it (the org's admin may turn it
 *   on: the queue then leaves).
 * - **Failed** for good when global refuses the mail itself (too large, a bad address, not this
 *   server's org), or after {@link GIVE_UP_DAYS} days unsent. The EmailLog row says why.
 * - **Each item leaves once**: global keeps a receipt per outbox id for longer than an item may wait
 *   here (`relay-receipt.model.ts`), so the retry of an item whose answer was lost sends nothing.
 * - **A clock that went back strands nothing** (AC 27): an item last written after now was written by
 *   a clock that has since been corrected, its retry time and its lease with it, and is taken now.
 */

const LEASE_MS = 2 * 60_000
/**
 * FR-20.60: a master loses only the relayed services for a 30-day outage, and their work leaves when
 * the uplink returns (FR-20.86, AC 27). Past that outage, 15 days more to drain under the relay's
 * per-server caps. ⚠ Global's receipts must outlive it (`RELAY_RECEIPT_KEEP_DAYS`), or a retry after
 * a lost answer could send twice.
 */
export const GIVE_UP_DAYS = 45
const GIVE_UP_MS = GIVE_UP_DAYS * 86_400_000
const MAX_BACKOFF_MS = 60 * 60_000
const PER_TICK = 20

export interface NodeToken {
  server: string
  token: string
  /** Seconds since the epoch. */
  expiresAt: number
}

/** The supervisor's current node token, unless it is missing or about to expire. */
export function readNodeToken(file = config.outbox.tokenFile, now = Date.now()): NodeToken | null {
  if (!file) return null
  try {
    const t = JSON.parse(readFileSync(file, 'utf8'))
    if (typeof t?.server !== 'string' || !/^https:\/\//.test(t.server) || typeof t?.token !== 'string' || !Number.isFinite(t?.expiresAt)) return null
    return t.expiresAt * 1000 > now + 30_000 ? { server: t.server.replace(/\/+$/, ''), token: t.token, expiresAt: t.expiresAt } : null
  } catch {
    return null
  }
}

function backoff(attempts: number): number {
  return Math.min(MAX_BACKOFF_MS, 60_000 * 2 ** Math.max(0, attempts - 1))
}

async function settle(item: any, state: 'sent' | 'failed', now: Date, error?: string, from: 'sending' | 'queued' = 'sending'): Promise<void> {
  const p = item.payload ?? {}
  // A mail of several documents names each (`sendEmail`'s `entities`); one of a single document names it flat.
  const entities: Array<{ entityType?: string; entityId?: string }> = Array.isArray(p.entities) && p.entities.length ? p.entities : []
  // The bytes go once the item is done: a sent mail's attachments have no further use here.
  const done = await Outbox.updateOne(
    { _id: item._id, state: from },
    {
      $set: {
        state,
        doneAt: now,
        payload: { to: p.to, subject: p.subject, entityType: p.entityType, entityId: p.entityId, ...(entities.length ? { entities } : {}) },
        ...(error ? { lastError: error.slice(0, 1000) } : {}),
      },
      $unset: { leaseUntil: 1 },
    },
  )
  if (!done.modifiedCount) return
  await EmailLog.updateMany({ outboxId: item._id }, { $set: { status: state, ...(error ? { error: error.slice(0, 1000) } : {}) } })
  if (state !== 'sent') return
  if (p.entityType === 'invoice' && p.entityId) {
    await Invoice.updateOne({ _id: p.entityId, orgId: item.orgId }, { $addToSet: { emailedTo: p.to }, $set: { lastEmailedAt: now } })
  }
  // Every invoice the mail carried: its send history changes now that the mail has gone, never when it was queued.
  const invoiceIds = entities.filter(e => e?.entityType === 'invoice' && e.entityId).map(e => e.entityId)
  if (invoiceIds.length) {
    await Invoice.updateMany({ _id: { $in: invoiceIds }, orgId: item.orgId }, { $addToSet: { emailedTo: p.to }, $set: { lastEmailedAt: now } })
  }
}

async function retryLater(item: any, now: Date, delayMs: number, error: string): Promise<void> {
  if (now.getTime() - new Date(item.createdAt).getTime() > GIVE_UP_MS) {
    await settle(item, 'failed', now, `Not sent in ${GIVE_UP_DAYS} days: ${error}`)
    return
  }
  await Outbox.updateOne(
    { _id: item._id, state: 'sending' },
    { $set: { state: 'queued', nextAt: new Date(now.getTime() + delayMs), lastError: error.slice(0, 1000) }, $unset: { leaseUntil: 1 } },
  )
}

export type DrainOutcome = 'sent' | 'failed' | 'retry' | 'idle' | 'no_token'

/** Send the next due item, if there is one and a token to send it with. */
export async function drainOne(now = new Date(), fetchImpl: typeof fetch = fetch): Promise<DrainOutcome> {
  const token = readNodeToken(config.outbox.tokenFile, now.getTime())
  if (!token) return 'no_token'
  const item: any = await Outbox.findOneAndUpdate(
    {
      $or: [
        { state: 'queued', nextAt: { $lte: now } },
        { state: 'sending', leaseUntil: { $lt: now } },
        // Last written by a clock that has gone back since (AC 27): its retry time or its lease was dated by that clock.
        // Never "further ahead than a backoff": a rate-limited item waits the hours global asked for.
        { state: { $in: ['queued', 'sending'] }, updatedAt: { $gt: now } },
      ],
    },
    { $set: { state: 'sending', leaseUntil: new Date(now.getTime() + LEASE_MS) }, $inc: { attempts: 1 } },
    { sort: { nextAt: 1 }, new: true },
  ).lean()
  if (!item) return 'idle'
  const p = item.payload ?? {}
  let res: Response
  try {
    res = await fetchWithTimeout(`${token.server}/api/node/v1/relay/mail`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ outboxId: item._id, orgId: String(item.orgId), to: p.to, subject: p.subject, html: p.html, attachments: p.attachments ?? [] }),
    }, { timeoutMs: 90_000, fetchImpl })
  } catch (e: any) {
    await retryLater(item, now, backoff(item.attempts), `lgrai.app could not be reached: ${e?.message ?? e}`)
    return 'retry'
  }
  const body: any = await res.json().catch(() => ({}))
  const why = `${body?.code ?? res.status}: ${body?.message ?? res.statusText}`
  if (res.ok && body?.state === 'sent') {
    await settle(item, 'sent', now)
    return 'sent'
  }
  if (res.status === 429) {
    await retryLater(item, now, Math.max(60_000, Number(body?.retryAfterSecs) * 1000 || 0), why)
    return 'retry'
  }
  // Off for this server until an admin of the org turns it on: kept, and tried again hourly.
  if (res.status === 403 && body?.code === 'relay_disabled') {
    await retryLater(item, now, MAX_BACKOFF_MS, why)
    return 'retry'
  }
  // The mail itself is refused, or this server is not the org's: trying again cannot help.
  if ([403, 409, 413, 422].includes(res.status) && body?.code !== 'in_progress') {
    await settle(item, 'failed', now, why)
    logger.warn({ outboxId: item._id, status: res.status, code: body?.code }, 'lgrai.app refused a queued mail')
    return 'failed'
  }
  // 401 (a new token is coming), 409 in_progress, 5xx: later.
  await retryLater(item, now, res.status === 401 || res.status === 409 ? 60_000 : backoff(item.attempts), why)
  return 'retry'
}

/**
 * Items {@link GIVE_UP_DAYS} days old that never left, whatever kept them (a master never registered,
 * an outage longer than FR-20.60's 30 days): failed, so the EmailLog stops saying "queued" about a
 * mail that will not go.
 */
export async function giveUp(now = new Date()): Promise<number> {
  const stale = await Outbox.find({ state: 'queued', createdAt: { $lt: new Date(now.getTime() - GIVE_UP_MS) } }).limit(100).lean()
  for (const item of stale as any[]) await settle(item, 'failed', now, `Not sent in ${GIVE_UP_DAYS} days: ${item.lastError ?? 'lgrai.app was not reached'}`, 'queued')
  return stale.length
}

let running = false

/** The scheduler's tick: a batch of due items, one at a time. */
export async function outboxTick(now = () => new Date()): Promise<void> {
  if (nodeRole() !== 'master' || running) return
  running = true
  try {
    await giveUp(now())
    for (let i = 0; i < PER_TICK; i++) {
      const outcome = await drainOne(now())
      if (outcome === 'idle' || outcome === 'no_token') break
    }
  } finally {
    running = false
  }
}
