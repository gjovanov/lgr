/**
 * FR-27 §4 step 2 (#529) — an org's access model, and what shadow mode counted.
 *
 *   bun scripts/access-model.ts --org <slug>                  # the model, and the differences of the last 7 days
 *   bun scripts/access-model.ts --org <slug> --set shadow     # legacy | shadow | roles (audited)
 *   bun scripts/access-model.ts --org <slug> --report --days 1
 *
 * `shadow`: the legacy rules still decide, and the new evaluator counts each answer it would give differently
 * (`services/biz/access/shadow.ts`). An org moves to `roles` only after a day with none. Run on the org's home: the
 * setting is the home's (`settings` in `org.model.ts`), and the counts are each node's own.
 *
 * Pods cache the model for a minute, so a switch reaches every request within it.
 */
import { connectDB, disconnectDB } from '../packages/db/src/connection.js'
import { AccessShadowDiff, Org } from '../packages/db/src/models/index.js'
import { recordAuditEntry } from '../packages/services/src/biz/audit-log.service.js'
import { keepHomeOrgs } from './lib/home-guard.js'

const args = process.argv.slice(2)
const arg = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined)
const orgSlug = arg('--org')
const set = arg('--set')
const days = Number(arg('--days') ?? 7)
const MODELS = ['legacy', 'shadow', 'roles']

async function main() {
  if (!orgSlug) throw new Error('--org <slug> is required')
  if (set && !MODELS.includes(set)) throw new Error(`--set takes one of ${MODELS.join(', ')}`)
  if (set === 'roles') throw new Error('`roles` arrives with FR-27 Phase 1: nothing reads it yet')
  // Indexes and collections are the deployed release's to build, not a script's.
  await connectDB({ readOnly: true })

  const [org] = await keepHomeOrgs((await Org.find({ slug: orgSlug }).lean()) as any[], { named: true })
  if (!org) {
    console.log(`No org with slug "${orgSlug}" is written here`)
    return
  }
  const before = org.settings?.access?.model ?? 'legacy'

  if (set && set !== before) {
    await Org.updateOne({ _id: org._id }, { $set: { 'settings.access.model': set } }).exec()
    // Awaited: the script disconnects right after. No person: `via` says who.
    await recordAuditEntry({
      orgId: String(org._id), userId: '', action: 'update', module: 'admin', entityType: 'org', entityId: String(org._id),
      entityName: org.slug, changes: [{ field: 'settings.access.model', oldValue: before, newValue: set }], via: 'scripts/access-model.ts',
    })
    console.log(`${org.slug}: access model ${before} → ${set} (every pod within a minute)`)
  } else {
    console.log(`${org.slug}: access model ${before}`)
  }

  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
  const diffs = await AccessShadowDiff.find({ org: org._id, day: { $gte: since } }).sort({ count: -1 }).lean()
  const total = diffs.reduce((n, d) => n + d.count, 0)
  console.log(`differences since ${since}: ${total} request(s) over ${diffs.length} route(s)`)
  for (const d of diffs.slice(0, 50)) {
    console.log(`  ${d.day}  ${String(d.count).padStart(6)}  ${d.role.padEnd(18)} ${d.method} ${d.route}  legacy ${d.legacy}, evaluator ${d.evaluator}`)
  }
}

main()
  .catch((err) => {
    console.error(err?.message ?? err)
    process.exitCode = 1
  })
  .finally(() => disconnectDB())
