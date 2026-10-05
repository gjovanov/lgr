import { LoginThrottle } from 'db/models'
import { config } from 'config'

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
  const now = new Date()
  const keys = keysFor(input).all.map(k => k.key)
  const locked = await LoginThrottle.find({ key: { $in: keys }, lockedUntil: { $gt: now } })
    .select({ lockedUntil: 1 })
    .lean()
    .exec()
  if (!locked.length) return 0
  const until = Math.max(...locked.map(l => new Date(l.lockedUntil!).getTime()))
  return Math.max(1, Math.ceil((until - now.getTime()) / 1000))
}

/** Count one failed sign-in against every counter it belongs to. */
export async function recordLoginFailure(input: ThrottleInput): Promise<void> {
  if (!loginThrottleEnabled()) return
  const { windowMs, lockMs } = config.loginThrottle
  const now = new Date()
  const windowCutoff = new Date(now.getTime() - windowMs)
  const lockUntil = new Date(now.getTime() + lockMs)

  await Promise.all(
    keysFor(input).all.map(async ({ key, max }) => {
      const lapsed = { $or: [{ $eq: [{ $ifNull: ['$windowStart', null] }, null] }, { $lt: ['$windowStart', windowCutoff] }] }
      const bump = () => LoginThrottle.collection.updateOne(
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
          // Reaching the limit locks the key; a lock already running is left as it is.
          {
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
        await bump()
      } catch (err: any) {
        // Two first failures for the same new key can both try to INSERT it; one loses on the
        // unique index. The document exists now, so the retry takes the update path.
        if (err?.code !== 11000) throw err
        await bump()
      }
    }),
  )
}

/** A successful sign-in: forget this account's failures (the address keeps its record). */
export async function clearLoginFailures(input: ThrottleInput): Promise<void> {
  if (!loginThrottleEnabled()) return
  await LoginThrottle.deleteMany({ key: { $in: keysFor(input).account } }).exec()
}
