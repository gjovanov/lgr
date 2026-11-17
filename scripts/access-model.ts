/**
 * FR-27 (#529) — who in an org has no role, and giving roles to the people from before roles.
 *
 *   bun scripts/access-model.ts --org <slug>                  # the org: its people without a role
 *   bun scripts/access-model.ts --org <slug> --give-roles     # migration 0015's own `up`, scoped to the org
 *   bun scripts/access-model.ts --all                         # every org homed here with someone without a role
 *
 * Every org is decided by its people's roles since FR-27 P3-2, and the legacy model is gone since P3-6: there is no
 * access model to switch any more, and no shadow mode counting differences. `--set`, `--report` and `--days` are
 * refused with that answer. `Org.settings.access.model` is read by nothing; it stays as it was last written.
 *
 * A person without a role is refused at sign-in (`no_role`). One from before roles is given one with exactly the
 * access their legacy fields gave by migration 0015's own code, scoped to the org (`--give-roles`); anyone else is
 * given a role by an administrator (Settings → Roles & access, or `scripts/restore-administrator.ts` when nobody can).
 * Run on the org's home.
 */
import { connectDB, disconnectDB, mongoose } from '../packages/db/src/connection.js'
import { Org, User } from '../packages/db/src/models/index.js'
import { rolesFromSets } from '../packages/migrations/src/migrations/0015-roles-from-sets.js'
import { keepHomeOrgs } from './lib/home-guard.js'

const args = process.argv.slice(2)
const arg = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined)
const orgSlug = arg('--org')
const all = args.includes('--all')
const giveRoles = args.includes('--give-roles')
const GONE = ['--set', '--report', '--days', '--min-days', '--execute']

const withoutRole = (orgId: unknown) => User.countDocuments({ orgId, roleId: { $exists: false } }).exec()

/** Migration 0015's own `up`, scoped to one org: a role, with exactly their legacy access, for whoever has none. */
async function giveRolesIn(orgId: unknown): Promise<void> {
  await rolesFromSets.up({ db: mongoose.connection.db as any, log: () => {}, orgFilter: { orgId } })
}

async function allOrgs(): Promise<void> {
  if (giveRoles) throw new Error('--give-roles takes one org (--org <slug>)')
  const orgs = await keepHomeOrgs((await Org.find({}, { slug: 1 }).sort({ slug: 1 }).lean()) as any[], { named: false })
  let short = 0
  for (const org of orgs) {
    const n = await withoutRole(org._id)
    if (!n) continue
    short++
    console.log(`  ${org.slug}: ${n} person(s) without a role`)
  }
  console.log(`${orgs.length} org(s); ${short} with someone without a role`)
}

async function oneOrg(): Promise<void> {
  const [org] = await keepHomeOrgs((await Org.find({ slug: orgSlug }).lean()) as any[], { named: true })
  if (!org) {
    console.log(`No org with slug "${orgSlug}" is written here`)
    return
  }
  if (giveRoles && (await withoutRole(org._id))) {
    await giveRolesIn(org._id)
    console.log(`${org.slug}: roles given by 0015`)
  }
  console.log(`${org.slug}: ${await withoutRole(org._id)} person(s) without a role`)
}

async function main() {
  const gone = GONE.filter(a => args.includes(a))
  if (gone.length) {
    throw new Error(`${gone.join(', ')}: gone with the legacy model (FR-27 P3-6). Every org is decided by roles; there is no model to switch and no shadow mode.`)
  }
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
