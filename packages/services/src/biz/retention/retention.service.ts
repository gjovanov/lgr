/**
 * FR-13.43–13.46 (#24) — the only scheduled deletion in the product.
 *
 * Two things happen here and nothing else ever will without the same argument being made
 * again: `EmailLog` loses its rendered body at 90 days and the row itself at a year, and a
 * settled `DocFile` loses the diff summary that was only ever scaffolding for settling it.
 *
 * ⚠ WHY AN ALLOW-LIST AND NOT A CAREFUL QUERY. ЗСч чл. 12 / ДОПК чл. 38 ал. 1 require ten
 * years of fiscal records and payroll carries a FIFTY-year floor. `Invoice`,
 * `StockMovement`, `POSTransaction`, `JournalEntry`, `AuditLog`, `Sequence`, `PayrollRun`,
 * `Payslip` and their kin MUST NOT be pruned, ever, by anything. A retention job is the one
 * piece of code in the system whose bugs are silent, delayed and unrecoverable: nobody
 * notices a deletion until they need the row, which is years later, by which time the
 * backups that held it have rotated. `TOUCHABLE` exists so that reaching a fiscal collection
 * requires editing a list that says exactly this, rather than mistyping a filter.
 *
 * ⚠ Deliberately NOT a Mongo TTL index. A TTL index is invisible at the call site, cannot be
 * batched, cannot be dry-run, and deletes whole DOCUMENTS — there is no TTL that strips one
 * field. `EmailLog`'s value is the row (was it sent, when, did it fail); only the body is
 * the weight. That asymmetry is the whole design and a TTL cannot express it.
 */
import { EmailLog, DocFile } from 'db/models'
import { homeScope } from 'db/home/home'
import { config } from 'config'
import { logger } from '../../logger/logger.js'

/**
 * The complete set of collections this module may write to, and the only field it may remove
 * from each. Anything absent here is fiscal, or not yet argued about, which are the same
 * thing as far as this file is concerned.
 */
export const TOUCHABLE = {
  EmailLog: ['body'],
  DocFile: ['compareSummary'],
} as const

export interface RetentionOutcome {
  /** Rows whose `body` was removed but which still exist. */
  emailBodiesStripped: number
  /** Rows deleted outright. */
  emailLogsDeleted: number
  /** `DocFile`s that lost a settled `compareSummary`. */
  compareSummariesStripped: number
  /** True when a cap was hit, so the caller knows the next tick still has work. */
  more: boolean
}

const daysAgo = (days: number, now: Date) => new Date(now.getTime() - days * 24 * 60 * 60 * 1000)

/**
 * Delete `EmailLog` rows past their retention.
 *
 * ⚠ Runs BEFORE the body strip, and the order is not cosmetic: a row old enough to delete is
 * not worth rewriting first. Reversed, every first run against a backlog would write every
 * ancient row once and then immediately delete it — the most expensive possible way to reach
 * the same state, against the largest collection in the database.
 */
async function deleteExpiredEmailLogs(now: Date, limit: number): Promise<number> {
  const cutoff = daysAgo(config.retention.emailLogDays, now)
  // Ids first, so the delete is bounded. `deleteMany` with a date filter has no limit, and an
  // unbounded first run against years of rows is exactly the pause this cap exists to avoid.
  // FR-20.5: sweeps across orgs touch only the orgs whose home is here (on global the scope is a
  // `$nin`, which still matches the org-less rows — system mail — so those keep being swept).
  const doomed: any[] = await EmailLog.find({ createdAt: { $lt: cutoff }, ...(await homeScope()) }, { _id: 1 })
    .limit(limit).lean().exec()
  if (!doomed.length) return 0
  const res = await EmailLog.deleteMany({ _id: { $in: doomed.map(d => d._id) } }).exec()
  return res.deletedCount || 0
}

/**
 * Strip the rendered body from `EmailLog` rows past the body window, keeping the row.
 *
 * ⚠ `$unset`, not `$set: ''`. An empty string is indistinguishable from a message that was
 * genuinely sent empty, and it still costs a BSON field per row. Absent means stripped.
 */
async function stripEmailBodies(now: Date, limit: number): Promise<number> {
  const cutoff = daysAgo(config.retention.emailBodyDays, now)
  const targets: any[] = await EmailLog.find(
    { createdAt: { $lt: cutoff }, body: { $exists: true }, ...(await homeScope()) },
    { _id: 1 },
  ).limit(limit).lean().exec()
  if (!targets.length) return 0
  const res = await EmailLog.updateMany(
    { _id: { $in: targets.map(t => t._id) } },
    { $unset: { body: '' } },
  ).exec()
  return res.modifiedCount || 0
}

/**
 * Drop `compareSummary` from documents that have finished being compared.
 *
 * ⚠ Gated on STATUS, not on age. The summary is the working state of the store-availability
 * diff; once a `DocFile` is `committed` or `superseded` that question is answered and the
 * blob is dead weight of unbounded size (`Schema.Types.Mixed`). An `uploaded` or `analyzed`
 * row keeps its summary however old it is, because something is still using it.
 */
async function stripSettledCompareSummaries(limit: number): Promise<number> {
  const targets: any[] = await DocFile.find(
    // FR-20.5: a sweep across orgs touches only the orgs whose home is here.
    { status: { $in: ['committed', 'superseded'] }, compareSummary: { $exists: true }, ...(await homeScope()) },
    { _id: 1 },
  ).limit(limit).lean().exec()
  if (!targets.length) return 0
  const res = await DocFile.updateMany(
    { _id: { $in: targets.map(t => t._id) } },
    { $unset: { compareSummary: '' } },
  ).exec()
  return res.modifiedCount || 0
}

/**
 * One retention pass across every org.
 *
 * ⚠ Not per-org, unlike `digestTick` and `backupTick`. Those decide in each org's own
 * timezone whether its hour has come; retention has no hour and no per-org setting — a row
 * 366 days old is 366 days old in every timezone. Sweeping globally is one indexed range
 * query instead of one per org, on the collection where that difference is largest.
 *
 * Never throws: the caller is a `setInterval`, and a retention failure must not take down the
 * process that is also serving requests. It returns what it did so a test can assert it.
 */
export async function retentionTick(now = new Date()): Promise<RetentionOutcome> {
  const limit = config.retention.batchSize
  const out: RetentionOutcome = {
    emailBodiesStripped: 0,
    emailLogsDeleted: 0,
    compareSummariesStripped: 0,
    more: false,
  }

  out.emailLogsDeleted = await deleteExpiredEmailLogs(now, limit)
  out.emailBodiesStripped = await stripEmailBodies(now, limit)
  out.compareSummariesStripped = await stripSettledCompareSummaries(limit)
  out.more = out.emailLogsDeleted >= limit ||
    out.emailBodiesStripped >= limit ||
    out.compareSummariesStripped >= limit

  if (out.emailLogsDeleted || out.emailBodiesStripped || out.compareSummariesStripped) {
    logger.info({ ...out, touchable: Object.keys(TOUCHABLE) }, 'Retention sweep')
  }
  return out
}
