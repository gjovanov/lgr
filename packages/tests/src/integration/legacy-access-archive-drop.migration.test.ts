import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { createTestOrg } from '../helpers/factories'
import { mongoose } from 'db/connection'
import { MIGRATIONS } from 'migrations/registry'
import { legacyAccessArchive, SETS_ARCHIVE } from 'migrations/migrations/0017-legacy-access-archive'
import { legacyAccessArchiveDrop } from 'migrations/migrations/0020-legacy-access-archive-drop'

/**
 * FR-27 P3-9 (#529): migration 0020 drops the legacy access archive 0017 made: `legacyArchive` on users and invites,
 * and the permission sets, archived and live, of the orgs of this node. The two set collections are shared by every
 * org of a node, so one is dropped only when it is then empty.
 *
 * Over two orgs archived by 0017, of which the node's scope takes one, a person with a legacy field written back since
 * 0017, and the dry run. A second run changes nothing.
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
const SETS = 'permissionsets'
const collections = async () => (await db().listCollections({}, { nameOnly: true }).toArray()).map(c => c.name)

/** Every document of the collections 0020 touches, and which of them are there, as comparable text. */
async function snapshot(): Promise<string> {
  const here = await collections()
  const out: string[] = []
  for (const c of ['users', 'invites', SETS, SETS_ARCHIVE]) {
    out.push(`${c}:${here.includes(c)}:${JSON.stringify(await db().collection(c).find({}).sort({ _id: 1 }).toArray())}`)
  }
  return out.join('\n')
}

let seq = 0
const person = (orgId: unknown, extra: Record<string, unknown>) => ({
  _id: new Types.ObjectId(), orgId, email: `p${++seq}@drop.test`, username: `p${seq}`, firstName: 'P', lastName: String(seq),
  isActive: true, roleId: new Types.ObjectId(), ...extra,
})

/** Two orgs as production left them after 0017: people and invitations archived, every set copied and still live. */
async function world() {
  const a = await createTestOrg({ slug: `drop-a-${++seq}` } as any)
  const b = await createTestOrg({ slug: `drop-b-${++seq}` } as any)
  const [setA1, setA2, setB] = [new Types.ObjectId(), new Types.ObjectId(), new Types.ObjectId()]
  await db().collection(SETS).insertMany([
    { _id: setA1, orgId: a._id, name: 'Seller', permissions: ['invoicing.read'], isSystem: true },
    { _id: setA2, orgId: a._id, name: 'Orders', permissions: ['invoicing.read'], areas: ['orders'] },
    { _id: setB, orgId: b._id, name: 'Other org', permissions: ['accounting.read'] },
  ] as any[])
  const users = {
    archivedA: person(a._id, { role: 'manager', permissions: ['inventory.write'], permissionSetIds: [setA1, setA2] }),
    plainA: person(a._id, {}),
    archivedB: person(b._id, { role: 'admin', permissionSetIds: [setB] }),
  }
  await db().collection('users').insertMany(Object.values(users) as any[])
  const invites = {
    archivedA: { _id: new Types.ObjectId(), code: `drop-a-${seq}`, orgId: a._id, inviterId: users.archivedA._id, status: 'active', useCount: 0, assignRole: 'seller' },
    plainA: { _id: new Types.ObjectId(), code: `drop-plain-${seq}`, orgId: a._id, inviterId: users.archivedA._id, status: 'active', useCount: 0, assignRoleId: new Types.ObjectId() },
    archivedB: { _id: new Types.ObjectId(), code: `drop-b-${seq}`, orgId: b._id, inviterId: users.archivedB._id, status: 'active', useCount: 0, assignRole: 'member' },
  }
  await db().collection('invites').insertMany(Object.values(invites) as any[])
  await legacyAccessArchive.up(ctx())
  return { a, b, users, invites, sets: { setA1, setA2, setB } }
}

describe('0020-legacy-access-archive-drop (FR-27 P3-9)', () => {
  it('is registered last, after 0019', () => {
    const ids = MIGRATIONS.map(m => m.id)
    expect(ids.indexOf('0020-legacy-access-archive-drop')).toBe(ids.indexOf('0019-drop-unused-indexes') + 1)
    expect(ids.at(-1)).toBe('0020-legacy-access-archive-drop')
  })

  it('every org of the node: the archives are unset, the sets deleted, both collections dropped once empty', async () => {
    const w = await world()
    const kept = await raw('users', w.users.plainA._id)
    await legacyAccessArchiveDrop.up(ctx())
    for (const u of Object.values(w.users)) {
      const after = await raw('users', u._id)
      expect(after.legacyArchive).toBeUndefined()
      expect(['role', 'permissions', 'permissionSetIds'].filter(f => f in after)).toEqual([])
      expect(String(after.roleId)).toBe(String(u.roleId))
    }
    expect(await raw('users', w.users.plainA._id)).toEqual(kept)
    for (const i of Object.values(w.invites)) {
      const after = await raw('invites', i._id)
      expect('legacyArchive' in after || 'assignRole' in after).toBe(false)
    }
    expect(String((await raw('invites', w.invites.plainA._id)).assignRoleId)).toBe(String(w.invites.plainA.assignRoleId))
    const here = await collections()
    expect([here.includes(SETS), here.includes(SETS_ARCHIVE)]).toEqual([false, false])
  })

  it("one org of the node: its archives and sets go; the other org's are untouched, and the collections stay", async () => {
    const w = await world()
    const theirs = {
      user: await raw('users', w.users.archivedB._id),
      invite: await raw('invites', w.invites.archivedB._id),
      set: await raw(SETS, w.sets.setB),
      archived: await raw(SETS_ARCHIVE, w.sets.setB),
    }
    expect(theirs.user.legacyArchive.role).toBe('admin')
    await legacyAccessArchiveDrop.up(ctx({ orgId: w.a._id }))

    expect((await raw('users', w.users.archivedA._id)).legacyArchive).toBeUndefined()
    expect((await raw('invites', w.invites.archivedA._id)).legacyArchive).toBeUndefined()
    expect(await db().collection(SETS).countDocuments({ orgId: w.a._id })).toBe(0)
    expect(await db().collection(SETS_ARCHIVE).countDocuments({ orgId: w.a._id })).toBe(0)

    expect(await raw('users', w.users.archivedB._id)).toEqual(theirs.user)
    expect(await raw('invites', w.invites.archivedB._id)).toEqual(theirs.invite)
    expect(await raw(SETS, w.sets.setB)).toEqual(theirs.set)
    expect(await raw(SETS_ARCHIVE, w.sets.setB)).toEqual(theirs.archived)
    // Not empty, so not dropped: the other org's documents are its own home's to drop.
    const here = await collections()
    expect([here.includes(SETS), here.includes(SETS_ARCHIVE)]).toEqual([true, true])

    // The other org's turn (the scope `homeScope()` writes once an org lives elsewhere): then both are empty, and go.
    await legacyAccessArchiveDrop.up(ctx({ orgId: { $nin: [w.a._id] } }))
    expect((await raw('users', w.users.archivedB._id)).legacyArchive).toBeUndefined()
    const after = await collections()
    expect([after.includes(SETS), after.includes(SETS_ARCHIVE)]).toEqual([false, false])
  })

  it('a legacy field written back since 0017 is unset too, with no archive made of it', async () => {
    const w = await world()
    await db().collection('users').updateOne({ _id: w.users.plainA._id }, { $set: { role: 'member', permissions: [] } })
    await db().collection('invites').updateOne({ _id: w.invites.plainA._id }, { $set: { assignRole: 'member' } })
    await legacyAccessArchiveDrop.up(ctx())
    const user = await raw('users', w.users.plainA._id)
    expect(['role', 'permissions', 'legacyArchive'].filter(f => f in user)).toEqual([])
    const invite = await raw('invites', w.invites.plainA._id)
    expect(['assignRole', 'legacyArchive'].filter(f => f in invite)).toEqual([])
  })

  it('a second run changes nothing', async () => {
    await world()
    await legacyAccessArchiveDrop.up(ctx())
    const once = await snapshot()
    await legacyAccessArchiveDrop.up(ctx())
    expect(await snapshot()).toBe(once)
    expect(await legacyAccessArchiveDrop.preview!(ctx() as any)).toEqual(['nothing to change'])
  })

  it('a dry run says what it would do, per step, and writes nothing', async () => {
    const w = await world()
    await db().collection('users').updateOne({ _id: w.users.plainA._id }, { $set: { role: 'member' } })
    const before = await snapshot()
    expect(await legacyAccessArchiveDrop.preview!(ctx() as any)).toEqual([
      'users: 2 with legacyArchive to unset; 1 with a leftover legacy field (role, permissions, permissionSetIds) to unset',
      'invites: 2 with legacyArchive to unset; 0 with a leftover legacy field (assignRole) to unset',
      `${SETS_ARCHIVE}: 3 to delete; then empty, dropped`,
      `${SETS}: 3 to delete; then empty, dropped`,
    ])
    expect(await legacyAccessArchiveDrop.preview!(ctx({ orgId: w.a._id }) as any)).toEqual([
      'users: 1 with legacyArchive to unset; 1 with a leftover legacy field (role, permissions, permissionSetIds) to unset',
      'invites: 1 with legacyArchive to unset; 0 with a leftover legacy field (assignRole) to unset',
      `${SETS_ARCHIVE}: 2 to delete; kept, 1 of other orgs left in it`,
      `${SETS}: 2 to delete; kept, 1 of other orgs left in it`,
    ])
    expect(await snapshot()).toBe(before)
  })

  it('an empty set collection left behind is dropped; then there is nothing to do, and nothing breaks', async () => {
    // `clearCollections` empties the collections an earlier test made, and leaves them there.
    for (const c of [SETS, SETS_ARCHIVE]) if (!(await collections()).includes(c)) await db().createCollection(c)
    expect(await legacyAccessArchiveDrop.preview!(ctx() as any)).toEqual([
      'users: 0 with legacyArchive to unset; 0 with a leftover legacy field (role, permissions, permissionSetIds) to unset',
      'invites: 0 with legacyArchive to unset; 0 with a leftover legacy field (assignRole) to unset',
      `${SETS_ARCHIVE}: 0 to delete; then empty, dropped`,
      `${SETS}: 0 to delete; then empty, dropped`,
    ])
    await legacyAccessArchiveDrop.up(ctx())
    const here = await collections()
    expect([here.includes(SETS), here.includes(SETS_ARCHIVE)]).toEqual([false, false])
    expect(await legacyAccessArchiveDrop.preview!(ctx() as any)).toEqual(['nothing to change'])
    await legacyAccessArchiveDrop.up(ctx())
  })
})
