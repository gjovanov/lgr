import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { mongoose } from 'db/connection'
import { granularPermissions, granular } from 'migrations/migrations/0005-granular-permissions'

const { Types } = mongoose

/**
 * Migration 0005: the legacy `trade.*` permissions become the granular ones they expanded to, so
 * nobody's effective rights change when the auth plugins stop expanding them.
 *
 * NOTE: no `.rejects` / `.resolves` (Bun-on-Windows deadlock, see Known Issues).
 */

beforeAll(async () => { await setupTestDB() }, 60_000)
afterAll(async () => { await teardownTestDB() }, 60_000)
afterEach(async () => { await clearCollections() }, 30_000)

const db = () => mongoose.connection.db!

describe('granular()', () => {
  it('replaces each legacy grant with what it expanded to, keeping every other entry where it was', () => {
    expect(granular(['accounting.read', 'trade.read', 'reports.read', 'trade.write'])).toEqual([
      'accounting.read', 'reports.read',
      'inventory.read', 'invoicing.read', 'pos.read',
      'inventory.write', 'invoicing.write', 'pos.write',
    ])
    expect(granular(['trade.adjust', 'trade.send'])).toEqual(['inventory.adjust', 'invoicing.send'])
  })

  it('never duplicates a permission the list already held', () => {
    expect(granular(['invoicing.read', 'trade.read', 'pos.read'])).toEqual(['invoicing.read', 'pos.read', 'inventory.read'])
  })

  it('leaves a list without legacy grants as it was, unknown names included', () => {
    expect(granular(['crm.read', 'accounting.write'])).toEqual(['crm.read', 'accounting.write'])
  })
})

describe('0005-granular-permissions', () => {
  it('rewrites permission sets, users and invites, only in scope, and a second run changes nothing', async () => {
    const A = new Types.ObjectId()
    const B = new Types.ObjectId()
    const sets = db().collection('permissionsets')
    const users = db().collection('users')
    const invites = db().collection('invites')
    await sets.insertMany([
      { _id: new Types.ObjectId(), orgId: A, name: 'Accountant', permissions: ['accounting.read', 'accounting.write', 'accounting.post', 'trade.read', 'trade.write', 'trade.send'] },
      { _id: new Types.ObjectId(), orgId: A, name: 'Granular', permissions: ['inventory.read'] },
      { _id: new Types.ObjectId(), orgId: B, name: 'Other org', permissions: ['trade.read'] },
    ])
    await users.insertMany([
      // Distinct emails and usernames: other files build the users' unique {email, orgId} and
      // {username, orgId} indexes before this one runs.
      { _id: new Types.ObjectId(), orgId: A, email: 'wm@0005.test', username: 'wm-0005', role: 'warehouse_manager', permissions: ['trade.adjust', 'trade.read', 'trade.write'] },
      { _id: new Types.ObjectId(), orgId: A, email: 'admin@0005.test', username: 'admin-0005', role: 'admin', permissions: ['admin.users', 'inventory.read', 'trade.read'] },
    ])
    await invites.insertOne({ _id: new Types.ObjectId(), orgId: A, permissions: ['trade.send'] })

    const logs: string[] = []
    await granularPermissions.up({ db: db(), orgFilter: { orgId: A }, log: m => logs.push(m) })

    const accountant = await sets.findOne({ orgId: A, name: 'Accountant' }) as any
    expect(accountant.permissions).toEqual([
      'accounting.read', 'accounting.write', 'accounting.post',
      'inventory.read', 'invoicing.read', 'pos.read',
      'inventory.write', 'invoicing.write', 'pos.write',
      'invoicing.send',
    ])
    expect((await sets.findOne({ orgId: A, name: 'Granular' }) as any).permissions).toEqual(['inventory.read'])
    // Out of this node's scope: left for the node whose org it is.
    expect((await sets.findOne({ orgId: B }) as any).permissions).toEqual(['trade.read'])
    const wm = await users.findOne({ orgId: A, role: 'warehouse_manager' }) as any
    expect(wm.permissions).toEqual(['inventory.adjust', 'inventory.read', 'invoicing.read', 'pos.read', 'inventory.write', 'invoicing.write', 'pos.write'])
    expect((await users.findOne({ orgId: A, role: 'admin' }) as any).permissions).toEqual(['admin.users', 'inventory.read', 'invoicing.read', 'pos.read'])
    expect((await invites.findOne({ orgId: A }) as any).permissions).toEqual(['invoicing.send'])
    expect(logs).toEqual([
      'permissionsets: 1 rewritten without trade.*',
      'users: 2 rewritten without trade.*',
      'invites: 1 rewritten without trade.*',
    ])

    const before = JSON.stringify([await sets.find({}).sort({ _id: 1 }).toArray(), await users.find({}).sort({ _id: 1 }).toArray()])
    await granularPermissions.up({ db: db(), orgFilter: { orgId: A }, log: () => {} })
    expect(JSON.stringify([await sets.find({}).sort({ _id: 1 }).toArray(), await users.find({}).sort({ _id: 1 }).toArray()])).toBe(before)
  })
})
