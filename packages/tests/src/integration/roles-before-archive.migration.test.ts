import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { mongoose } from 'db/connection'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { captureRejection } from '../helpers/capture-rejection'
import { createTestOrg, createTestUser } from '../helpers/factories'
import { Identity, Role, User } from 'db/models'
import { DEFAULT_ROLE_PERMISSIONS, type Role as RoleKey } from 'config/constants'
import { compileLegacy, grantOfRole, legacyClaimsOf, sameGrant } from 'config/access'
import { login, register } from 'services/biz/auth.service'
import { MIGRATIONS } from 'migrations/registry'
import { rolesFromSets } from 'migrations/migrations/0015-roles-from-sets'
import { rolesBeforeTheArchive } from 'migrations/migrations/0016-roles-before-the-archive'

/**
 * FR-27 (#529), FR-20.20: migration 0016-roles-before-the-archive. A master on server 0.1.12 ran 0015 once, at its first
 * start, and gives no role to anyone it makes after it; its update then runs 0017 and 0020, which archive and drop the
 * legacy access of everyone, in that one start. The gate's master update lanes signed in to `no_role` after it.
 *
 * Over the shapes such a master holds: an org founded on it (no roles at all), people added to an org 0015 gave roles,
 * a document with legacy permissions and no `role` (read as the schema's default, as 0.1.12 served it), invitations
 * naming a legacy role, a person left without a role on purpose, an org out of the node's scope, and lgrai.app after
 * 0020. Each person's role is the one 0015 gives the same person, and grants what their token did.
 *
 * NOTE: no `.rejects` / `.resolves` (Bun-on-Windows deadlock, see Known Issues).
 */

beforeAll(async () => { await setupTestDB() }, 60_000)
afterAll(async () => { await teardownTestDB() }, 60_000)
afterEach(async () => { await clearCollections() })

const { Types } = mongoose
const db = () => mongoose.connection.db!
const scoped = (orgId?: unknown) => ({ db: db() as any, log: () => {}, orgFilter: orgId ? { orgId } : {} })
const raw = (coll: string, filter: Record<string, unknown>) => db().collection(coll).findOne(filter as any) as Promise<any>

/** The system sets an org was seeded with before FR-27 P3-6, written raw: sets have no model, 0015 reads them so. */
const SYSTEM_SETS: Array<[string, RoleKey]> = [
  ['Administrator', 'admin'], ['Manager', 'manager'], ['Accountant', 'accountant'], ['Warehouse Manager', 'warehouse_manager'],
  ['Seller', 'seller'], ['Sales Consultant', 'sales_consultant'], ['Member (Read Only)', 'member'], ['NRA Auditor (Read Only)', 'nra_auditor'],
]
async function seedLegacySets(orgId: unknown) {
  await db().collection('permissionsets').insertMany(SYSTEM_SETS.map(([name, role]) => ({
    _id: new Types.ObjectId(), orgId, name, permissions: [...DEFAULT_ROLE_PERMISSIONS[role]], isSystem: true,
    isAdmin: role === 'admin', isDefault: role === 'member',
    ...(role === 'seller' ? { areas: [] } : role === 'sales_consultant' ? { areas: ['orders'] } : {}),
  })) as any[])
}

/** An org with legacy sets and one person per stored shape 0015's own suite names, each with their legacy fields. */
async function legacyOrg(slug: string) {
  const org = await createTestOrg({ slug } as any)
  await seedLegacySets(org._id)
  const ids = async (...names: string[]) =>
    (await Promise.all(names.map(n => db().collection('permissionsets').findOne({ orgId: org._id, name: n })))).map((s: any) => s._id)
  const people: Record<string, any> = {}
  const make = async (key: string, legacy: Record<string, unknown>) => {
    people[key] = await createTestUser(org._id, { email: `${key}.${slug}@before-archive.test`, username: `${key}-${slug}`, ...legacy } as any)
  }
  await make('member', { role: 'member' })
  await make('seller', { role: 'seller', permissionSetIds: await ids('Seller') })
  await make('sellerNoSet', { role: 'seller' })
  await make('manager', { role: 'manager', permissionSetIds: await ids('Manager') })
  await make('twoSets', { role: 'accountant', permissionSetIds: await ids('Accountant', 'Warehouse Manager') })
  await make('twoSetsManager', { role: 'manager', permissionSetIds: await ids('Accountant', 'Warehouse Manager') })
  await make('adminSetOnMember', { role: 'member', permissionSetIds: await ids('Administrator') })
  await make('admin', { role: 'admin', permissionSetIds: await ids('Member (Read Only)') })
  await make('extras', { role: 'member', permissions: ['inventory.write'] })
  return { org, people }
}

/** What a 0.1.12 master holds for an org founded on it: its people's legacy fields, no role anywhere. */
async function foundedOn0112(orgId: unknown) {
  await Role.deleteMany({ orgId }).exec()
  await User.collection.updateMany({ orgId: orgId as any }, { $unset: { roleId: 1 } })
}

/**
 * A person a 0.1.12 master made after its first start: their legacy fields and no role. The `roleId` named keeps the
 * factory from running 0015 for them (it would give a role to everyone in the org without one), and is then taken off.
 */
async function madeOn0112(orgId: unknown, overrides: Record<string, unknown>) {
  const person = await createTestUser(orgId as any, { ...overrides, roleId: new Types.ObjectId() } as any)
  await User.collection.updateOne({ _id: person._id }, { $unset: { roleId: 1 } })
  return person
}

async function roleOf(userId: unknown) {
  const u = await raw('users', { _id: userId })
  return u?.roleId ? raw('roles', { _id: u.roleId }) : null
}

/** A role as it decides access: everything but the legacy projection 0015 also wrote, which nothing reads. */
const shape = (r: any) => r && ({ name: r.name, isBuiltin: !!r.isBuiltin, templateKey: r.templateKey ?? null, all: !!r.all, caps: [...(r.caps ?? [])].sort() })

/** What the person's token granted on 0.1.12: their legacy fields, read as `tokenize()` read them (0015's oracle). */
async function legacyGrantOf(userId: unknown) {
  const u = await raw('users', { _id: userId })
  const sets = u.permissionSetIds?.length ? await db().collection('permissionsets').find({ _id: { $in: u.permissionSetIds }, orgId: u.orgId }).toArray() : []
  return compileLegacy(legacyClaimsOf({ role: u.role ?? 'member', permissions: u.permissions }, sets as any))
}

async function snapshot(): Promise<string> {
  const out: string[] = []
  for (const c of ['users', 'invites', 'roles']) out.push(`${c}:${JSON.stringify(await db().collection(c).find({}).sort({ _id: 1 }).toArray())}`)
  return out.join('\n')
}

const invite = (orgId: unknown, inviterId: unknown, extra: Record<string, unknown>) => ({
  _id: new Types.ObjectId(), code: `inv-${new Types.ObjectId()}`, orgId, inviterId, status: 'active', useCount: 0, ...extra,
})

describe('migration 0016-roles-before-the-archive', () => {
  it('in an org founded on 0.1.12, every person gets the role 0015 gives the same person, and it grants what their token did', async () => {
    const oracle = await legacyOrg('before-archive-0015')
    const subject = await legacyOrg('before-archive-0016')
    await foundedOn0112(oracle.org._id)
    await foundedOn0112(subject.org._id)

    const preview = await rolesBeforeTheArchive.preview!(scoped(subject.org._id))
    expect(preview[0]).toStartWith('before-archive-0016: 10 built-in role(s) to create')
    expect(preview.filter(l => /differences: [1-9]/.test(l))).toEqual([])
    expect(await Role.countDocuments({ orgId: subject.org._id }).exec()).toBe(0)

    await rolesFromSets.up(scoped(oracle.org._id))
    await rolesBeforeTheArchive.up(scoped(subject.org._id))

    for (const key of Object.keys(subject.people)) {
      const role = await roleOf(subject.people[key]._id)
      expect({ key, role: shape(role) }).toEqual({ key, role: shape(await roleOf(oracle.people[key]._id)) })
      expect({ key, same: sameGrant(grantOfRole(role), await legacyGrantOf(subject.people[key]._id)) }).toEqual({ key, same: true })
    }
    expect((await roleOf(subject.people.admin._id))).toMatchObject({ templateKey: 'admin', all: true })
    expect(await Role.countDocuments({ orgId: subject.org._id, isBuiltin: true }).exec()).toBe(10)
  })

  it('people added to an org that 0015 gave roles get one, its own roles reused; who has one keeps it', async () => {
    const { org, people } = await legacyOrg('before-archive-added')
    const roles = await Role.countDocuments({ orgId: org._id }).exec()
    const kept = String((await raw('users', { _id: people.manager._id })).roleId)
    // Made on 0.1.12, after its first start: their legacy fields, no role. `permissionsOnly` has no `role` at all, which
    // 0.1.12 served as its schema's default, `member`: their access is `extras`'s, so their role is too.
    const seller = await madeOn0112(org._id, { email: 'new-seller@before-archive.test', username: 'new-seller', role: 'seller' })
    const extras = await madeOn0112(org._id, { email: 'new-extras@before-archive.test', username: 'new-extras', role: 'member', permissions: ['inventory.write'] })
    const permissionsOnly = await madeOn0112(org._id, { email: 'perm-only@before-archive.test', username: 'perm-only', role: undefined, permissions: ['inventory.write'] })
    expect((await raw('users', { _id: permissionsOnly._id })).role).toBeUndefined()
    expect(await Role.countDocuments({ orgId: org._id }).exec()).toBe(roles)

    await rolesBeforeTheArchive.up(scoped(org._id))

    expect(await Role.countDocuments({ orgId: org._id }).exec()).toBe(roles)
    expect(String((await roleOf(seller._id))._id)).toBe(String((await roleOf(people.sellerNoSet._id))._id))
    expect(String((await roleOf(extras._id))._id)).toBe(String((await roleOf(people.extras._id))._id))
    expect(String((await roleOf(permissionsOnly._id))._id)).toBe(String((await roleOf(people.extras._id))._id))
    expect(String((await raw('users', { _id: people.manager._id })).roleId)).toBe(kept)
  })

  it('leaves alone a person without a role and without legacy fields, an org out of scope, and lgrai.app after 0020', async () => {
    const here = await createTestOrg({ slug: 'before-archive-here' } as any)
    const away = await createTestOrg({ slug: 'before-archive-away' } as any)
    const cloud = await createTestOrg({ slug: 'before-archive-cloud' } as any)
    const founder = await createTestUser(here._id, { email: 'f@before-archive.test', username: 'f', role: 'admin' } as any)
    const onPurpose = await createTestUser(here._id, { email: 'np@before-archive.test', username: 'np' } as any)
    const elsewhere = await createTestUser(away._id, { email: 'e@before-archive.test', username: 'e', role: 'admin' } as any)
    const cloudPerson = await createTestUser(cloud._id, { email: 'c@before-archive.test', username: 'c', role: 'member' } as any)
    const cloudNone = await createTestUser(cloud._id, { email: 'cn@before-archive.test', username: 'cn' } as any)
    await foundedOn0112(here._id)
    await foundedOn0112(away._id)
    // Left without a role on purpose, on the node it came from: no role, no legacy field.
    await User.collection.updateOne({ _id: onPurpose._id }, { $unset: { role: 1, permissions: 1, permissionSetIds: 1 } })
    // lgrai.app after 0020: roles everywhere, no legacy field on anyone; one person without a role on purpose.
    await User.collection.updateMany({ orgId: cloud._id }, { $unset: { role: 1, permissions: 1, permissionSetIds: 1 } })
    await User.collection.updateOne({ _id: cloudNone._id }, { $unset: { roleId: 1 } })
    const cloudBefore = JSON.stringify(await db().collection('roles').find({ orgId: cloud._id }).sort({ _id: 1 }).toArray())

    expect(await rolesBeforeTheArchive.preview!(scoped(cloud._id))).toEqual(['nothing to change'])
    await rolesBeforeTheArchive.up(scoped(here._id))
    await rolesBeforeTheArchive.up(scoped(cloud._id))

    expect((await roleOf(founder._id))).toMatchObject({ templateKey: 'admin', all: true })
    expect((await raw('users', { _id: onPurpose._id })).roleId).toBeUndefined()
    expect(await Role.countDocuments({ orgId: here._id, name: /undefined/ }).exec()).toBe(0)
    expect((await raw('users', { _id: elsewhere._id })).roleId).toBeUndefined()
    expect(await Role.countDocuments({ orgId: away._id }).exec()).toBe(0)
    expect((await raw('users', { _id: cloudNone._id })).roleId).toBeUndefined()
    expect((await raw('users', { _id: cloudPerson._id })).roleId).toBeDefined()
    expect(JSON.stringify(await db().collection('roles').find({ orgId: cloud._id }).sort({ _id: 1 }).toArray())).toBe(cloudBefore)
  })

  it('an invitation naming a legacy role gets that built-in role by id; one with an id keeps it; an unknown key is left', async () => {
    const founded = await createTestOrg({ slug: 'before-archive-invites' } as any)
    const founder = await createTestUser(founded._id, { email: 'fi@before-archive.test', username: 'fi', role: 'admin' } as any)
    // An org 0015 gave roles, whose only gap is an invitation made on 0.1.12.
    const older = await createTestOrg({ slug: 'before-archive-older' } as any)
    const olderAdmin = await createTestUser(older._id, { email: 'oa@before-archive.test', username: 'oa', role: 'admin' } as any)
    await foundedOn0112(founded._id)
    const named = new Types.ObjectId()
    const invites = {
      accountant: invite(founded._id, founder._id, { assignRole: 'accountant' }),
      admin: invite(founded._id, founder._id, { assignRole: 'admin' }),
      withId: invite(founded._id, founder._id, { assignRole: 'member', assignRoleId: named }),
      unknown: invite(founded._id, founder._id, { assignRole: 'chief' }),
      older: invite(older._id, olderAdmin._id, { assignRole: 'seller' }),
    }
    await db().collection('invites').insertMany(Object.values(invites) as any[])

    await rolesBeforeTheArchive.up(scoped())

    const builtin = async (orgId: unknown, key: string) => String((await raw('roles', { orgId, isBuiltin: true, templateKey: key }))._id)
    const roleIdOf = async (inv: { _id: unknown }) => (await raw('invites', { _id: inv._id })).assignRoleId
    expect(String(await roleIdOf(invites.accountant))).toBe(await builtin(founded._id, 'accountant'))
    expect(String(await roleIdOf(invites.admin))).toBe(await builtin(founded._id, 'admin'))
    expect(String(await roleIdOf(invites.withId))).toBe(String(named))
    expect(await roleIdOf(invites.unknown)).toBeUndefined()
    expect(String(await roleIdOf(invites.older))).toBe(await builtin(older._id, 'seller'))
  })

  it('a second run changes nothing', async () => {
    const { org } = await legacyOrg('before-archive-twice')
    await foundedOn0112(org._id)
    const founder = await madeOn0112(org._id, { email: 'ft@before-archive.test', username: 'ft', role: 'admin' })
    await db().collection('invites').insertOne(invite(org._id, founder._id, { assignRole: 'manager' }) as any)

    await rolesBeforeTheArchive.up(scoped())
    const once = await snapshot()
    await rolesBeforeTheArchive.up(scoped())
    expect(await snapshot()).toBe(once)
    expect(await rolesBeforeTheArchive.preview!(scoped())).toEqual(['nothing to change'])
  })
})

/** What the registration link does, as a test shortcut: the membership and its person go live. */
async function activate(user: { _id: unknown; identityId?: unknown }) {
  await User.findByIdAndUpdate(user._id, { isActive: true }).exec()
  if (user.identityId) await Identity.updateOne({ _id: user.identityId }, { $set: { isActive: true, emailVerified: true } }).exec()
}

/** An org founded on 0.1.12 through its registration: the founder's legacy `admin`, no role in the org. */
async function registeredOn0112(slug: string) {
  const { user, org } = await register({
    orgName: `Founded ${slug}`, orgSlug: slug, email: `${slug}@before-archive.test`, username: `${slug}-admin`, password: 'secure123',
    firstName: 'Founder', lastName: 'Admin',
  })
  await activate(user as any)
  await foundedOn0112(org._id)
  await User.collection.updateOne({ _id: (user as any)._id }, { $set: { role: 'admin', permissions: [...DEFAULT_ROLE_PERMISSIONS.admin] } })
  return { user: user as any, org: org as any }
}

// Last in the file: the tail drops indexes (0016, 0019, 0022), which the next file's `syncIndexes()` builds again.
describe('the update from 0.1.12: every migration after 0015, as a master runs them', () => {
  const tail = MIGRATIONS.slice(MIGRATIONS.findIndex(m => m.id === '0015-roles-from-sets') + 1)

  it('without it the founder is refused (no_role) after 0017 and 0020; with it they sign in as the Administrator', async () => {
    expect(tail[0].id).toBe('0016-drop-unread-text-indexes')
    expect(tail.map(m => m.id).indexOf(rolesBeforeTheArchive.id)).toBeLessThan(tail.map(m => m.id).indexOf('0017-legacy-access-archive'))
    const before = await registeredOn0112('before-archive-unfixed')
    const after = await registeredOn0112('before-archive-fixed')

    for (const m of tail.filter(m => m.id !== rolesBeforeTheArchive.id)) await m.up(scoped(before.org._id))
    const refused = await captureRejection(login({ username: 'before-archive-unfixed-admin', password: 'secure123', orgSlug: 'before-archive-unfixed' }))
    expect(refused).toBeTruthy()
    expect(refused.code).toBe('no_role')

    for (const m of tail) await m.up(scoped(after.org._id))
    const session = await login({ username: 'before-archive-fixed-admin', password: 'secure123', orgSlug: 'before-archive-fixed' })
    const administrator = await raw('roles', { orgId: after.org._id, isBuiltin: true, templateKey: 'admin' })
    expect(String((session.user as any).rid)).toBe(String(administrator._id))
    // 0017 and 0020 did their part: the legacy access is gone, the role stays.
    const stored = await raw('users', { _id: after.user._id })
    expect({ role: stored.role, permissions: stored.permissions, archive: stored.legacyArchive }).toEqual({ role: undefined, permissions: undefined, archive: undefined })
    expect(String(stored.roleId)).toBe(String(administrator._id))
  }, 60_000)
})
