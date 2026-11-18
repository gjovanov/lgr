import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { createTestOrg } from '../helpers/factories'
import { mongoose } from 'db/connection'
import { Invite, User } from 'db/models'
import { USER_PUBLIC_PROJECTION, publicUser } from 'services/dao/user.dao'
import { MIGRATIONS } from 'migrations/registry'
import { legacyAccessArchive, SETS_ARCHIVE } from 'migrations/migrations/0017-legacy-access-archive'

/**
 * FR-27 P3-7 (#529): migration 0017, the data contract. The legacy access fields leave the live documents for an
 * archive beside them: `User.role` / `permissions` / `permissionSetIds` and `Invite.assignRole` into `legacyArchive`,
 * the permission sets into `permissionsets_archive`.
 *
 * Over the shapes a membership has on production: none of the fields, all of them, some of them, an empty list; an
 * invite with and without `assignRole`; two orgs, of which the node's scope takes one. The archive holds exactly what
 * was there, and a second run changes nothing.
 *
 * NOTE: no `.rejects` / `.resolves` (Bun-on-Windows deadlock, see Known Issues).
 */

beforeAll(async () => { await setupTestDB() }, 60_000)
afterAll(async () => { await teardownTestDB() }, 60_000)
afterEach(async () => { await clearCollections() })

const { Types } = mongoose
const db = () => mongoose.connection.db!
const ctx = (orgFilter: Record<string, unknown> = {}) => ({ db: db(), log: () => {}, orgFilter })
const raw = (coll: string, _id: unknown) => db().collection(coll).findOne({ _id: _id as any }) as Promise<any>

/** Every document of the collections 0017 touches, as comparable text. */
async function snapshot(): Promise<string> {
  const out: string[] = []
  for (const c of ['users', 'invites', 'permissionsets', SETS_ARCHIVE]) {
    out.push(`${c}:${JSON.stringify(await db().collection(c).find({}).sort({ _id: 1 }).toArray())}`)
  }
  return out.join('\n')
}

let seq = 0
const person = (orgId: unknown, extra: Record<string, unknown>) => ({
  _id: new Types.ObjectId(), orgId, email: `p${++seq}@archive.test`, username: `p${seq}`, firstName: 'P', lastName: String(seq),
  isActive: true, roleId: new Types.ObjectId(), ...extra,
})

async function world() {
  const a = await createTestOrg({ slug: 'archive-a' } as any)
  const b = await createTestOrg({ slug: 'archive-b' } as any)
  const [setA1, setA2, setB] = [new Types.ObjectId(), new Types.ObjectId(), new Types.ObjectId()]
  await db().collection('permissionsets').insertMany([
    { _id: setA1, orgId: a._id, name: 'Seller', permissions: ['invoicing.read', 'pos.write'], areas: [], isSystem: true },
    { _id: setA2, orgId: a._id, name: 'Orders', permissions: ['invoicing.read'], areas: ['orders'], ownRecordsOnly: { invoicing: true } },
    { _id: setB, orgId: b._id, name: 'Other org', permissions: ['accounting.read'] },
  ] as any[])
  const users = {
    none: person(a._id, {}),
    all: person(a._id, { role: 'manager', permissions: ['inventory.write', 'invoicing.read'], permissionSetIds: [setA1, setA2] }),
    roleOnly: person(a._id, { role: 'seller' }),
    emptyLists: person(a._id, { role: 'member', permissions: [], permissionSetIds: [] }),
    otherOrg: person(b._id, { role: 'admin', permissions: ['accounting.read'], permissionSetIds: [setB] }),
  }
  await db().collection('users').insertMany(Object.values(users) as any[])
  const invites = {
    withRole: { _id: new Types.ObjectId(), code: 'inv-role', orgId: a._id, inviterId: users.all._id, status: 'active', useCount: 0, assignRole: 'warehouse_manager', assignRoleId: new Types.ObjectId() },
    withoutRole: { _id: new Types.ObjectId(), code: 'inv-none', orgId: a._id, inviterId: users.all._id, status: 'active', useCount: 0, assignRoleId: new Types.ObjectId() },
    otherOrg: { _id: new Types.ObjectId(), code: 'inv-other', orgId: b._id, inviterId: users.otherOrg._id, status: 'active', useCount: 0, assignRole: 'member' },
  }
  await db().collection('invites').insertMany(Object.values(invites) as any[])
  return { a, b, users, invites, sets: { setA1, setA2, setB } }
}

describe('0017-legacy-access-archive (FR-27 P3-7)', () => {
  it('is registered after 0016', () => {
    const ids = MIGRATIONS.map(m => m.id)
    expect(ids.indexOf('0017-legacy-access-archive')).toBe(ids.indexOf('0016-drop-unread-text-indexes') + 1)
  })

  it('a person with every legacy field: each moves into the archive as it was, and is unset', async () => {
    const w = await world()
    const before = await raw('users', w.users.all._id)
    await legacyAccessArchive.up(ctx())
    const after = await raw('users', w.users.all._id)
    expect(after.role).toBeUndefined()
    expect(after.permissions).toBeUndefined()
    expect(after.permissionSetIds).toBeUndefined()
    expect(after.legacyArchive).toEqual({
      role: 'manager', permissions: ['inventory.write', 'invoicing.read'], permissionSetIds: [w.sets.setA1, w.sets.setA2], archivedAt: expect.any(Date),
    })
    // Nothing else moved: the archive and the three fields are the only difference.
    const { legacyArchive: _archive, ...rest } = after
    const { role: _r, permissions: _p, permissionSetIds: _s, ...kept } = before
    expect(rest).toEqual(kept)
  })

  it('the archive holds exactly what was there: a missing field stays missing, an empty list stays empty', async () => {
    const w = await world()
    await legacyAccessArchive.up(ctx())
    const roleOnly = await raw('users', w.users.roleOnly._id)
    expect(roleOnly.legacyArchive).toEqual({ role: 'seller', archivedAt: expect.any(Date) })
    expect(Object.keys(roleOnly.legacyArchive).sort()).toEqual(['archivedAt', 'role'])
    expect((await raw('users', w.users.emptyLists._id)).legacyArchive).toEqual({ role: 'member', permissions: [], permissionSetIds: [], archivedAt: expect.any(Date) })
  })

  it('a person with none of the fields is left as they are, with no archive', async () => {
    const w = await world()
    const before = await raw('users', w.users.none._id)
    await legacyAccessArchive.up(ctx())
    expect(await raw('users', w.users.none._id)).toEqual(before)
  })

  it('an invite: assignRole moves into its archive; one without is left alone, and assignRoleId stays', async () => {
    const w = await world()
    const without = await raw('invites', w.invites.withoutRole._id)
    await legacyAccessArchive.up(ctx())
    const withRole = await raw('invites', w.invites.withRole._id)
    expect(withRole.assignRole).toBeUndefined()
    expect(withRole.legacyArchive).toEqual({ assignRole: 'warehouse_manager', archivedAt: expect.any(Date) })
    expect(String(withRole.assignRoleId)).toBe(String(w.invites.withRole.assignRoleId))
    expect(await raw('invites', w.invites.withoutRole._id)).toEqual(without)
  })

  it('the permission sets are copied whole, with when, and the sets themselves stay', async () => {
    const w = await world()
    const sets = await db().collection('permissionsets').find({}).sort({ _id: 1 }).toArray()
    await legacyAccessArchive.up(ctx())
    expect(await db().collection('permissionsets').find({}).sort({ _id: 1 }).toArray()).toEqual(sets)
    const archived = await db().collection(SETS_ARCHIVE).find({}).sort({ _id: 1 }).toArray()
    expect(archived.map(({ archivedAt, ...s }) => { expect(archivedAt).toBeInstanceOf(Date); return s })).toEqual(sets)
    expect((archived.find(s => String(s._id) === String(w.sets.setA2)) as any).ownRecordsOnly).toEqual({ invoicing: true })
  })

  it('every document of one run carries the same moment', async () => {
    const w = await world()
    await legacyAccessArchive.up(ctx())
    const at = (await raw('users', w.users.all._id)).legacyArchive.archivedAt.getTime()
    expect((await raw('users', w.users.otherOrg._id)).legacyArchive.archivedAt.getTime()).toBe(at)
    expect((await raw('invites', w.invites.withRole._id)).legacyArchive.archivedAt.getTime()).toBe(at)
    expect((await raw(SETS_ARCHIVE, w.sets.setB)).archivedAt.getTime()).toBe(at)
  })

  it('takes only the orgs homed on this node: the other org\'s people, invites and sets are untouched', async () => {
    const w = await world()
    const theirs = {
      user: await raw('users', w.users.otherOrg._id),
      invite: await raw('invites', w.invites.otherOrg._id),
    }
    await legacyAccessArchive.up(ctx({ orgId: w.a._id }))
    expect((await raw('users', w.users.all._id)).legacyArchive).toBeDefined()
    expect(await raw('users', w.users.otherOrg._id)).toEqual(theirs.user)
    expect(await raw('invites', w.invites.otherOrg._id)).toEqual(theirs.invite)
    expect((await db().collection(SETS_ARCHIVE).find({}).toArray()).map(s => String(s._id)).sort())
      .toEqual([String(w.sets.setA1), String(w.sets.setA2)].sort())

    // The scope as `homeScope()` writes it once an org lives elsewhere: everything but that org.
    await legacyAccessArchive.up(ctx({ orgId: { $nin: [w.a._id] } }))
    expect((await raw('users', w.users.otherOrg._id)).legacyArchive.role).toBe('admin')
    expect((await raw('invites', w.invites.otherOrg._id)).legacyArchive.assignRole).toBe('member')
    expect(await db().collection(SETS_ARCHIVE).countDocuments({})).toBe(3)
  })

  it('a second run changes nothing', async () => {
    await world()
    await legacyAccessArchive.up(ctx())
    const once = await snapshot()
    await legacyAccessArchive.up(ctx())
    expect(await snapshot()).toBe(once)
    expect(await legacyAccessArchive.preview!(ctx() as any)).toEqual(['nothing to change'])
  })

  it('a field written back after the run (a schema default) is unset again, and the first archive is kept', async () => {
    const w = await world()
    await legacyAccessArchive.up(ctx())
    const first = (await raw('users', w.users.all._id)).legacyArchive
    await db().collection('users').updateOne({ _id: w.users.all._id }, { $set: { role: 'member', permissions: [] } })
    await legacyAccessArchive.up(ctx())
    const after = await raw('users', w.users.all._id)
    expect(after.role).toBeUndefined()
    expect(after.permissions).toBeUndefined()
    expect(after.legacyArchive).toEqual(first)
  })

  it('a dry run says what it would do, and writes nothing', async () => {
    const w = await world()
    const before = await snapshot()
    expect(await legacyAccessArchive.preview!(ctx() as any)).toEqual([
      'users: 4 to archive (role, permissions, permissionSetIds) and unset',
      'invites: 2 to archive (assignRole) and unset',
      `permissionsets: 3 to copy into ${SETS_ARCHIVE} (the sets stay)`,
    ])
    expect(await legacyAccessArchive.preview!(ctx({ orgId: w.b._id }) as any)).toEqual([
      'users: 1 to archive (role, permissions, permissionSetIds) and unset',
      'invites: 1 to archive (assignRole) and unset',
      `permissionsets: 1 to copy into ${SETS_ARCHIVE} (the sets stay)`,
    ])
    expect(await snapshot()).toBe(before)
    expect(await db().collection(SETS_ARCHIVE).countDocuments({})).toBe(0)
  })

  it('an empty database: nothing to do, and nothing breaks', async () => {
    expect(await legacyAccessArchive.preview!(ctx() as any)).toEqual(['nothing to change'])
    await legacyAccessArchive.up(ctx())
  })

  it('the models name none of it (FR-27 P3-9), and a user leaves the server without the archive', async () => {
    const w = await world()
    await legacyAccessArchive.up(ctx())
    // The archive is the database's, read through the driver; no schema path names it or the fields since P3-9.
    for (const path of ['legacyArchive', 'role', 'permissions', 'permissionSetIds']) expect({ path, model: User.schema.path(path) }).toEqual({ path, model: undefined })
    for (const path of ['legacyArchive', 'assignRole']) expect({ path, model: Invite.schema.path(path) }).toEqual({ path, model: undefined })
    expect((await raw('users', w.users.all._id)).legacyArchive.role).toBe('manager')

    const projected: any = await User.findById(w.users.all._id).select(USER_PUBLIC_PROJECTION).lean().exec()
    expect(projected.legacyArchive).toBeUndefined()
    expect(projected.email).toBe(w.users.all.email)
    expect(publicUser((await User.findById(w.users.all._id).lean().exec()) as any).legacyArchive).toBeUndefined()
  })
})
