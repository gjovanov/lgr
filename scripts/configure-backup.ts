/**
 * FR-13.10 (#24) — turn the per-org nightly backup on or off from the command line.
 *
 * The scheduler is **opt-in**. 73 of the 80 orgs in production are `e2e-*` test tenants, and
 * bundling every one of them nightly would fill the uploads PV — the one resource §2.4
 * identifies as under real pressure — with artifacts nobody will ever read. Enabling an org
 * is therefore a deliberate act, exactly like naming a digest recipient.
 *
 * ⚠ This gates the SCHEDULER only. An org admin can always take a manual backup of their own
 * org through `POST /org/:orgId/backup/run`, enabled or not.
 *
 * Usage:
 *   bun --env-file=.env scripts/configure-backup.ts --org regal-pz [--hour 3] [--disable] [--execute]
 *   bun --env-file=.env scripts/configure-backup.ts --list
 *
 * Dry-run by default.
 */

import { connectDB, disconnectDB } from '../packages/db/src/connection.js'
import { assertScriptHome } from './lib/home-guard.js'
import { Org } from '../packages/db/src/models/index.js'

const args = process.argv.slice(2)
function arg(name: string): string | undefined {
  const i = args.indexOf(`--${name}`)
  if (i === -1) return undefined
  const v = args[i + 1]
  return v && !v.startsWith('--') ? v : undefined
}
const execute = args.includes('--execute')
const disable = args.includes('--disable')
const list = args.includes('--list')

await connectDB()

if (list) {
  const orgs: any[] = await Org.find({}, { slug: 1, name: 1, settings: 1 }).lean()
  const on = orgs.filter(o => o.settings?.backup?.enabled)
  console.log(`${on.length} of ${orgs.length} orgs have nightly backups enabled:\n`)
  for (const o of on) {
    const hour = o.settings?.backup?.hour
    console.log(`  ${o.slug.padEnd(24)} ${o.settings?.timezone || 'UTC'} @ ${hour ?? '(default)'}`)
  }
  if (!on.length) console.log('  (none — the scheduler will do nothing)')
  await disconnectDB()
  process.exit(0)
}

const orgSlug = arg('org')
const hourArg = arg('hour')

if (!orgSlug) {
  console.error('--org <slug> is required (or --list)')
  process.exit(1)
}

const org: any = await Org.findOne({ slug: orgSlug }).lean()
if (!org) {
  console.error(`No org with slug "${orgSlug}"`)
  await disconnectDB()
  process.exit(1)
}

await assertScriptHome(org._id, orgSlug)
const current = org.settings?.backup || {}
const next = {
  enabled: !disable,
  hour: hourArg !== undefined ? Number(hourArg) : current.hour,
}

console.log(`\norg      : ${org.slug} (${org.name})`)
console.log(`timezone : ${org.settings?.timezone || '(unset — runs on UTC)'}`)
console.log(`enabled  : ${current.enabled ?? false} → ${next.enabled}`)
console.log(`hour     : ${current.hour ?? '(config default)'}${hourArg !== undefined ? ` → ${next.hour}` : ''}`)

if (!execute) {
  console.log('\nDRY RUN — re-run with --execute to apply.')
} else {
  await Org.updateOne({ _id: org._id }, { $set: { 'settings.backup': next } })
  console.log('\nApplied.')
  console.log('The scheduler picks it up on its next tick (BACKUP_CHECK_INTERVAL_MS, default 10 min).')
}

await disconnectDB()
