/**
 * Seed a user into an existing org, fully wired for SUPTO + RBAC:
 *   - password hashed with Bun.password.hash
 *   - operatorCode allocated atomically (SUPTO — every user needs one)
 *   - role + a roleHistory activity entry (the role-assignment audit trail)
 *   - permissions from DEFAULT_ROLE_PERMISSIONS[role]
 *   - default permission sets seeded (idempotent) + the matching set linked
 *
 * Idempotent: if a user with the username or email already exists in the org it
 * is reported and left untouched (missing permission-set link is repaired).
 *
 * Usage:
 *   bun run scripts/seed-user.ts --org <slug> --email <e> --username <u> --password <p> --first <F> --last <L>            # dry-run
 *   bun run scripts/seed-user.ts --org regal-pz --email rdodova@gmail.com --username rdodova --password 'Rd12345!!' \
 *       --first Rozalina --last Dodova --role admin --execute
 *
 * Options:
 *   --org <slug>     (required) target org — must already exist
 *   --email          (required)
 *   --username       (required)
 *   --password       (required)
 *   --first          (required) first name
 *   --last           (required) last name
 *   --middle <m>     middle name (Bulgarian three-part names)
 *   --position <p>   job title
 *   --role <role>    admin | manager | accountant | warehouse_manager | member | nra_auditor  (default: admin)
 *   --inactive       create the user inactive (default: active)
 *   --set-owner      set org.ownerId to this user if the org has no owner yet
 *   --execute        perform writes (default: dry-run)
 */
import { connectDB, disconnectDB } from '../packages/db/src/connection.js'
import { Org, User, Sequence, PermissionSet } from '../packages/db/src/models/index.js'
import { DEFAULT_ROLE_PERMISSIONS, ROLES } from '../packages/config/src/constants.js'
import { seedDefaultPermissionSets, ROLE_TO_PERMISSION_SET } from '../packages/services/src/biz/permission-set.seed.js'
import { createMongoRepositories } from '../packages/dal-mongo/src/index.js'

function parseArgs(argv: string[]) {
  const o: Record<string, string | boolean> = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) continue
    const key = a.slice(2)
    const next = argv[i + 1]
    if (next && !next.startsWith('--')) { o[key] = next; i++ } else { o[key] = true }
  }
  return o
}
const args = parseArgs(process.argv.slice(2))
const dryRun = !args.execute

const orgSlug = args.org as string
const email = args.email as string
const username = args.username as string
const password = args.password as string
const firstName = args.first as string
const lastName = args.last as string
const middleName = args.middle as string | undefined
const position = args.position as string | undefined
const role = (args.role as string) || 'admin'
const isActive = !args.inactive
const setOwner = !!args['set-owner']

const missing = ['org', 'email', 'username', 'password', 'first', 'last'].filter(k => !args[k])
if (missing.length) { console.error(`Missing required: ${missing.map(m => '--' + m).join(', ')}. See header for options.`); process.exit(2) }
if (!ROLES.includes(role as any)) { console.error(`Invalid role "${role}". Valid: ${ROLES.join(', ')}`); process.exit(2) }

async function main() {
  console.log(`Mode: ${dryRun ? 'DRY RUN' : 'EXECUTE'}`)
  console.log(`Org: ${orgSlug} | user: ${username} <${email}> | role: ${role} | active: ${isActive} | setOwner: ${setOwner}`)
  console.log(`Permissions (${role}): ${(DEFAULT_ROLE_PERMISSIONS as any)[role].join(', ')}`)
  console.log(`Permission set: ${ROLE_TO_PERMISSION_SET[role] || '(none)'}`)
  console.log()

  if (dryRun) { console.log('Dry run complete. Add --execute to write.'); return }

  await connectDB()
  console.log('Connected to MongoDB')

  const org = await Org.findOne({ slug: orgSlug })
  if (!org) { console.error(`Org "${orgSlug}" not found.`); process.exit(1) }

  const repos = await createMongoRepositories({ backend: 'mongo' })
  await seedDefaultPermissionSets(String(org._id), repos)
  const permSet = ROLE_TO_PERMISSION_SET[role]
    ? await PermissionSet.findOne({ orgId: org._id, name: ROLE_TO_PERMISSION_SET[role] })
    : null

  let user = await User.findOne({ orgId: org._id, $or: [{ username }, { email }] })
  if (user) {
    console.log(`User already exists: ${user.username} <${user.email}> (role ${user.role}) — leaving credentials untouched.`)
    if (permSet && (!user.permissionSetIds || user.permissionSetIds.length === 0)) {
      user.permissionSetIds = [permSet._id]
      await user.save()
      console.log(`  linked missing permission set: ${permSet.name}`)
    }
  } else {
    const hashedPassword = await Bun.password.hash(password)
    const opSeq = await Sequence.findOneAndUpdate(
      { orgId: org._id, prefix: 'OPERATOR', year: 0 },
      { $inc: { lastNumber: 1 } },
      { upsert: true, returnDocument: 'after' },
    ).exec()
    const operatorCode = String(opSeq!.lastNumber).padStart(4, '0')

    user = await User.create({
      email, username, password: hashedPassword,
      firstName, middleName, lastName, position,
      role, operatorCode, orgId: org._id, isActive,
      permissions: (DEFAULT_ROLE_PERMISSIONS as any)[role],
      roleHistory: [{ role, startDate: new Date(), assignedAt: new Date() }],
      permissionSetIds: permSet ? [permSet._id] : [],
    })
    console.log(`User created: ${username} (operator ${operatorCode}, role ${role}, permission set ${permSet?.name || '(none)'})`)
  }

  if (setOwner && !org.ownerId) {
    org.ownerId = user._id
    await org.save()
    console.log(`Org owner set to ${username}`)
  }

  console.log(`\nDone. Login: ${orgSlug} / ${username} / <password>`)
}

await main()
await disconnectDB()
