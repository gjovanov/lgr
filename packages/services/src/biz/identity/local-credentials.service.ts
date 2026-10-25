/**
 * A person's PIN for this master (FR-20.40, plan step P1-5).
 *
 * ⚠ SERVER-ONLY, and master-only: `local_credentials` is node state. On global every entry point
 * throws `not_master`, which the routes answer as 404.
 *
 * Signing in is "operator code + PIN" in the org of the desktop that asks. The operator code
 * names the membership (it is unique per org, and printed on every fiscal receipt, so it is no
 * secret). The PIN proves it.
 *
 * - **No lockout (trap 32).** Failures slow the next attempt down, per person (persisted) and per
 *   desktop (this process), and never stop it. A PIN that locked after five tries would let anyone
 *   at a till lock every operator out for the length of an outage.
 * - **One argon2 verify per attempt, whatever the outcome**, as `login()` does (S-08): no code,
 *   no PIN or an invalidated PIN all cost a decoy verify, so response time says nothing.
 * - **Invalidated by the person's `tokenVersion`.** A password change or a sign-out everywhere bumps
 *   it, and the next sign-in at the till must then use the password and set a PIN again.
 */
import { Identity, LocalCredential, User, type IIdentity, type IUser } from 'db/models'
import { nodeRole } from 'config'
import { verifyPassword } from './session.service.js'

export class LocalCredentialError extends Error {
  constructor(
    readonly code: 'not_master' | 'invalid_pin' | 'pin_not_set' | 'pin_backoff' | 'pin_rule' | 'wrong_password',
    readonly statusCode: number,
    message: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(message)
  }
}

function requireMaster(): void {
  if (nodeRole() !== 'master') throw new LocalCredentialError('not_master', 404, 'Not found.')
}

// ── The rule a PIN must meet ────────────────────────────────────────────────────────────────

export const PIN_MIN = 6
export const PIN_MAX = 12

/** Why this PIN may not be set, or null. Digits only, 6–12, and not one a person guesses first. */
export function pinRuleViolation(pin: string): string | null {
  if (!/^\d+$/.test(pin)) return 'A PIN is digits only.'
  if (pin.length < PIN_MIN || pin.length > PIN_MAX) return `A PIN has ${PIN_MIN} to ${PIN_MAX} digits.`
  if (/^(\d)\1+$/.test(pin)) return 'A PIN may not repeat one digit.'
  const steps = [...pin].slice(1).map((d, i) => Number(d) - Number(pin[i]))
  if (steps.every(s => s === 1) || steps.every(s => s === -1)) return 'A PIN may not be a run of digits.'
  return null
}

// ── Backoff, never a lockout ────────────────────────────────────────────────────────────────

/** Free tries before the first delay, the first delay, and the most it ever grows to. */
export const BACKOFF = { free: 3, firstMs: 1_000, maxMs: 60_000 } as const

/** How long the next attempt waits after this many consecutive failures. */
export function backoffDelayMs(failures: number): number {
  if (failures <= BACKOFF.free) return 0
  return Math.min(BACKOFF.maxMs, BACKOFF.firstMs * 2 ** (failures - BACKOFF.free - 1))
}

/** A streak older than this is forgotten: an old run of typos does not slow a later shift down. */
const STREAK_TTL_MS = 60 * 60_000

interface Streak { failures: number; nextAttemptAt: number; lastFailureAt: number }
const desktopStreaks = new Map<string, Streak>()
const DESKTOP_STREAKS_MAX = 10_000

function streakOf(desktopId: string, now: number): Streak | undefined {
  const s = desktopStreaks.get(desktopId)
  if (s && now - s.lastFailureAt > STREAK_TTL_MS) {
    desktopStreaks.delete(desktopId)
    return undefined
  }
  return s
}

function failDesktop(desktopId: string | undefined, now: number): void {
  if (!desktopId) return
  if (desktopStreaks.size >= DESKTOP_STREAKS_MAX) desktopStreaks.clear()
  const failures = (streakOf(desktopId, now)?.failures ?? 0) + 1
  desktopStreaks.set(desktopId, { failures, nextAttemptAt: now + backoffDelayMs(failures), lastFailureAt: now })
}

/** For tests: forget every desktop's streak. */
export function forgetDesktopStreaks(): void {
  desktopStreaks.clear()
}

const backoff = (until: number, now: number) =>
  new LocalCredentialError('pin_backoff', 429, 'Too many wrong PINs: wait a moment and try again.', Math.max(1, Math.ceil((until - now) / 1000)))

// ── One verify per attempt ──────────────────────────────────────────────────────────────────

let decoyHash: Promise<string> | undefined
function decoy(): Promise<string> {
  decoyHash ??= Bun.password.hash(crypto.randomUUID())
  return decoyHash
}

// ── Setting and removing ────────────────────────────────────────────────────────────────────

/** Set or change the signed-in person's PIN, proving their password (FR-20.40). */
export async function setPin(identityId: string, password: string, pin: string): Promise<void> {
  requireMaster()
  const identity = await Identity.findById(identityId).select('+password tokenVersion isActive').exec()
  // One verify whatever happens, so this answers the same for a missing person.
  const ok = await verifyPassword(password, identity?.password || await decoy())
  if (!identity || identity.isActive === false || !identity.password || !ok) {
    throw new LocalCredentialError('wrong_password', 403, 'That is not your password.')
  }
  const violation = pinRuleViolation(pin)
  if (violation) throw new LocalCredentialError('pin_rule', 422, violation)
  const verifier = await Bun.password.hash(pin, { algorithm: 'argon2id' })
  await LocalCredential.updateOne(
    { identityId: identity._id, kind: 'pin' },
    { $set: { verifier, tvAtSet: identity.tokenVersion ?? 0, failures: 0, setAt: new Date() }, $unset: { nextAttemptAt: 1 } },
    { upsert: true },
  ).exec()
}

export async function removePin(identityId: string): Promise<void> {
  requireMaster()
  await LocalCredential.deleteOne({ identityId, kind: 'pin' }).exec()
}

/** Whether the person has a PIN that still works here. */
export async function hasPin(identityId: string): Promise<boolean> {
  requireMaster()
  const [cred, identity] = await Promise.all([
    LocalCredential.findOne({ identityId, kind: 'pin' }, { tvAtSet: 1 }).lean().exec(),
    Identity.findById(identityId, { tokenVersion: 1 }).lean().exec(),
  ])
  return !!cred && !!identity && (cred as any).tvAtSet === ((identity as any).tokenVersion ?? 0)
}

// ── Signing in ──────────────────────────────────────────────────────────────────────────────

export interface PinSignIn {
  orgId: string
  operatorCode: string
  pin: string
  /** The paired desktop that asks; undefined on the console. */
  desktopId?: string
  now?: number
}

/** The membership and the person a correct PIN proves. Throws `LocalCredentialError` otherwise. */
export async function pinSignIn(req: PinSignIn): Promise<{ user: IUser; identity: IIdentity }> {
  requireMaster()
  const now = req.now ?? Date.now()

  const desk = req.desktopId ? streakOf(req.desktopId, now) : undefined
  if (desk && now < desk.nextAttemptAt) throw backoff(desk.nextAttemptAt, now)

  const user = /^\d{1,8}$/.test(req.operatorCode)
    ? await User.findOne({ orgId: req.orgId, operatorCode: req.operatorCode, isActive: { $ne: false } }).exec()
    : null
  const identity = user?.identityId ? await Identity.findById(user.identityId).exec() : null
  const cred = identity
    ? await LocalCredential.findOne({ identityId: identity._id, kind: 'pin' }).select('+verifier').exec()
    : null

  // The person's own streak is checked before the verify, so a waiting attempt costs nothing.
  if (cred?.nextAttemptAt && now < cred.nextAttemptAt.getTime()) throw backoff(cred.nextAttemptAt.getTime(), now)

  const live = !!identity && identity.isActive !== false && !!cred && cred.tvAtSet === (identity.tokenVersion ?? 0)
  const ok = await verifyPassword(req.pin, live ? cred!.verifier : await decoy())

  if (!user || !identity || identity.isActive === false) {
    failDesktop(req.desktopId, now)
    throw new LocalCredentialError('invalid_pin', 401, 'That operator code and PIN do not match.')
  }
  if (!live) {
    failDesktop(req.desktopId, now)
    // Said plainly: the operator is at the till, and only their password can set a PIN again.
    throw new LocalCredentialError('pin_not_set', 401, 'This operator has no PIN here yet, or it was reset: sign in with your password and set one.')
  }
  if (!ok) {
    failDesktop(req.desktopId, now)
    const failures = cred!.failures + 1
    const delay = backoffDelayMs(failures)
    await LocalCredential.updateOne(
      { _id: cred!._id },
      { $set: { failures, ...(delay ? { nextAttemptAt: new Date(now + delay) } : {}) } },
    ).exec()
    throw new LocalCredentialError('invalid_pin', 401, 'That operator code and PIN do not match.', delay ? Math.ceil(delay / 1000) : undefined)
  }

  if (cred!.failures || cred!.nextAttemptAt) {
    await LocalCredential.updateOne({ _id: cred!._id }, { $set: { failures: 0 }, $unset: { nextAttemptAt: 1 } }).exec()
  }
  if (req.desktopId) desktopStreaks.delete(req.desktopId)
  return { user, identity }
}
