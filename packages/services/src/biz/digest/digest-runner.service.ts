/**
 * FR-11.4/11.5/11.6 (#21) — claiming a day, sending it, recording what happened.
 *
 * The scheduler half is deliberately small and boring: there is no cron library, no queue and
 * no lease primitive in this codebase, and this feature was not the place to introduce one.
 * What it uses instead is the unique `{orgId, date}` index on `DigestRun` — the INSERT is the
 * lock. First writer wins, everyone else takes E11000 and walks away. That is correct across
 * restarts and across pods, which a module-level flag would not be.
 */

import { DigestRun, Org, User } from 'db/models'
import { logger } from '../../logger/logger.js'
import { sendEmail } from '../email.service.js'
import { buildDailyDigest } from './daily-digest.service.js'
import { orgLocalParts, previousLocalDate, digestHourReached } from './digest-time.js'
import { digestSubject, renderDigestHtml } from './daily-digest.render.js'
import type { IDigestRunRecipient } from 'db/models'

/** A claim older than this with no `completedAt` is assumed dead and may be taken over. */
export const STALE_CLAIM_MS = 30 * 60 * 1000

export interface DigestRunOutcome {
  status: 'sent' | 'partial' | 'failed' | 'skipped'
  reason?: string
  recipients: IDigestRunRecipient[]
}

/** Duplicate-key, i.e. "somebody else already claimed this day". */
function isDuplicateKey(e: any): boolean {
  return e?.code === 11000 || /E11000/.test(String(e?.message || ''))
}

/**
 * Resolve configured recipient userIds to live email addresses.
 *
 * Deliberately re-resolved at SEND time rather than stored: a deactivated user must stop
 * receiving the digest without anyone remembering to edit the list.
 */
export async function resolveRecipients(orgId: string, cfg: any): Promise<{ userId: string; email: string }[]> {
  const ids = (cfg?.recipients || [])
    .map((r: any) => r?.userId)
    .filter(Boolean)
    .map(String)
  if (!ids.length) return []

  const users: any[] = await User.find(
    { _id: { $in: ids }, orgId, isActive: true },
    { email: 1 },
  ).lean().exec()

  // The dedupe is belt-and-braces — `{email, orgId}` is uniquely indexed on User — but the
  // recipient list is admin-editable and one bad paste should not double-mail anyone.
  const seen = new Set<string>()
  const out: { userId: string; email: string }[] = []
  for (const u of users) {
    const email = String(u.email || '').trim().toLowerCase()
    if (!email || seen.has(email)) continue
    seen.add(email)
    out.push({ userId: String(u._id), email })
  }
  return out
}

/**
 * Build the digest for `localDate` and mail it to `recipients`.
 *
 * One `sendEmail` call per recipient — the service takes exactly one address — so N
 * recipients means N EmailLog rows, which is what makes a per-recipient failure visible.
 */
export async function sendDigestTo(
  orgId: string,
  localDate: string,
  recipients: { userId?: string; email: string }[],
): Promise<DigestRunOutcome> {
  const data = await buildDailyDigest(orgId, localDate)
  const html = renderDigestHtml(data)
  const subject = digestSubject(data)

  const results: IDigestRunRecipient[] = []
  let anyOk = false
  let notConfigured = false

  for (const r of recipients) {
    const res = await sendEmail({
      to: r.email,
      subject,
      html,
      orgId,
      entityType: 'digest',
    })
    if (res.ok) {
      anyOk = true
      results.push({ email: r.email, userId: r.userId as any, ok: true })
    } else {
      if (res.reason === 'not_configured') notConfigured = true
      results.push({ email: r.email, userId: r.userId as any, ok: false, error: res.detail || res.reason })
    }
  }

  // `not_configured` writes NO EmailLog row (the service early-returns), so the run document
  // is the only trace that anything was attempted. Say so explicitly.
  if (notConfigured && !anyOk) {
    return { status: 'skipped', reason: 'email_not_configured', recipients: results }
  }
  if (!anyOk) return { status: 'failed', reason: 'all_sends_failed', recipients: results }
  if (results.some(r => !r.ok)) return { status: 'partial', recipients: results }
  return { status: 'sent', recipients: results }
}

/**
 * Run one org's digest for one org-local SEND date, claiming it first.
 *
 * ⚠ Two different dates are in play and conflating them is the easy bug here: the run is
 * CLAIMED under the day it is sent (so "once per day" means once per calendar day), and it
 * REPORTS on the day before. `sendDate` is the former.
 *
 * Returns `null` when another runner holds the claim — the caller treats that as "not mine",
 * not as an error.
 */
export async function runDigestForOrg(orgId: string, sendDate: string): Promise<DigestRunOutcome | null> {
  const claim = await claimDay(orgId, sendDate)
  if (!claim) return null

  const reportDate = previousLocalDate(sendDate)
  let outcome: DigestRunOutcome
  try {
    const org: any = await Org.findById(orgId).lean().exec()
    const cfg = org?.settings?.dailyDigest || {}
    const recipients = await resolveRecipients(orgId, cfg)

    outcome = recipients.length
      ? await sendDigestTo(orgId, reportDate, recipients)
      : { status: 'skipped', reason: 'no_recipients', recipients: [] }
  } catch (e: any) {
    logger.error({ orgId, sendDate, reportDate, err: e?.message }, 'Daily digest build/send failed')
    outcome = { status: 'failed', reason: e?.message || 'build_failed', recipients: [] }
  }

  await DigestRun.updateOne(
    { _id: claim._id },
    { $set: { ...outcome, completedAt: new Date() } },
  ).exec()

  return outcome
}

/**
 * Insert the claim, or take over a stale one.
 *
 * The takeover exists for exactly one scenario: a pod that claimed a day and died mid-send.
 * Without it, that org silently loses its digest forever (the claim row blocks every retry).
 * The conditional `completedAt: null` is what keeps two live runners from both taking over.
 */
async function claimDay(orgId: string, date: string): Promise<{ _id: any } | null> {
  try {
    const doc = await DigestRun.create({ orgId, date, status: 'running', startedAt: new Date() })
    return { _id: doc._id }
  } catch (e) {
    if (!isDuplicateKey(e)) throw e
  }

  const cutoff = new Date(Date.now() - STALE_CLAIM_MS)
  const takeover = await DigestRun.findOneAndUpdate(
    { orgId, date, completedAt: null, startedAt: { $lte: cutoff } },
    { $set: { status: 'running', startedAt: new Date() } },
    { new: true },
  ).exec()

  if (takeover) {
    logger.warn({ orgId, date }, 'Daily digest: took over a stale claim')
    return { _id: (takeover as any)._id }
  }
  return null
}

/**
 * One scheduler tick: every org whose digest hour has arrived, in ITS OWN timezone, that has
 * not been sent today yet.
 *
 * Semantics, spelled out because they are easy to get wrong:
 *   - catch-up within the day — a restart at 11:00 still sends the 07:00 digest;
 *   - never resend — the run document, not the clock, decides that;
 *   - no multi-day backfill — an outage skips those days rather than flooding an inbox.
 */
export async function digestTick(now = new Date()): Promise<{ checked: number; ran: number }> {
  const orgs: any[] = await Org.find(
    { 'settings.dailyDigest.enabled': true },
    { name: 1, settings: 1 },
  ).lean().exec()

  let ran = 0
  for (const org of orgs) {
    try {
      const cfg = org.settings?.dailyDigest || {}
      const tz = org.settings?.timezone || 'UTC'
      const { date: today, hour } = orgLocalParts(now, tz)
      if (!digestHourReached(hour, cfg.hour)) continue

      // The claim is keyed on the day the mail goes OUT, so changing the hour (or the
      // timezone) mid-day still cannot produce a second mail.
      const existing = await DigestRun.findOne({ orgId: org._id, date: today }, { _id: 1, completedAt: 1, startedAt: 1 }).lean().exec()
      if (existing && ((existing as any).completedAt || new Date((existing as any).startedAt).getTime() > Date.now() - STALE_CLAIM_MS)) {
        continue
      }

      const outcome = await runDigestForOrg(String(org._id), today)
      if (outcome) {
        ran++
        logger.info({ orgId: String(org._id), date: today, status: outcome.status }, 'Daily digest run')
      }
    } catch (e: any) {
      // One org's failure must not stop the others.
      logger.error({ orgId: String(org._id), err: e?.message }, 'Daily digest tick failed for org')
    }
  }

  return { checked: orgs.length, ran }
}

/** The date a run started today reports on. Exported for the controller's test/preview path. */
export function reportedDateFor(sendDate: string): string {
  return previousLocalDate(sendDate)
}
