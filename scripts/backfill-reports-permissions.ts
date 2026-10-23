/**
 * FR-06 / FR-6.2 (#14) — grant the new `reports.read` / `reports.export` permissions to
 * existing organisations, and make sure every org has the Reports app enabled.
 *
 * Why this exists: P1 gated the Reports tile on `invoicing.read` precisely to avoid needing
 * this. P2 introduces the real permissions (the SUPTO tables are not an invoicing concern,
 * and a warehouse_manager needs the app without invoicing rights), which means stored
 * PermissionSets — written when `reports.*` did not exist — have to be topped up.
 *
 * ⚠ ORDER OF OPERATIONS. Run this BEFORE announcing the deploy:
 *     1. deploy the code
 *     2. bun run scripts/backfill-reports-permissions.ts --execute
 *     3. tell people to re-login
 *   A JWT is issued at login and carries its permission list; until a user logs in again
 *   they will not have `reports.*` no matter what the database says. Admins are the
 *   exception — `tokenize()` expands an `isAdmin` permission set to every PERMISSION, so an
 *   admin gets the new rights on their next login with or without this script.
 *
 * Rules applied to each stored set:
 *   - `isAdmin`            → skipped; it is expanded at tokenize time.
 *   - has any `*.read`     → gains `reports.read`  (if you may read anything, you may open
 *                            the Reports app; the per-report gate still hides content).
 *   - has any write-ish    → gains `reports.export` (`.write` / `.post` / `.send` / `.adjust`
 *                            / `.approve`, or `admin.audit` — the NRA auditor's set is
 *                            read-only by design yet exporting is its entire purpose).
 *
 * Idempotent: a set that already has both is left alone. Dry-run by default.
 *
 * Usage:
 *   bun run scripts/backfill-reports-permissions.ts                # dry run, all orgs
 *   bun run scripts/backfill-reports-permissions.ts --execute
 *   bun run scripts/backfill-reports-permissions.ts --org acme-corp --execute
 */

import { connectDB, disconnectDB } from '../packages/db/src/connection.js'
import { keepHomeOrgs } from './lib/home-guard.js'
import { Org, PermissionSet, OrgApp } from '../packages/db/src/models/index.js'

const args = process.argv.slice(2)
const execute = args.includes('--execute')
const orgSlug = args[args.indexOf('--org') + 1]?.startsWith('--') ? undefined : args[args.indexOf('--org') + 1]

const READ_SUFFIX = '.read'
const WRITE_MARKERS = ['.write', '.post', '.send', '.adjust', '.approve']

function needsRead(permissions: string[]): boolean {
  return permissions.some(p => p.endsWith(READ_SUFFIX))
}

function needsExport(permissions: string[]): boolean {
  return permissions.some(p => WRITE_MARKERS.some(m => p.endsWith(m))) || permissions.includes('admin.audit')
}

async function main() {
  await connectDB()

  const orgFilter = orgSlug ? { slug: orgSlug } : {}
  const orgs = await keepHomeOrgs(await Org.find(orgFilter).lean() as any[], { named: !!orgSlug })
  if (!orgs.length) {
    console.log(orgSlug ? `No org with slug "${orgSlug}"` : 'No organizations found')
    return
  }

  console.log(`${execute ? 'EXECUTING' : 'DRY RUN'} — ${orgs.length} organization(s)\n`)

  let setsChanged = 0
  let appsEnabled = 0

  for (const org of orgs) {
    const sets = await PermissionSet.find({ orgId: org._id }).lean()
    const changes: string[] = []

    for (const set of sets) {
      if (set.isAdmin) continue
      const perms: string[] = set.permissions || []
      const add: string[] = []
      if (needsRead(perms) && !perms.includes('reports.read')) add.push('reports.read')
      if (needsExport(perms) && !perms.includes('reports.export')) add.push('reports.export')
      if (!add.length) continue

      changes.push(`    ${set.name}: +${add.join(', +')}`)
      setsChanged++
      if (execute) {
        await PermissionSet.updateOne({ _id: set._id }, { $addToSet: { permissions: { $each: add } } })
      }
    }

    // OrgApp rows lazy-create on the first `GET /org/:id/apps`, so this is belt-and-braces —
    // but an org that never opens the App Hub would otherwise have no row at all.
    const existing = await OrgApp.findOne({ orgId: org._id, appId: 'reports' }).lean()
    if (!existing) {
      appsEnabled++
      changes.push('    + OrgApp row for "reports"')
      if (execute) {
        await OrgApp.create({ orgId: org._id, appId: 'reports', enabled: true, activatedAt: new Date() })
      }
    } else if (!existing.enabled) {
      // Deliberately NOT re-enabling: an admin may have switched the app off on purpose.
      changes.push('    ! OrgApp row exists but is disabled — left as is')
    }

    console.log(`  ${org.slug || org.name}${changes.length ? '' : ' — nothing to do'}`)
    changes.forEach(c => console.log(c))
  }

  console.log(
    `\n${execute ? 'Updated' : 'Would update'} ${setsChanged} permission set(s), ` +
    `${execute ? 'created' : 'would create'} ${appsEnabled} OrgApp row(s).`,
  )
  if (!execute) console.log('Re-run with --execute to apply.')
  else console.log('Remember: users must RE-LOGIN before their JWT carries reports.*')
}

main()
  .catch((e) => {
    console.error(e)
    process.exitCode = 1
  })
  .finally(() => disconnectDB())
