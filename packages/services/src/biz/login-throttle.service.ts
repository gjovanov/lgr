import { LoginThrottle } from 'db/models'
import { config, nodeRole } from 'config'
import { BACKOFF } from './identity/local-credentials.service.js'

/**
 * S-08 — the failed-sign-in throttle for `POST /auth/login`.
 *
 * Nothing capped password attempts anywhere. Three counters close that without handing an attacker
 * an easy way to lock other people out:
 *
 *   pair:<ip>|<account>  a guesser at one address. It locks only THAT address out of THAT account,
 *                        so someone hammering your username from elsewhere does not lock you out.
 *   acct:<account>       the same account guessed from many addresses. A higher bar, and the one
 *                        that stops a botnet from getting `perAccountAndIp` tries per address.
 *   ip:<ip>              one address spraying many accounts.
 *
 * `<account>` is `orgSlug|username`, lowercased: the throttle must not be sidestepped by casing. An
 * org-less sign-in (multi-org, Phase 2) has no slug and counts as `|username`: a name several people
 * share is one target, which is what it is to a guesser.
 *
 * Only FAILURES count. A till, an import script or the e2e suite signs in hundreds of times a day
 * and must never trip it. A success clears that account's counters, but not the address's. The
 * counters live in Mongo (`login_throttles`), not in memory, because production runs more than one
 * pod and an in-memory limit is multiplied by their number.
 *
 * Each counter update is a single pipeline `updateOne`, so concurrent failures can't lose a count,
 * and a window that has lapsed resets in the same atomic step.
 */

export interface ThrottleInput {
  /** Absent on an org-less sign-in. */
  orgSlug?: string
  username: string
  /** From `clientIp()`; absent behind no proxy (local dev), and then only `acct:` applies. */
  ip?: string
}

interface Keyed {
  key: string
  max: number
}

function accountOf(input: ThrottleInput): string {
  return `${(input.orgSlug ?? '').trim().toLowerCase()}|${input.username.trim().toLowerCase()}`
}

function keysFor(input: ThrottleInput): { all: Keyed[]; account: string[] } {
  const t = config.loginThrottle
  const account = accountOf(input)
  const all: Keyed[] = [{ key: `acct:${account}`, max: t.perAccount }]
  if (input.ip) {
    all.unshift({ key: `pair:${input.ip}|${account}`, max: t.perAccountAndIp })
    all.push({ key: `ip:${input.ip}`, max: t.perIp })
  }
  // On success only the account's counters are cleared; the address keeps its record.
  const accountKeys = all.filter(k => !k.key.startsWith('ip:')).map(k => k.key)
  return { all, account: accountKeys }
}

export function loginThrottleEnabled(): boolean {
  return config.loginThrottle.enabled
}

/**
 * Seconds until this sign-in may be attempted again, or `0` when it may go ahead now.
 * Checked BEFORE the password is verified, so a locked-out guesser costs no argon2 work.
 */
export async function loginRetryAfterSeconds(input: ThrottleInput): Promise<number> {
  if (!loginThrottleEnabled()) return 0
  return lockedFor(keysFor(input).all.map(k => k.key))
}

/** Count one failed sign-in against every counter it belongs to. */
export async function recordLoginFailure(input: ThrottleInput): Promise<void> {
  if (!loginThrottleEnabled()) return
  // A master backs off rather than locks (FR-20.40, trap 32).
  await bump(keysFor(input).all, { backoff: nodeRole() === 'master' })
}

// ── Password-reset requests (multi-org Phase 4) ──────────────────────────────────────────────
//
// A reset request mails a link, so it is limited too: per address (no inbox gets flooded, and a
// person cannot be spammed with reset mail), and per IP (no one sprays every address). Its keys
// are its own (`reset-acct:`, `reset-ip:`): a burst of reset requests must never lock anyone out
// of SIGNING IN, and sign-in failures must never block a reset (that is how you recover).

/** Reset links one address may be sent within the window. */
const RESETS_PER_ADDRESS = 3

function resetKeys(email: string, ip?: string): Keyed[] {
  const keys: Keyed[] = [{ key: `reset-acct:${email.trim().toLowerCase()}`, max: RESETS_PER_ADDRESS }]
  if (ip) keys.push({ key: `reset-ip:${ip}`, max: config.loginThrottle.perIp })
  return keys
}

export async function passwordResetRetryAfterSeconds(email: string, ip?: string): Promise<number> {
  if (!loginThrottleEnabled()) return 0
  return lockedFor(resetKeys(email, ip).map(k => k.key))
}

/** Count a reset request, whether or not the address has an account (the answer is the same). */
export async function recordPasswordResetRequest(email: string, ip?: string): Promise<void> {
  if (!loginThrottleEnabled()) return
  // Locked everywhere: a lock here locks nobody out of signing in, it only stops a mail flood.
  await bump(resetKeys(email, ip), { backoff: false })
}

// ── The counters ────────────────────────────────────────────────────────────────────────────

/** Seconds until every one of `keys` is unlocked; `0` when none is locked. */
async function lockedFor(keys: string[]): Promise<number> {
  const now = new Date()
  const locked = await LoginThrottle.find({ key: { $in: keys }, lockedUntil: { $gt: now } })
    .select({ lockedUntil: 1 })
    .lean()
    .exec()
  if (!locked.length) return 0
  const until = Math.max(...locked.map(l => new Date(l.lockedUntil!).getTime()))
  return Math.max(1, Math.ceil((until - now.getTime()) / 1000))
}

/** One event against each counter; a counter reaching its `max` locks its key, or backs it off. */
async function bump(keyed: Keyed[], opts: { backoff: boolean }): Promise<void> {
  const { windowMs, lockMs } = config.loginThrottle
  const now = new Date()
  const windowCutoff = new Date(now.getTime() - windowMs)
  const lockUntil = new Date(now.getTime() + lockMs)

  await Promise.all(
    keyed.map(async ({ key, max }) => {
      const lapsed = { $or: [{ $eq: [{ $ifNull: ['$windowStart', null] }, null] }, { $lt: ['$windowStart', windowCutoff] }] }
      const apply = () => LoginThrottle.collection.updateOne(
        { key },
        [
          {
            $set: {
              key,
              failures: { $cond: [lapsed, 1, { $add: [{ $ifNull: ['$failures', 0] }, 1] }] },
              windowStart: { $cond: [lapsed, now, '$windowStart'] },
              updatedAt: now,
            },
          },
          opts.backoff
            // FR-20.40, trap 32: on a master the password is the person's LOCAL credential, and a
            // lock lets anyone at a till lock the shop's admin out for the length of an outage. So
            // a counter at its limit backs off instead: the PIN's curve, 1 s doubling to 60 s.
            ? {
              $set: {
                lockedUntil: {
                  $cond: [
                    { $gte: ['$failures', max] },
                    {
                      $add: [now, {
                        $min: [BACKOFF.maxMs, { $multiply: [BACKOFF.firstMs, { $pow: [2, { $subtract: ['$failures', max] }] }] }],
                      }],
                    },
                    { $ifNull: ['$lockedUntil', null] },
                  ],
                },
              },
            }
            // Reaching the limit locks the key; a lock already running is left as it is.
            : {
              $set: {
                lockedUntil: {
                  $cond: [
                    { $and: [{ $gte: ['$failures', max] }, { $not: [{ $gt: [{ $ifNull: ['$lockedUntil', null] }, now] }] }] },
                    lockUntil,
                    { $ifNull: ['$lockedUntil', null] },
                  ],
                },
              },
            },
        ],
        { upsert: true },
      )
      try {
        await apply()
      } catch (err: any) {
        // Two first failures for the same new key can both try to INSERT it; one loses on the
        // unique index. The document exists now, so the retry takes the update path.
        if (err?.code !== 11000) throw err
        await apply()
      }
    }),
  )
}

/** A successful sign-in: forget this account's failures (the address keeps its record). */
export async function clearLoginFailures(input: ThrottleInput): Promise<void> {
  if (!loginThrottleEnabled()) return
  await LoginThrottle.deleteMany({ key: { $in: keysFor(input).account } }).exec()
}
