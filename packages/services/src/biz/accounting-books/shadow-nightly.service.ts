import { config } from 'config'
import { homeScope, isHomeHere } from 'db/home/home'
import { JournalEntry, Org, SHADOW_SALES } from 'db/models'
import { logger } from '../../logger/logger.js'
import { recordAuditEntry, systemActor } from '../audit-log.service.js'
import { orgLocalParts, previousLocalDate } from '../digest/digest-time.js'
import { booksOrgsOf } from './group-cost.service.js'
import { ShadowSalesError, postShadowSales, type ShadowRunReport } from './shadow-sales.service.js'

/**
 * FR-25 R3: the shadow ledger posted each night, after the day's import (the owner's decision of 2026-11-27). Until
 * then a person ran `scripts/post-shadow-sales.ts` by hand, and the shadow stood still between runs: on 11-27 it was
 * posted through 11-24, so the comparison with the books said nothing of the days after, and an accountant's override
 * of a group's cost took effect only at the next hand run over its day.
 *
 * Which orgs: every org homed here whose shadow a person has started, i.e. that holds a shadow posting. The run never
 * starts an org's shadow by itself: that takes the rules seeded, the products mapped and a dry run read first.
 *
 * What a night covers: from the first day of the month of the org's first shadow posting to yesterday (business days
 * in Sofia, as the posting's). That window is the whole shadow, so a night writes what changed anywhere in it: the
 * new documents, a document edited or voided since (reversed and posted again), a cost the books changed (a purchase
 * booked late), an override. A night missed is caught up by the next. A closed period is left alone, as by hand.
 *
 * ⚠ The bound (`NIGHTLY_BOUND`). A night's changes are its new documents and a few edits. A run that would reverse
 * more than a fifth of the live postings at once (and more than 50) is something else: a rules change, a books import
 * gone wrong, a fault. Then it writes nothing and says so, and a person reads the dry run and posts by hand, as the
 * card rule's 331 reposts of 2026-11-25 were. The shadow is in no reading of the books, so the bound is not there to
 * protect a balance: it keeps a fault from rewriting the comparison silently, night after night.
 *
 * When: the first tick in the configured hour (`config.shadowSales.hour`, 04:00 Sofia: after the evening's import and
 * the backups, outside the books nightly's daytime runs, whose import the posting's cost reads), once a day per
 * process, under the scheduler's lease (one process at a time). A second run the same day writes nothing new: the
 * posting is idempotent.
 *
 * Where it is told: a night that wrote, held or was refused leaves an audit row in the org under the system's name
 * (`shadow-sales`), the written one as the hand run's does; a night with nothing to write leaves none. A held, refused
 * or failed night is also logged and fails that tick, which the scheduler's health counts (`failures`).
 */

export interface NightlyBound {
  /** At most this many reversals are always a night's: new documents and a few edits. */
  floor: number
  /** Above the floor, the share of the live postings a night may reverse. */
  share: number
}

export const NIGHTLY_BOUND: NightlyBound = { floor: 50, share: 0.2 }

/** The audit rows' system actor, and the scheduler's name. */
export const NIGHTLY_ACTOR = 'shadow-sales'

const SOFIA = 'Europe/Sofia'
const sofiaDate = (d: Date) => orgLocalParts(d, SOFIA).date

/** The window a night covers, from the org's first shadow posting and the run's moment; null when it is empty. */
export function nightlyWindowOf(firstPosting: Date, now: Date): { from: string; to: string } | null {
  const from = `${sofiaDate(firstPosting).slice(0, 7)}-01`
  const to = previousLocalDate(sofiaDate(now))
  return from <= to ? { from, to } : null
}

/** The org's nightly window, or null when it holds no shadow posting (its shadow was never started). */
export async function nightlyWindow(orgId: string, now = new Date()): Promise<{ from: string; to: string } | null> {
  const first = await JournalEntry.findOne({ orgId, ledger: 'shadow', sourceModule: SHADOW_SALES }).sort({ date: 1 }).select('date').lean<{ date: Date }>()
  return first ? nightlyWindowOf(first.date, now) : null
}

/** Why a planned night is held, or null when it is within the bound. */
export function holdReason(plan: Pick<ShadowRunReport, 'actions' | 'live'>, bound: NightlyBound = NIGHTLY_BOUND): string | null {
  const reversals = plan.actions.repost + plan.actions.reverse
  if (reversals <= bound.floor || reversals <= bound.share * plan.live) return null
  return `it would reverse ${reversals} of the ${plan.live} live postings, more than ${Math.round(bound.share * 100)}% and more than ${bound.floor}: a rules change or a fault. Read the dry run, then post by hand`
}

export type NightlyStatus = 'written' | 'nothing' | 'held' | 'refused' | 'not_started' | 'elsewhere'

export interface NightlyOutcome {
  status: NightlyStatus
  reason?: string
  window?: { from: string; to: string }
  report?: ShadowRunReport
}

const AUDIT_ACTION: Partial<Record<NightlyStatus, string>> = { written: 'create', held: 'hold', refused: 'refused' }

/** One org's night: plans its window, holds it above the bound, writes it, and leaves the audit row. Never throws a refusal. */
export async function runShadowNightly(orgId: string, opts: { now?: Date; bound?: NightlyBound } = {}): Promise<NightlyOutcome> {
  const outcome = await night(orgId, opts.now ?? new Date(), opts.bound ?? NIGHTLY_BOUND)
  const action = AUDIT_ACTION[outcome.status]
  if (action) {
    const w = outcome.report?.written
    const a = outcome.report?.actions
    const counts = w ? { entries: w.entries, reversals: w.reversals, vatRows: w.vatRows }
      : a ? { post: a.post + a.post_and_reverse, repost: a.repost, reverse: a.reverse, live: outcome.report!.live } : {}
    const audited = await recordAuditEntry({
      orgId, actor: systemActor(NIGHTLY_ACTOR), action, module: 'accounting', entityType: 'journal_entry', entityId: orgId,
      entityName: outcome.status === 'written' ? 'sales documents posted into the shadow ledger (the nightly run)'
        : `the nightly shadow posting wrote nothing: ${outcome.reason}`.slice(0, 500),
      changes: Object.entries({ ...counts, ...(outcome.window ?? {}) }).map(([field, newValue]) => ({ field, oldValue: null, newValue })),
    })
    if (!audited) logger.warn({ orgId, status: outcome.status }, 'Nightly shadow posting: its audit row was not written')
  }
  return outcome
}

async function night(orgId: string, now: Date, bound: NightlyBound): Promise<NightlyOutcome> {
  const window = await nightlyWindow(orgId, now)
  if (!window) return { status: 'not_started' }
  if (!(await isHomeHere(orgId))) return { status: 'elsewhere', reason: 'the org is homed on another node', window }
  const org = await Org.findById(orgId).select('ownerId').lean<{ ownerId?: unknown }>()
  if (!org?.ownerId) return { status: 'refused', reason: 'the org names no owner, and a written entry names its creator', window }
  const { homeOrg } = await booksOrgsOf(orgId)
  if (homeOrg !== orgId && !(await isHomeHere(homeOrg))) return { status: 'refused', reason: 'the home of its books is homed on another node', window }
  try {
    const report = await postShadowSales(orgId, { ...window, execute: true, by: String(org.ownerId), hold: plan => holdReason(plan, bound) })
    if (report.held) return { status: 'held', reason: report.held, window, report }
    const w = report.written!
    return { status: w.entries + w.reversals + w.vatRows ? 'written' : 'nothing', window, report }
  } catch (e) {
    if (e instanceof ShadowSalesError) return { status: 'refused', reason: `${e.code}: ${e.message}`, window }
    throw e
  }
}

/** The Sofia day this process last ran the night on: one run a day per process, the lease keeps it to one process. */
let ranOn: string | undefined

/** Tests only: forget the day this process last ran. */
export function forgetNightlyRun(): void {
  ranOn = undefined
}

/**
 * One scheduler tick: in the configured hour, once a day, every org homed here whose shadow was started. One org's
 * failure does not stop the others; a held, refused or failed night fails the tick once all have run.
 */
export async function shadowNightlyTick(opts: { now?: Date; hour?: number; bound?: NightlyBound } = {}): Promise<{ outcomes: Record<string, NightlyStatus | 'failed'> }> {
  const now = opts.now ?? new Date()
  const { date, hour } = orgLocalParts(now, SOFIA)
  if (hour !== (opts.hour ?? config.shadowSales.hour) || ranOn === date) return { outcomes: {} }
  ranOn = date

  const orgs = await Org.find({ ...(await homeScope('_id')) }).select('_id slug').lean<{ _id: unknown; slug?: string }[]>()
  const outcomes: Record<string, NightlyStatus | 'failed'> = {}
  const problems: string[] = []
  for (const org of orgs) {
    const slug = org.slug ?? String(org._id)
    try {
      const r = await runShadowNightly(String(org._id), { now, ...(opts.bound ? { bound: opts.bound } : {}) })
      if (r.status === 'not_started') continue
      outcomes[slug] = r.status
      const counts = r.report ? { ...r.report.actions, live: r.report.live, written: r.report.written } : undefined
      if (r.status === 'held' || r.status === 'refused') {
        problems.push(`${slug} ${r.status}: ${r.reason}`)
        logger.warn({ org: slug, status: r.status, reason: r.reason, window: r.window, counts }, 'Nightly shadow posting wrote nothing')
      } else {
        logger.info({ org: slug, status: r.status, window: r.window, counts }, 'Nightly shadow posting')
      }
    } catch (e: any) {
      outcomes[slug] = 'failed'
      problems.push(`${slug} failed: ${String(e?.message ?? e).slice(0, 200)}`)
      logger.error({ org: slug, err: e?.message }, 'Nightly shadow posting failed')
    }
  }
  if (problems.length) throw new Error(`Nightly shadow posting: ${problems.join('; ')}`)
  return { outcomes }
}
