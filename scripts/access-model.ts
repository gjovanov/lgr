/**
 * FR-27 (#529) — who in an org has no role.
 *
 *   bun scripts/access-model.ts --org <slug>                  # the org: its people without a role
 *   bun scripts/access-model.ts --all                         # every org homed here with someone without a role
 *
 * Every org is decided by its people's roles since FR-27 P3-2, and the legacy model is gone since P3-6: there is no
 * access model to switch any more, and no shadow mode counting differences. `--set`, `--report` and `--days` are
 * refused with that answer. `Org.settings.access.model` is read by nothing; it stays as it was last written.
 *
 * A person without a role is refused at sign-in (`no_role`), and is given one by an administrator (Settings → Roles &
 * access, or `scripts/restore-administrator.ts` when nobody can). Run on the org's home.
 *
 * FR-27 P3-9: `--give-roles` (migration 0015's own `up`, for the people from before roles) is refused too. 0015 read a
 * person's legacy fields, which migration 0017 took off every person and 0020 dropped with the archive: there is no
 * person from before roles left to read, and 0015 would read a person without the fields as a Member.
 */
import { connectDB, disconnectDB } from '../packages/db/src/connection.js'
import { Org, User } from '../packages/db/src/models/index.js'
import { keepHomeOrgs } from './lib/home-guard.js'

const args = process.argv.slice(2)
const arg = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined)
const orgSlug = arg('--org')
const all = args.includes('--all')
const GONE = ['--set', '--report', '--days', '--min-days', '--execute']

const withoutRole = (orgId: unknown) => User.countDocuments({ orgId, roleId: { $exists: false } }).exec()

async function allOrgs(): Promise<void> {
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
  console.log(`${org.slug}: ${await withoutRole(org._id)} person(s) without a role`)
}

async function main() {
  const gone = GONE.filter(a => args.includes(a))
  if (gone.length) {
    throw new Error(`${gone.join(', ')}: gone with the legacy model (FR-27 P3-6). Every org is decided by roles; there is no model to switch and no shadow mode.`)
  }
  if (args.includes('--give-roles')) {
    throw new Error('--give-roles: gone with the legacy access (FR-27 P3-9). Migrations 0017 and 0020 took the legacy fields it read off every person; give a role in Settings → Roles & access, or with scripts/restore-administrator.ts.')
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
