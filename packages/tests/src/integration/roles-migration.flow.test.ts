import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { mongoose } from 'db/connection'
import { setupTestDB, teardownTestDB } from '../setup'
import { createTestOrg, createTestUser } from '../helpers/factories'
import { PermissionSet, Role, User } from 'db/models'
import { seedDefaultPermissionSets } from 'services/biz/permission-set.seed'
import { tokenize } from 'services/biz/auth.service'
import { compileLegacy, grantOfRole, sameGrant } from 'config/access'
import { rolesFromSets } from 'migrations/migrations/0015-roles-from-sets'

/**
 * FR-27 §4 (#529) — migration 0015: every person gets one role, with exactly the access their token gives today.
 *
 * Over the stored shapes §6 names: no set, their role's system set, two sets, an admin set on a role that is not
 * admin, an admin with a set, extra permissions of their own, a set of another org. For each person, the role's grant
 * equals what `tokenize()` gives them, compiled, and a second run changes nothing.
 *
 * NOTE: no `.rejects` / `.resolves` (Bun-on-Windows deadlock, see Known Issues).
 */

let org: any
let other: any
const people: Record<string, any> = {}
const db = () => mongoose.connection.db!
const ctx = () => ({ db: db() as any, log: () => {}, orgFilter: {} })

async function set(orgId: unknown, name: string) {
  return (await PermissionSet.findOne({ orgId, name }).lean().exec()) as any
}

beforeAll(async () => {
  await setupTestDB()
  org = await createTestOrg({ slug: 'roles-migration' } as any)
  other = await createTestOrg({ slug: 'roles-migration-other' } as any)
  await seedDefaultPermissionSets(String(org._id))
  await seedDefaultPermissionSets(String(other._id))
  const make = async (key: string, role: string, extra: Record<string, unknown> = {}) => {
    people[key] = await createTestUser(org._id, { role, email: `${key}@roles.test`, username: key, ...extra } as any)
  }
  const ids = async (...names: string[]) => (await Promise.all(names.map(n => set(org._id, n)))).map(s => s._id)
  await make('member', 'member')
  await make('seller', 'seller', { permissionSetIds: await ids('Seller') })
  await make('sellerNoSet', 'seller')
  await make('manager', 'manager', { permissionSetIds: await ids('Manager') })
  await make('twoSets', 'accountant', { permissionSetIds: await ids('Accountant', 'Warehouse Manager') })
  await make('adminSetOnMember', 'member', { permissionSetIds: await ids('Administrator') })
  await make('admin', 'admin', { permissionSetIds: await ids('Member (Read Only)') })
  await make('extras', 'member', { permissions: ['inventory.write'] })
  await make('foreignSet', 'warehouse_manager', { permissionSetIds: [(await set(other._id, 'Administrator'))._id] })
  // The same two sets on another legacy role: another access (the role name gives devices), another role.
  await make('twoSetsManager', 'manager', { permissionSetIds: await ids('Accountant', 'Warehouse Manager') })
}, 60_000)

afterAll(async () => { await teardownTestDB() }, 60_000)

async function roleOf(key: string) {
  const u: any = await User.findById(people[key]._id).lean().exec()
  return u.roleId ? ((await Role.findById(u.roleId).lean().exec()) as any) : null
}

describe('migration 0015: roles from sets', () => {
  it('the dry run says what it would do, writes nothing, and finds no difference', async () => {
    const lines = await rolesFromSets.preview!(ctx())
    expect(lines.some(l => l.startsWith('roles-migration: 10 built-in role(s) to create'))).toBe(true)
    expect(lines.filter(l => /differences: [1-9]/.test(l))).toEqual([])
    expect(await Role.countDocuments({})).toBe(0)
  })

  it('every person gets a role that grants exactly what their token does', async () => {
    await rolesFromSets.up(ctx())
    for (const key of Object.keys(people)) {
      const role = await roleOf(key)
      expect({ key, role: !!role }).toEqual({ key, role: true })
      const token = await tokenize((await User.findById(people[key]._id).exec())!)
      expect({ key, same: sameGrant(grantOfRole(role), compileLegacy(token)) }).toEqual({ key, same: true })
    }
  })

  it('a person whose access is their role defaults gets the built-in role; an admin the Administrator', async () => {
    expect((await roleOf('member')).templateKey).toBe('member')
    expect((await roleOf('seller')).templateKey).toBe('seller')
    expect((await roleOf('sellerNoSet')).templateKey).toBe('seller')
    expect((await roleOf('manager')).templateKey).toBe('manager')
    expect((await roleOf('admin'))).toMatchObject({ templateKey: 'admin', all: true })
    // Another org's set is ignored, as tokenize() ignores it: the role's defaults.
    expect((await roleOf('foreignSet')).templateKey).toBe('warehouse_manager')
  })

  it('anyone else gets an imported role named after their sets, told apart by the role where they share them', async () => {
    const twoSets = await roleOf('twoSets')
    const twoSetsManager = await roleOf('twoSetsManager')
    expect(twoSets).toMatchObject({ isBuiltin: false, name: 'Accountant + Warehouse Manager (Accountant)' })
    expect(twoSetsManager).toMatchObject({ isBuiltin: false, name: 'Accountant + Warehouse Manager (Manager)' })
    // An admin set on a role that is not admin: every permission, none of the admin role's own (zero difference).
    const adminSet = await roleOf('adminSetOnMember')
    expect(adminSet).toMatchObject({ isBuiltin: false, all: false, name: 'Administrator (imported)' })
    expect(adminSet.caps).not.toContain('users.edit')
    expect((await roleOf('extras')).name).toBe('Member (Read Only) + extras')
    expect((await roleOf('extras')).legacy).toMatchObject({ role: 'member', permissions: expect.arrayContaining(['inventory.write']) })
  })

  it('a second run changes nothing, and a person given another role keeps it', async () => {
    const before = await Role.countDocuments({})
    const kept = await Role.findOne({ orgId: org._id, templateKey: 'sales' }).lean().exec() as any
    await User.updateOne({ _id: people.member._id }, { $set: { roleId: kept._id } }).exec()
    await rolesFromSets.up(ctx())
    expect(await Role.countDocuments({})).toBe(before)
    expect(String((await User.findById(people.member._id).lean().exec() as any).roleId)).toBe(String(kept._id))
    expect(await rolesFromSets.preview!(ctx())).toEqual(['nothing to change'])
  })
})
