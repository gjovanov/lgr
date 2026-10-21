/**
 * One-off: apply FR-13.43 retention to the `EmailLog` backlog that accumulated before the
 * scheduled sweep existed.
 *
 * Background: `EmailLog` has never had a TTL. Measured at ~52 KB/row and ~28 MB/yr at two
 * recipients, it is the largest non-fiscal consumer in the database, and the BODY is
 * essentially all of it. The row itself is worth keeping far longer than its rendered HTML:
 * without the body it still answers "was this document emailed, when, and did it work",
 * which is what the FR-10.6 double-click guard and the digest's failed-email section read.
 *
 * The scheduled `retentionTick` does exactly this work every few hours, bounded by
 * `config.retention.batchSize` so it cannot stall the event loop. That bound means a large
 * backlog takes many ticks to clear. This script is the same operations run to completion,
 * once, so the reclaim happens when an operator is watching rather than over several days.
 *
 * ⚠ Reads the same `config.retention` windows as the tick. It is not a second policy, and it
 * must never become one.
 *
 * ⚠ Touches `EmailLog` and nothing else. `Invoice`, `StockMovement`, `POSTransaction`,
 * `JournalEntry`, `AuditLog`, `Sequence`, `PayrollRun` and `Payslip` are protected by
 * ЗСч чл. 12 / ДОПК чл. 38 ал. 1 (ten years; payroll fifty) and are not reachable from here.
 *
 * Usage:
 *   bun run scripts/backfill-email-log-retention.ts              # dry-run report
 *   bun run scripts/backfill-email-log-retention.ts --execute    # actually apply
 */
import { connectDB, disconnectDB } from '../packages/db/src/connection.js'
import { tenantHomeScope } from './lib/home-guard.js'
import { EmailLog } from '../packages/db/src/models/index.js'
import { config } from '../packages/config/src/index.js'

const execute = process.argv.slice(2).includes('--execute')

const daysAgo = (d: number) => new Date(Date.now() - d * 24 * 60 * 60 * 1000)
const mb = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MB`

async function main() {
  await connectDB()
  // FR-20.4: only the orgs homed here; an org homed elsewhere is swept by its own home.
  const home = await tenantHomeScope()

  const deleteCutoff = daysAgo(config.retention.emailLogDays)
  const stripCutoff = daysAgo(config.retention.emailBodyDays)

  const total = await EmailLog.countDocuments({ ...home })
  const toDelete = await EmailLog.countDocuments({ createdAt: { $lt: deleteCutoff }, ...home })
  // ⚠ Excludes the rows that are about to be deleted, so the two numbers do not double-count
  // and the report says what will actually happen rather than what each step sees alone.
  const toStrip = await EmailLog.countDocuments({
    createdAt: { $gte: deleteCutoff, $lt: stripCutoff },
    body: { $exists: true },
    ...home,
  })

  // Rough, but worth stating: the whole point of this is bytes.
  const sample: any[] = await EmailLog.find(
    { createdAt: { $lt: stripCutoff }, body: { $exists: true } },
    { body: 1 },
  ).limit(200).lean().exec()
  const avgBody = sample.length
    ? sample.reduce((n, r) => n + (r.body?.length || 0), 0) / sample.length
    : 0

  console.log(`rows total:                 ${total}`)
  console.log(`delete (> ${config.retention.emailLogDays}d):           ${toDelete}`)
  console.log(`strip body (> ${config.retention.emailBodyDays}d):        ${toStrip}`)
  console.log(`avg body (sample of ${sample.length}):   ${Math.round(avgBody)} bytes`)
  console.log(`approx reclaim:             ${mb((toDelete + toStrip) * avgBody)}`)

  if (!execute) {
    console.log('\ndry run — pass --execute to apply')
    await disconnectDB()
    return
  }

  // Delete first. A row old enough to remove is not worth rewriting on its way out.
  const del = await EmailLog.deleteMany({ createdAt: { $lt: deleteCutoff }, ...home }).exec()
  console.log(`\ndeleted ${del.deletedCount} rows`)

  const strip = await EmailLog.updateMany(
    { createdAt: { $lt: stripCutoff }, body: { $exists: true }, ...home },
    { $unset: { body: '' } },
  ).exec()
  console.log(`stripped ${strip.modifiedCount} bodies`)

  console.log('\ndone — the scheduled tick keeps it this way from here')
  await disconnectDB()
}

main().catch(async e => {
  console.error(e)
  await disconnectDB()
  process.exit(1)
})
