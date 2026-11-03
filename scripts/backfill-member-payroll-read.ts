/**
 * FR-25 R0 / §3.11 — a plain member no longer reads payroll. Take `payroll.read` from the default
 * member permissions already stored, before any real payroll is imported.
 *
 * Why the release alone does not do it: it changes the role's defaults and what a NEW org's set is
 * seeded with. An existing member still holds the permission from one of two rows:
 *   - the org's seeded "Member (Read Only)" set, which outranks the role at sign-in;
 *   - their own `User.permissions`, written from the role's defaults when the account was made,
 *     which `tokenizeFromRole` merges back in.
 *
 * ⚠ ORDER OF OPERATIONS:
 *     1. deploy the code
 *     2. bun run scripts/backfill-member-payroll-read.ts            (dry run: read what it leaves)
 *     3. bun run scripts/backfill-member-payroll-read.ts --execute
 *     4. wait out the sessions, or tell members to sign in again
 *   A JWT carries the permission list it was issued with, so a session issued before step 3 keeps
 *   reading payroll until it expires, 24 hours at most (`SESSION_TTL_SECONDS`). Do not import real
 *   payroll until that has passed.
 *
 * What it leaves, and prints: a set that bears the seeded set's identity but that an admin changed,
 * and a member whose own list is not a default. Those were somebody's decision. It reads as "left"
 * in the dry run, so a set an org changed by accident can be fixed by hand in the UI.
 *
 * It runs for the orgs homed on this node. A master's own orgs need it run there: FR-25's payroll is
 * never on a master (§3.11), so nothing depends on it yet.
 *
 * Idempotent. Dry-run by default.
 *
 * Usage:
 *   bun run scripts/backfill-member-payroll-read.ts                # dry run, all orgs
 *   bun run scripts/backfill-member-payroll-read.ts --execute
 *   bun run scripts/backfill-member-payroll-read.ts --org acme-corp --execute
 */

import { connectDB, disconnectDB } from '../packages/db/src/connection.js'
import { keepHomeOrgs } from './lib/home-guard.js'
import { Org } from '../packages/db/src/models/index.js'
import { backfillMemberPayrollRead } from '../packages/services/src/biz/member-payroll-read.backfill.js'

const args = process.argv.slice(2)
const execute = args.includes('--execute')
const orgSlug = args.includes('--org') ? args[args.indexOf('--org') + 1] : undefined

async function main() {
  // Indexes and collections are the deployed release's to build, not a script's.
  await connectDB({ readOnly: true })

  const orgs = await keepHomeOrgs(await Org.find(orgSlug ? { slug: orgSlug } : {}).lean() as any[], { named: !!orgSlug })
  if (!orgs.length) {
    console.log(orgSlug ? `No org with slug "${orgSlug}"` : 'No organizations found')
    return
  }

  console.log(`${execute ? 'EXECUTING' : 'DRY RUN'} — ${orgs.length} organization(s)\n`)

  let sets = 0
  let users = 0
  let setsLeft = 0
  let usersLeft = 0

  for (const org of orgs) {
    const result = await backfillMemberPayrollRead(String(org._id), { execute })
    sets += result.setsChanged.length
    users += result.usersChanged
    setsLeft += result.setsLeftAlone.length
    usersLeft += result.usersLeftAlone

    const lines = [
      ...result.setsChanged.map(name => `    ${name}: -payroll.read`),
      ...(result.usersChanged ? [`    ${result.usersChanged} member(s)' own list: -payroll.read`] : []),
      ...result.setsLeftAlone.map(s => `    ! left, an admin changed it: ${s.name} [${s.permissions.join(', ')}]`),
      ...(result.usersLeftAlone ? [`    ! left, not a default list: ${result.usersLeftAlone} member(s)`] : []),
    ]
    console.log(`  ${org.slug || org.name}${lines.length ? '' : ' — nothing to do'}`)
    lines.forEach(l => console.log(l))
  }

  console.log(
    `\n${execute ? 'Updated' : 'Would update'} ${sets} permission set(s) and ${users} member(s); ` +
    `left ${setsLeft} set(s) and ${usersLeft} member(s) as they are.`,
  )
  if (!execute) console.log('Re-run with --execute to apply.')
  else console.log('Remember: a session issued before this keeps payroll.read until it expires, 24 hours at most.')
}

main()
  .catch((e) => {
    console.error(e)
    process.exitCode = 1
  })
  .finally(() => disconnectDB())
