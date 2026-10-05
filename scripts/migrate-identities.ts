/**
 * Multi-org sign-in, Phase 1: give every `User` an `Identity` (one per person, grouped by email).
 * The rules are in `packages/services/src/biz/identity/identity-migration.service.ts`.
 *
 *   bun run scripts/migrate-identities.ts                                   # DRY RUN (default)
 *   bun run scripts/migrate-identities.ts --report /tmp/identity-plan.json  # + full plan, no hashes
 *   bun run scripts/migrate-identities.ts --keep-password a@b.example=regal-pz  (repeatable)
 *   bun run scripts/migrate-identities.ts --execute [--keep-password …]
 *   bun run scripts/migrate-identities.ts --rollback idmig-2026-10-05T…
 *   bun run scripts/migrate-identities.ts --show-emails                     # unmasked output
 *
 * A merged identity (one email, several orgs) gets NO password unless `--keep-password` names the
 * org whose password it keeps. Name it only when the person chose that password themselves, or a
 * script depends on it (rdodova drives the import skills). Everyone else signs in with their
 * verified provider account, or sets a password from the email link.
 *
 * Against production: run on master-node through a port-forward (deploy-prod skill, "Querying the
 * prod DB"), never inside the app container. Reads are the whole `users` collection.
 */
import { writeFileSync } from 'fs'
import { connectDB, disconnectDB, mongoose } from '../packages/db/src/connection.js'
import { AuditLog, Org, User } from '../packages/db/src/models/index.js'
import {
  executeIdentityMigration,
  loadMigrationInput,
  normalizeEmail,
  planIdentityMigration,
  rollbackIdentityMigration,
  type MigrationPlan,
  type PlannedIdentity,
} from '../packages/services/src/biz/identity/identity-migration.service.js'

const args = process.argv.slice(2)
const flag = (name: string) => args.includes(name)
const values = (name: string) => args.flatMap((a, i) => (a === name && args[i + 1] ? [args[i + 1]] : []))
const execute = flag('--execute')
const rollbackRun = values('--rollback')[0]
const reportPath = values('--report')[0]
const showEmails = flag('--show-emails')

function mask(email: string): string {
  if (showEmails) return email
  const [local, domain] = email.split('@')
  return `${local.slice(0, 2)}${'*'.repeat(Math.max(1, local.length - 2))}@${domain ?? ''}`
}
const day = (d?: Date) => (d ? new Date(d).toISOString().slice(0, 10) : '—')

async function main() {
  await connectDB()

  if (rollbackRun) {
    const undone = await rollbackIdentityMigration(rollbackRun)
    console.log(`Rolled back ${rollbackRun}: removed ${undone.removed} identities, unlinked ${undone.unlinked} users.`)
    return
  }

  const orgs = await Org.find({}, { slug: 1 }).lean().exec()
  const slugOf = new Map(orgs.map(o => [String(o._id), o.slug]))
  const idOfSlug = new Map(orgs.map(o => [o.slug, String(o._id)]))

  const keepPassword = new Map<string, string>()
  for (const spec of values('--keep-password')) {
    const [email, slug] = spec.split('=')
    const orgId = idOfSlug.get((slug ?? '').trim())
    if (!email || !orgId) throw new Error(`--keep-password ${spec}: expected <email>=<org slug> with a real org slug`)
    keepPassword.set(normalizeEmail(email), orgId)
  }

  const input = await loadMigrationInput()
  const plan = planIdentityMigration(input.users, {
    keepPassword,
    existingIdentityEmails: input.existingIdentityEmails,
    existingLinks: input.existingLinks,
  })
  const userById = new Map(input.users.map(u => [String(u._id), u]))

  const merged = plan.identities.filter(i => i.flags.includes('multi-org'))
  const mergedUserIds = merged.flatMap(i => i.userIds.map(String))
  const roles = new Map(
    (await User.find({ _id: { $in: mergedUserIds } }, { role: 1 }).lean().exec()).map(u => [String(u._id), u.role]),
  )
  // Who created each merged account: an admin of ANOTHER org adding someone's email is exactly the
  // case the no-password rule exists for, and this is how an operator spots it. `entityId` is
  // Mixed and `createAuditEntry` stores an ObjectId when it can (older rows: the string), so a
  // string-only `$in` matches nothing — ask for both forms.
  const created = await AuditLog.find(
    {
      entityType: 'user',
      action: 'create',
      entityId: { $in: [...mergedUserIds, ...mergedUserIds.map(id => new mongoose.Types.ObjectId(id))] },
    },
    { entityId: 1, userId: 1 },
  ).lean().exec()
  const creatorIds = [...new Set(created.map(c => String(c.userId)))]
  const creatorName = new Map(
    (await User.find({ _id: { $in: creatorIds } }, { username: 1, orgId: 1 }).lean().exec()).map(u => [
      String(u._id),
      `${u.username}@${slugOf.get(String(u.orgId)) ?? String(u.orgId)}`,
    ]),
  )
  const createdBy = new Map(created.map(c => [String(c.entityId), creatorName.get(String(c.userId)) ?? String(c.userId)]))

  printSummary(plan, merged, userById, roles, createdBy, slugOf)

  if (reportPath) {
    const strip = (p: PlannedIdentity) => {
      const { password: _hash, ...rest } = p
      return { ...rest, hasPassword: !!p.password, orgSlugs: p.orgIds.map(id => slugOf.get(String(id)) ?? String(id)) }
    }
    writeFileSync(reportPath, JSON.stringify({ ...plan, identities: plan.identities.map(strip) }, null, 2))
    console.log(`\nFull plan written to ${reportPath} (no password hashes).`)
  }

  if (!execute) {
    console.log('\nDRY RUN: nothing was written. Re-run with --execute to apply.')
    return
  }
  const runId = `idmig-${new Date().toISOString().replace(/[:.]/g, '-')}`
  const result = await executeIdentityMigration(plan, runId)
  console.log(`\nEXECUTED ${runId}: created ${result.created} identities, linked ${result.linked} users.`)
  if (result.skippedUsers) console.log(`  ${result.skippedUsers} user(s) gained another identity after the plan was made; left as they are.`)
  for (const f of result.failed) console.log(`  FAILED ${mask(f.email)}: ${f.error}`)
  console.log(`Undo with: bun run scripts/migrate-identities.ts --rollback ${runId}`)
}

function printSummary(
  plan: MigrationPlan,
  merged: PlannedIdentity[],
  userById: Map<string, any>,
  roles: Map<string, string>,
  createdBy: Map<string, string>,
  slugOf: Map<string, string | undefined>,
) {
  const singles = plan.identities.length - merged.length
  const flagCounts = new Map<string, number>()
  for (const p of plan.identities) for (const f of p.flags) flagCounts.set(f, (flagCounts.get(f) ?? 0) + 1)

  console.log('Identity migration plan')
  console.log(`  users already linked:   ${plan.alreadyLinked}`)
  console.log(`  identities to create:   ${plan.identities.length} (${singles} single-org, ${merged.length} merged)`)
  console.log(`  flags:                  ${[...flagCounts].map(([f, n]) => `${f}=${n}`).join(', ') || 'none'}`)

  console.log(`\nMerged identities (${merged.length}): one person, several orgs.`)
  if (merged.length) console.log('  ("by ?" = no audit entry: seeded, imported, self-registered or created by OAuth.)')
  for (const p of merged) {
    console.log(`  ${mask(p.email)}  [${p.flags.filter(f => f !== 'multi-org').join(', ')}]`)
    for (const id of p.userIds.map(String)) {
      const u = userById.get(id)
      const providers = (u?.oauthProviders ?? []).map((l: any) => l.provider).join('+') || 'no OAuth'
      console.log(
        `      ${(slugOf.get(String(u?.orgId)) ?? String(u?.orgId)).padEnd(18)} ${String(u?.username).padEnd(26)} ` +
          `${(roles.get(id) ?? '?').padEnd(18)} ${u?.password ? 'password' : 'no password'} · ${providers} · ` +
          `last login ${day(u?.lastLoginAt)} · created ${day(u?.createdAt)} by ${createdBy.get(id) ?? '?'}` +
          `${p.passwordFromUserId && String(p.passwordFromUserId) === id ? '  ← password kept' : ''}`,
      )
    }
  }

  // The list to settle BEFORE --execute: these people would be locked out until a password reset.
  const stranded = plan.identities.filter(i => i.flags.includes('no-sign-in-method'))
  if (stranded.length) {
    console.log(`\nNo way to sign in after the migration (${stranded.length}): no password and no provider link left.`)
    console.log('  A merged one can take --keep-password; otherwise they need a password reset.')
    for (const p of stranded) {
      const where = p.orgIds.map(id => slugOf.get(String(id)) ?? String(id)).join(', ')
      const why = p.flags.filter(f => f === 'multi-org' || f.endsWith('-dropped')).join(', ') || 'had no password or link'
      console.log(`  ${mask(p.email).padEnd(32)} ${p.usernames.join('/').padEnd(30)} ${where}  [${why}]`)
    }
  }

  if (plan.conflicts.length) {
    console.log(`\nConflicts (${plan.conflicts.length}): left alone.`)
    for (const c of plan.conflicts) console.log(`  ${mask(c.email)}: ${c.reason} (${c.userIds.length} user(s))`)
  }
  if (plan.contestedLinks.length) {
    console.log(`\nContested provider links (${plan.contestedLinks.length}): one provider account under several emails, dropped.`)
    for (const l of plan.contestedLinks) console.log(`  ${l.provider}: ${l.emails.map(mask).join(', ')}`)
  }
  if (plan.usernameCollisions.length) {
    console.log(`\nUsernames shared by different people (${plan.usernameCollisions.length}): they sign in by email or org.`)
    for (const c of plan.usernameCollisions.slice(0, 25)) console.log(`  ${c.username}: ${c.emails.length} people`)
    if (plan.usernameCollisions.length > 25) console.log(`  … and ${plan.usernameCollisions.length - 25} more (see --report)`)
  }
}

main()
  .catch(err => {
    console.error(err)
    process.exitCode = 1
  })
  .finally(() => disconnectDB())
