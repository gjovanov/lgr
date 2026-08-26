/**
 * FR-11 (#21) — render a day's digest to an HTML file WITHOUT sending anything.
 *
 * The safe way to look at the mail: no provider call, no DigestRun claim, no recipients. Use
 * it to check a specific day's numbers against the grids and reports before trusting the
 * 07:00 job, or to see what an anomaly section looks like on a day that has one.
 *
 * Usage:
 *   bun --env-file=.env scripts/preview-daily-digest.ts --org regal-pz [--date 2026-07-30]
 *   bun --env-file=.env scripts/preview-daily-digest.ts --org regal-pz --out C:/tmp/d.html
 */

import { connectDB, disconnectDB } from '../packages/db/src/connection.js'
import { Org } from '../packages/db/src/models/index.js'
import { buildDailyDigest } from '../packages/services/src/biz/digest/daily-digest.service.js'
import { orgLocalParts, previousLocalDate } from '../packages/services/src/biz/digest/digest-time.js'
import { renderDigestHtml, digestSubject } from '../packages/services/src/biz/digest/daily-digest.render.js'
import { isSectionError } from '../packages/services/src/biz/digest/daily-digest.types.js'

const args = process.argv.slice(2)
function arg(name: string): string | undefined {
  const i = args.indexOf(`--${name}`)
  if (i === -1) return undefined
  const v = args[i + 1]
  return v && !v.startsWith('--') ? v : undefined
}

const orgSlug = arg('org')
if (!orgSlug) {
  console.error('--org <slug> is required')
  process.exit(1)
}

await connectDB()

const org: any = await Org.findOne({ slug: orgSlug }).lean()
if (!org) {
  console.error(`No org with slug "${orgSlug}"`)
  await disconnectDB()
  process.exit(1)
}

const tz = org.settings?.timezone || 'UTC'
const { date: today, hour } = orgLocalParts(new Date(), tz)
const date = arg('date') || previousLocalDate(today)
const out = arg('out') || `digest-${orgSlug}-${date}.html`

console.log(`org ${org.slug} · tz ${tz} · local now ${today} ${String(hour).padStart(2, '0')}:00`)
console.log(`building the digest for ${date} …`)

const t0 = Date.now()
const data = await buildDailyDigest(String(org._id), date)
console.log(`built in ${Date.now() - t0} ms · subject: ${digestSubject(data)}`)
console.log(`allClear: ${data.allClear}`)

for (const key of ['kpis', 'documents', 'materials', 'stock', 'corrections', 'undocumentedSales', 'duplicates', 'editedAfterIssue', 'ops']) {
  const v: any = (data as any)[key]
  if (v === undefined) { console.log(`  ${key}: (section disabled)`); continue }
  if (isSectionError(v)) { console.log(`  ${key}: FAILED — ${v.message}`); continue }
  const summary =
    v.count !== undefined ? `${v.count} row(s)`
    : v.salesCount !== undefined ? `sales ${v.salesCount}/${v.salesTotal} · cash ${v.cashCount}/${v.cashTotal} · payments ${v.paymentsCount}`
    : v.sales !== undefined ? `${v.sales.count} sales doc(s), ${v.cash.count} cash sale(s), gaps: ${v.sales.sequence?.missing.length ?? 0}`
    : v.sold !== undefined ? `sold ${v.sold.rowCount} · transferred ${v.transferred.rowCount} · loaded ${v.loaded.rowCount}`
    : v.tasks !== undefined ? `${v.tasks.length} import task type(s), ${v.failedEmailCount} failed email(s)`
    : ''
  console.log(`  ${key}: ${summary}`)
}

await Bun.write(out, renderDigestHtml(data))
console.log(`\nwritten: ${out}`)
console.log('Open it in a browser — this is exactly what the mail carries.')

await disconnectDB()
