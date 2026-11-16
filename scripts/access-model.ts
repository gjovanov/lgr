/**
 * FR-27 §4 step 2 (#529) — an org's access model, and what shadow mode counted.
 *
 *   bun scripts/access-model.ts --org <slug>                  # the model, and the differences of the last 7 days
 *   bun scripts/access-model.ts --org <slug> --set shadow     # legacy | shadow | roles (audited)
 *   bun scripts/access-model.ts --org <slug> --report --days 1
 *
 * Every org, one step at a time (FR-27 Phase 3, P3-1; `scripts/lib/access-advance.ts` decides):
 *
 *   bun scripts/access-model.ts --all --set shadow [--execute]                  # legacy → shadow, roles given first
 *   bun scripts/access-model.ts --all --set roles [--min-days 1] [--execute]    # shadow → roles, after a clean day
 *
 * `--all` writes nothing without `--execute`, and prints what it would move and what it skips, with why.
 *
 * `roles` (FR-27 Phase 1): every request is decided by the person's role, and the legacy rules are counted beside it.
 * It is refused while anyone in the org has no role. Back to `legacy` at any time: its fields are still written.
 *
 * `shadow`: the legacy rules still decide, and the new evaluator counts each answer it would give differently
 * (`services/biz/access/shadow.ts`). An org moves to `roles` only after a day with none. ⚠ An org on `legacy` counts
 * nothing, so its report proves nothing: `--all` moves it to `shadow` first. Run on the org's home: the setting is the
 * home's (`settings` in `org.model.ts`), and the counts are each node's own.
 *
 * A person without a role is given one with exactly their access by migration 0015's own code, scoped to the org
 * (`--give-roles` for one org; `--all --set shadow --execute` does it for each org it moves).
 *
 * Pods cache the model for a minute, so a switch reaches every request within it.
 */
import { connectDB, disconnectDB, mongoose } from '../packages/db/src/connection.js'
import { AccessShadowDiff, AuditLog, Org, User } from '../packages/db/src/models/index.js'
import { recordAuditEntry } from '../packages/services/src/biz/audit-log.service.js'
import { rolesFromSets } from '../packages/migrations/src/migrations/0015-roles-from-sets.js'
import { advance, type AccessModel } from './lib/access-advance.js'
import { keepHomeOrgs } from './lib/home-guard.js'

const VIA = 'scripts/access-model.ts'
const args = process.argv.slice(2)
const arg = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined)
const orgSlug = arg('--org')
const all = args.includes('--all')
const set = arg('--set')
const days = Number(arg('--days') ?? 7)
const minDays = Number(arg('--min-days') ?? 1)
const execute = args.includes('--execute')
const giveRoles = args.includes('--give-roles')
const MODELS = ['legacy', 'shadow', 'roles']

const modelOf = (org: any): AccessModel => org.settings?.access?.model ?? 'legacy'
const withoutRole = (orgId: unknown) => User.countDocuments({ orgId, roleId: { $exists: false } }).exec()

/** Migration 0015's own `up`, scoped to one org: a role, with exactly their access, for whoever has none. */
async function giveRolesIn(orgId: unknown): Promise<void> {
  await rolesFromSets.up({ db: mongoose.connection.db as any, log: () => {}, orgFilter: { orgId } })
}

/** How many of the org's people 0015 would leave without a role (its preview's differences), without writing. */
async function leftWithoutRole(org: any): Promise<number> {
  if (!(await withoutRole(org._id))) return 0
  const lines = await rolesFromSets.preview!({ db: mongoose.connection.db as any, log: () => {}, orgFilter: { orgId: org._id } })
  const line = lines.find(l => l.startsWith(`${org.slug}: differences: `))
  return line ? Number(line.split(': ').pop()) : await withoutRole(org._id)
}

async function setModel(org: any, before: AccessModel, next: string): Promise<void> {
  await Org.updateOne({ _id: org._id }, { $set: { 'settings.access.model': next } }).exec()
  // Awaited: the script disconnects right after. No person: `via` says who.
  await recordAuditEntry({
    orgId: String(org._id), userId: '', action: 'update', module: 'admin', entityType: 'org', entityId: String(org._id),
    entityName: org.slug, changes: [{ field: 'settings.access.model', oldValue: before, newValue: next }], via: VIA,
  })
}

/** When the org last moved to `shadow`, by its audit entry. */
async function shadowSince(org: any): Promise<Date | null> {
  const entry: any = await AuditLog.findOne(
    { orgId: org._id, entityType: 'org', changes: { $elemMatch: { field: 'settings.access.model', newValue: 'shadow' } } },
    { timestamp: 1 },
  ).sort({ timestamp: -1 }).lean().exec()
  return entry?.timestamp ?? null
}

async function differencesSince(org: any, since: Date): Promise<number> {
  const rows = await AccessShadowDiff.find({ org: org._id, day: { $gte: since.toISOString().slice(0, 10) } }, { count: 1 }).lean()
  return rows.reduce((n, d: any) => n + d.count, 0)
}

async function allOrgs(): Promise<void> {
  if (set !== 'shadow' && set !== 'roles') throw new Error('--all takes --set shadow or --set roles')
  const orgs = await keepHomeOrgs((await Org.find({}, { slug: 1, settings: 1 }).sort({ slug: 1 }).lean()) as any[], { named: false })
  console.log(`${execute ? 'EXECUTING' : 'DRY RUN'}: --all --set ${set}${set === 'roles' ? ` --min-days ${minDays}` : ''} over ${orgs.length} org(s)`)
  const now = new Date()
  let moved = 0
  for (const org of orgs) {
    const model = modelOf(org)
    const since = model === 'shadow' ? await shadowSince(org) : null
    const facts = {
      slug: org.slug,
      model,
      withoutRole: set === 'shadow' && model === 'legacy' ? await leftWithoutRole(org) : await withoutRole(org._id),
      shadowSince: since,
      differences: since ? await differencesSince(org, since) : 0,
    }
    const decision = advance(facts, set, { now, minDays })
    if (!decision.move) {
      console.log(`  skip  ${org.slug}: ${decision.reason}`)
      continue
    }
    if (execute) {
      if (set === 'shadow') {
        await giveRolesIn(org._id)
        const still = await withoutRole(org._id)
        if (still) {
          console.log(`  skip  ${org.slug}: ${still} person(s) still without a role after 0015`)
          continue
        }
      }
      await setModel(org, model, set)
    }
    moved++
    console.log(`  ${execute ? 'moved' : 'would '} ${org.slug}: ${decision.reason}`)
  }
  console.log(`${moved} org(s) ${execute ? 'moved' : 'would move'} to ${set}${execute ? ' (every pod within a minute)' : '; add --execute to write'}`)
}

async function oneOrg(): Promise<void> {
  if (set && !MODELS.includes(set)) throw new Error(`--set takes one of ${MODELS.join(', ')}`)
  const [org] = await keepHomeOrgs((await Org.find({ slug: orgSlug }).lean()) as any[], { named: true })
  if (!org) {
    console.log(`No org with slug "${orgSlug}" is written here`)
    return
  }
  const before = modelOf(org)

  if (giveRoles && (await withoutRole(org._id))) {
    await giveRolesIn(org._id)
    console.log(`${org.slug}: roles given by 0015; ${await withoutRole(org._id)} person(s) still without one`)
  }
  // FR-27 §4: `roles` decides by the person's role, so every person needs one (migration 0015).
  if (set === 'roles') {
    const without = await withoutRole(org._id)
    if (without) {
      console.log(`${org.slug}: ${without} person(s) have no role yet; run again with --give-roles (0015, exactly their access). Nothing changed.`)
      return
    }
  }
  if (set && set !== before) {
    await setModel(org, before, set)
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

async function main() {
  if (!orgSlug && !all) throw new Error('--org <slug> or --all is required')
  if (orgSlug && all) throw new Error('--org and --all do not go together')
  // Indexes and collections are the deployed release's to build, not a script's.
  await connectDB({ readOnly: true })
  if (all) await allOrgs()
  else await oneOrg()
}

main()
  .catch((err) => {
    console.error(err?.message ?? err)
    process.exitCode = 1
  })
  .finally(() => disconnectDB())
