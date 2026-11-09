/**
 * FR-27.8 (#529) — give a person of an org the Administrator role again, when the org locked itself out: nobody
 * left who may manage roles. A sys-admin's tool, run on the org's home, and audited.
 *
 *   bun scripts/restore-administrator.ts --org <slug> --user <username>              # what it would do
 *   bun scripts/restore-administrator.ts --org <slug> --user <username> --execute
 *
 * The person gets the org's built-in Administrator role (migration 0015 made it), and the legacy fields that match
 * it (`role: admin`, no set), so the legacy model and an older master agree. Their sessions follow within a minute
 * on `roles`; on the legacy model they sign in again.
 */
import { connectDB, disconnectDB } from '../packages/db/src/connection.js'
import { Role, User } from '../packages/db/src/models/index.js'
import { Org } from '../packages/db/src/models/index.js'
import { recordAuditEntry } from '../packages/services/src/biz/audit-log.service.js'
import { endSessionsOf } from '../packages/services/src/biz/permission-set.service.js'
import { keepHomeOrgs } from './lib/home-guard.js'

const args = process.argv.slice(2)
const arg = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined)
const orgSlug = arg('--org')
const username = arg('--user')
const execute = args.includes('--execute')

async function main() {
  if (!orgSlug || !username) throw new Error('--org <slug> and --user <username> are required')
  await connectDB({ readOnly: true })
  const [org] = await keepHomeOrgs((await Org.find({ slug: orgSlug }).lean()) as any[], { named: true })
  if (!org) return console.log(`No org with slug "${orgSlug}" is written here`)
  const person: any = await User.findOne({ orgId: org._id, username }).lean()
  if (!person) return console.log(`${org.slug}: no user "${username}"`)
  const admin: any = await Role.findOne({ orgId: org._id, isBuiltin: true, templateKey: 'admin' }).lean()
  if (!admin) return console.log(`${org.slug}: no built-in Administrator role yet: run \`bun run migrate\` (0015-roles-from-sets) first`)
  if (String(person.roleId ?? '') === String(admin._id) && person.isActive !== false) return console.log(`${org.slug}: ${username} is an active Administrator already`)

  console.log(`${execute ? 'EXECUTING' : 'DRY RUN'}: ${org.slug}: ${username} → Administrator${person.isActive === false ? ', and active again' : ''}`)
  if (!execute) return

  const now = new Date()
  const history = [...(person.roleHistory ?? [])]
  const open = history.find((h: any) => !h.endDate)
  if (open) open.endDate = now
  history.push({ role: 'admin', roleName: admin.name, startDate: now, assignedAt: now })
  await User.updateOne(
    { _id: person._id, orgId: org._id },
    { $set: { roleId: admin._id, role: 'admin', permissionSetIds: [], permissions: [], roleHistory: history, isActive: true }, $unset: { deactivatedAt: 1 } },
  )
  await endSessionsOf(person.identityId)
  await recordAuditEntry({
    orgId: String(org._id), userId: '', action: 'update', module: 'admin', entityType: 'user', entityId: String(person._id), entityName: username,
    changes: [{ field: 'role', oldValue: person.roleId ? String(person.roleId) : person.role, newValue: admin.name }], via: 'scripts/restore-administrator.ts',
  })
  console.log(`${org.slug}: ${username} is an Administrator again`)
}

main()
  .catch((err) => {
    console.error(err?.message ?? err)
    process.exitCode = 1
  })
  .finally(() => disconnectDB())
