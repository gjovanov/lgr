/**
 * Seed a user into an existing org, fully wired for SUPTO + RBAC:
 *   - password hashed with Bun.password.hash
 *   - operatorCode allocated atomically (SUPTO — every user needs one)
 *   - its FR-27 role (#529) and the role history entry that records it (id and name): the built-in role of `--role`,
 *     or, for a service account, a role of its own holding exactly what it runs ("Service: <username>").
 *   - FR-27 P3-5: nothing of the legacy model (no legacy role key, permissions or permission sets) is written.
 *
 * Idempotent: if a user with the username or email already exists in the org it
 * is reported and left untouched (a missing role is given).
 *
 * Usage:
 *   bun run scripts/seed-user.ts --org <slug> --email <e> --username <u> --password <p> --first <F> --last <L>            # dry-run
 *   bun run scripts/seed-user.ts --org regal-pz --email ann.doe@example.com --username anndoe --password "$INITIAL_PASSWORD" \
 *       --first Ann --last Doe --role admin --execute
 *
 * ⚠ Never paste a real password into this header, a skill or a commit message; pass it from the
 * environment. A real one sat in this example until 2026-10-05.
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
 *   --caps <a,b>     a SERVICE account: instead of a built-in role, a role of its own holding exactly these
 *                    capabilities (`config/access` catalogue), created if missing. A role of that name with other
 *                    capabilities is refused, never reused.
 *   --permissions <a,b>  the same, named by legacy permissions (as before FR-27): what those permissions gave a
 *                    session opening no area (`compileLegacy`), e.g. `accounting.import` = `books-import.run`.
 *   --set-name <n>   the name of that role (default: "Service: <username>")
 *   --execute        perform writes (default: dry-run)
 */
import { connectDB, disconnectDB } from '../packages/db/src/connection.js'
import { assertScriptHome } from './lib/home-guard.js'
import { requireUniqueIndexes } from './lib/require-indexes.js'
import { Identity, Org, User, Role, Sequence } from '../packages/db/src/models/index.js'
import { PERMISSIONS, ROLES } from '../packages/config/src/constants.js'
import { compileLegacy, isCapability, withImplied, type CapabilityId } from '../packages/config/src/access/index.js'
import { allocateOperatorCode } from '../packages/services/src/biz/sequence.service.js'
import { discardIdentity, identityForOperatorJoin } from '../packages/services/src/biz/identity/identity.service.js'
import { giveStartingRole, seedBuiltinRoles } from '../packages/services/src/biz/access/role.service.js'

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
const roleKey = (args.role as string) || 'admin'
const isActive = !args.inactive
const setOwner = !!args['set-owner']
const list = (v: unknown) => (typeof v === 'string' ? v.split(',').map(p => p.trim()).filter(Boolean) : null)
const servicePermissions = list(args.permissions)
const serviceCapsNamed = list(args.caps)
const serviceSetName = (args['set-name'] as string) || `Service: ${username}`

const missing = ['org', 'email', 'username', 'password', 'first', 'last'].filter(k => !args[k])
if (missing.length) { console.error(`Missing required: ${missing.map(m => '--' + m).join(', ')}. See header for options.`); process.exit(2) }
if (!ROLES.includes(roleKey as any)) { console.error(`Invalid role "${roleKey}". Valid: ${ROLES.join(', ')}`); process.exit(2) }
if (args.permissions !== undefined && !servicePermissions?.length) { console.error('--permissions takes a comma-separated list.'); process.exit(2) }
if (args.caps !== undefined && !serviceCapsNamed?.length) { console.error('--caps takes a comma-separated list.'); process.exit(2) }
if (servicePermissions && serviceCapsNamed) { console.error('Name --caps or --permissions, not both.'); process.exit(2) }
const unknown = (servicePermissions ?? []).filter(p => !PERMISSIONS.includes(p as any))
if (unknown.length) { console.error(`Unknown permission(s): ${unknown.join(', ')}`); process.exit(2) }
const unknownCaps = (serviceCapsNamed ?? []).filter(c => !isCapability(c))
if (unknownCaps.length) { console.error(`Unknown capability(ies): ${unknownCaps.join(', ')}`); process.exit(2) }

/** A service account's capabilities: named, or what its legacy permissions gave a session opening no area. */
const serviceCaps: string[] | null = serviceCapsNamed
  ? withImplied(serviceCapsNamed as CapabilityId[]).sort()
  : servicePermissions
    ? (() => { const g = compileLegacy({ role: 'member', permissions: servicePermissions, areas: [] }); return g.all ? [] : [...g.caps].sort() })()
    : null

const sameCaps = (a: readonly string[], b: readonly string[]) => [...a].sort().join() === [...b].sort().join()

async function main() {
  console.log(`Mode: ${dryRun ? 'DRY RUN' : 'EXECUTE'}`)
  console.log(`Org: ${orgSlug} | user: ${username} <${email}> | role: ${roleKey} | active: ${isActive} | setOwner: ${setOwner}`)
  if (serviceCaps) console.log(`Role (service, "${serviceSetName}"): ${serviceCaps.join(', ')}`)
  else console.log(`Role: the built-in role "${roleKey}"`)
  console.log()

  if (dryRun) { console.log('Dry run complete. Add --execute to write.'); return }

  // Documents only: building indexes is the app's (scripts/lib/require-indexes.ts).
  await connectDB({ readOnly: true })
  console.log('Connected to MongoDB')
  await requireUniqueIndexes([User, Identity, Role, Sequence])

  const org = await Org.findOne({ slug: orgSlug })
  if (!org) { console.error(`Org "${orgSlug}" not found.`); process.exit(1) }
  await assertScriptHome(org._id, orgSlug)

  // FR-27 (#529): the role this person is given. A built-in one (made where an org lacks them), or the service
  // account's own, refused when one of that name holds anything else.
  await seedBuiltinRoles(org._id)
  let role: any
  if (serviceCaps) {
    role = await Role.findOne({ orgId: org._id, name: serviceSetName }).lean()
    if (role && (role.all || role.isBuiltin || !sameCaps(role.caps ?? [], serviceCaps))) {
      console.error(`Refused: the role "${serviceSetName}" exists with other capabilities. Name another with --set-name.`)
      process.exit(2)
    }
    role ??= (await Role.create({
      orgId: org._id, name: serviceSetName, description: `Service account ${username}: only what it runs.`,
      isBuiltin: false, edited: false, all: false, caps: serviceCaps, version: 1,
    })).toObject()
  } else {
    role = await Role.findOne({ orgId: org._id, isBuiltin: true, templateKey: roleKey }).lean()
  }
  if (!role) { console.error(`Org "${orgSlug}" has no role "${roleKey}".`); process.exit(1) }

  let user = await User.findOne({ orgId: org._id, $or: [{ username }, { email }] })
  if (user) {
    console.log(`User already exists: ${user.username} <${user.email}> — leaving credentials untouched.`)
  } else {
    const hashedPassword = await Bun.password.hash(password)
    // Multi-org: the person behind this membership. Someone who already has an account is linked as
    // they are: their password is theirs, so --password goes unused. Before the identity migration,
    // an address that still has unlinked users is left for the migration to group.
    const person = await identityForOperatorJoin({
      email,
      password: hashedPassword, // an operator-set password: the helper records who and where
      firstName, middleName, lastName, isActive,
    }, org._id)
    const operatorCode = await allocateOperatorCode(String(org._id))

    try {
      user = await User.create({
        email: person ? person.identity.email : email,
        username,
        // The legacy copy matches the person's own hash, so a rollback signs them in as before.
        password: person && !person.created ? person.identity.password : hashedPassword,
        identityId: person?.identity._id,
        firstName, middleName, lastName, position,
        operatorCode, orgId: org._id, isActive,
      })
    } catch (err) {
      if (person?.created) await discardIdentity(person.identity._id)
      throw err
    }
    console.log(`User created: ${username} (operator ${operatorCode})`)
    if (!person) console.log('  Not linked to a person yet: this address still has users the identity migration has not linked. It will group them.')
    else if (person.created) console.log(`  New person <${person.identity.email}>, password set by an operator (they change it before joining another org).`)
    else console.log(`  Linked to the existing person <${person.identity.email}>. Their password is unchanged; --password was not used.`)
  }

  // FR-27 (#529): the person's role, with its history entry (Appendix 29); one who already has a role keeps it.
  if (!user.roleId) {
    await giveStartingRole(org._id, user._id, { role, chosen: true })
    console.log(`  role: ${role.name}`)
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
