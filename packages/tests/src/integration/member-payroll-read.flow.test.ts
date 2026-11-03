import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { Elysia } from 'elysia'
import jwt from '@elysiajs/jwt'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { createTestOrg, createTestUser } from '../helpers/factories'
import { createApiApp } from '../../../portal-api/src/api.js'
import { spaErrorHandler } from '../../../portal-api/src/spa-fallback.js'
import { config } from 'config'
import { DEFAULT_ROLE_PERMISSIONS } from 'config/constants'
import { PermissionSet, User } from 'db/models'
import { tokenize } from 'services/biz/auth.service'
import { backfillMemberPayrollRead } from 'services/biz/member-payroll-read.backfill'
import { ROLE_TO_PERMISSION_SET, seedDefaultPermissionSets } from 'services/biz/permission-set.seed'

/**
 * A plain member no longer reads payroll (FR-25 §3.11), and nothing keeps the grant alive.
 *
 * Three places carry a member's permissions, and removing it from the role's defaults reaches only
 * one of them:
 * - the role's defaults;
 * - the seeded "Member (Read Only)" set, built as "every `.read`", which outranks the role at sign-in;
 * - the user's own `permissions`, written from the role's defaults when the account was made, which
 *   `tokenizeFromRole` MERGES back in, so a member with no set kept it through their own row.
 *
 * NOTE: no `.rejects` / `.resolves` (Bun-on-Windows deadlock, see Known Issues).
 */

const MEMBER_SET = ROLE_TO_PERMISSION_SET.member
/** The set as every release since FR-6.2 seeded it. */
const SEEDED_SET = ['accounting.read', 'inventory.read', 'invoicing.read', 'pos.read', 'payroll.read', 'reports.read']
/** A member's own list as registration wrote it, the last release before this one. */
const OWN_LIST = ['accounting.read', 'inventory.read', 'invoicing.read', 'payroll.read', 'reports.read']

const memberSet = (orgId: unknown, overrides: Record<string, unknown> = {}) => PermissionSet.create({
  orgId,
  name: MEMBER_SET,
  description: 'Read-only access to all modules',
  permissions: SEEDED_SET,
  ownRecordsOnly: {},
  isAdmin: false,
  isDefault: true,
  isSystem: true,
  ...overrides,
} as any)

const permissionsOf = async (set: { _id: unknown }) => [...(await PermissionSet.findById(set._id).lean() as any).permissions].sort()
const ownListOf = async (user: { _id: unknown }) => [...(await User.findById(user._id).lean() as any).permissions].sort()
const without = (list: string[], gone: string) => list.filter(p => p !== gone).sort()

beforeAll(async () => {
  await setupTestDB()
}, 60_000)

afterAll(async () => {
  await teardownTestDB()
}, 60_000)

afterEach(async () => {
  await clearCollections()
})

describe('from this release on', () => {
  it('a member\'s defaults hold no payroll', () => {
    expect(DEFAULT_ROLE_PERMISSIONS.member.filter(p => p.startsWith('payroll.'))).toEqual([])
    expect(DEFAULT_ROLE_PERMISSIONS.member).toContain('accounting.read')
  })

  it('the roles whose job it is still hold it', () => {
    for (const role of ['admin', 'manager', 'hr_manager'] as const) {
      expect(DEFAULT_ROLE_PERMISSIONS[role]).toContain('payroll.read')
    }
  })

  it('a newly seeded member set holds no payroll, and still reads the rest', async () => {
    const org = await createTestOrg()
    await seedDefaultPermissionSets(String(org._id))

    const set = await PermissionSet.findOne({ orgId: org._id, name: MEMBER_SET }).lean() as any

    expect(set.permissions).not.toContain('payroll.read')
    for (const p of without(SEEDED_SET, 'payroll.read')) expect(set.permissions).toContain(p)
    expect(set.isDefault).toBe(true)
    expect(set.description).not.toContain('all modules')
  })

  it('a member with no set signs in without it, and the route refuses them', async () => {
    const org = await createTestOrg()
    const user = await createTestUser(org._id, { role: 'member', permissionSetIds: [] } as any)

    const claims = await tokenize(user)
    expect(claims.permissions).not.toContain('payroll.read')

    const signer = new Elysia().use(jwt({ name: 'jwt', secret: config.jwt.secret }))
    const token = await (signer as any).decorator.jwt.sign({ ...claims })
    const app = new Elysia().onError(spaErrorHandler({}) as any).use(createApiApp()) as any
    const res = await app.handle(new Request(`http://localhost/api/org/${org._id}/payroll/employee`, { headers: { authorization: `Bearer ${token}` } }))
    expect(res.status).toBe(403)
  })
})

describe('the backfill, on the sets', () => {
  it('takes it from the seeded set, and nothing else', async () => {
    const org = await createTestOrg()
    const set = await memberSet(org._id)

    const result = await backfillMemberPayrollRead(String(org._id), { execute: true })

    expect(await permissionsOf(set)).toEqual(without(SEEDED_SET, 'payroll.read'))
    expect(result.setsChanged).toEqual([MEMBER_SET])
    expect(result.setsLeftAlone).toEqual([])
    const after = await PermissionSet.findById(set._id).lean() as any
    expect(after.isSystem).toBe(true)
    expect(after.isDefault).toBe(true)
    expect(after.description).not.toContain('all modules')
  })

  it('reaches a set seeded in the first releases, whatever retired modules it still names', async () => {
    const org = await createTestOrg()
    const retired = ['hr.read', 'crm.read', 'erp.read', 'sales.read', 'project.read', 'field_service.read']
    const set = await memberSet(org._id, { permissions: [...SEEDED_SET, ...retired] })

    await backfillMemberPayrollRead(String(org._id), { execute: true })

    expect(await permissionsOf(set)).toEqual(without([...SEEDED_SET, ...retired], 'payroll.read'))
  })

  const customised: [string, Record<string, unknown>][] = [
    ['a write added', { permissions: [...SEEDED_SET, 'invoicing.write'] }],
    ['the audit trail added', { permissions: [...SEEDED_SET, 'admin.audit'] }],
    ['a read taken away', { permissions: without(SEEDED_SET, 'pos.read') }],
    ['reports taken away', { permissions: without(SEEDED_SET, 'reports.read') }],
    ['a permission it does not know', { permissions: [...SEEDED_SET, 'trade.write'] }],
    ['its own name', { name: 'Front desk' }],
    ['been made by an admin', { isSystem: false }],
    ['been made an admin set', { isAdmin: true }],
  ]
  for (const [what, overrides] of customised) {
    it(`leaves a set that has ${what}, and says so`, async () => {
      const org = await createTestOrg()
      const set = await memberSet(org._id, overrides)
      const before = await permissionsOf(set)

      const result = await backfillMemberPayrollRead(String(org._id), { execute: true })

      expect(await permissionsOf(set)).toEqual(before)
      expect(result.setsChanged).toEqual([])
      // An admin's own set under its own name is no one's concern; one that may be the default is.
      if (overrides.name || overrides.isSystem === false || overrides.isAdmin) expect(result.setsLeftAlone).toEqual([])
      else expect(result.setsLeftAlone.map(s => s.name)).toEqual([MEMBER_SET])
    })
  }

  it('leaves the other seeded sets that hold it', async () => {
    const org = await createTestOrg()
    await seedDefaultPermissionSets(String(org._id))
    const manager = await PermissionSet.findOne({ orgId: org._id, name: ROLE_TO_PERMISSION_SET.manager }).lean() as any
    expect(manager.permissions).toContain('payroll.read')

    await backfillMemberPayrollRead(String(org._id), { execute: true })

    expect(await permissionsOf(manager)).toContain('payroll.read')
  })

  it('a set an admin finished customising with it is theirs to decide, and a member on it keeps it', async () => {
    const org = await createTestOrg()
    const set = await memberSet(org._id, { name: 'Payroll readers', isDefault: false })
    const user = await createTestUser(org._id, { role: 'member', permissionSetIds: [set._id] } as any)

    await backfillMemberPayrollRead(String(org._id), { execute: true })

    expect((await tokenize((await User.findById(user._id))!)).permissions).toContain('payroll.read')
  })
})

describe('the backfill, on a member\'s own list', () => {
  /** What each release wrote, after migration 0005 rewrote `trade.read`. */
  const defaults: [string, string[]][] = [
    ['this release\'s predecessor', OWN_LIST],
    ['the one before reports', ['accounting.read', 'inventory.read', 'invoicing.read', 'payroll.read']],
    ['a trade-era account, rewritten by 0005', ['accounting.read', 'payroll.read', 'inventory.read', 'invoicing.read', 'pos.read']],
    ['the first releases, with retired modules', ['accounting.read', 'invoicing.read', 'warehouse.read', 'payroll.read', 'hr.read', 'crm.read', 'erp.read']],
    ['a trade-era account with retired modules', ['accounting.read', 'payroll.read', 'hr.read', 'crm.read', 'erp.read', 'project.read', 'inventory.read', 'invoicing.read', 'pos.read']],
  ]
  for (const [what, list] of defaults) {
    it(`takes it from ${what}`, async () => {
      const org = await createTestOrg()
      const user = await createTestUser(org._id, { role: 'member', permissions: list } as any)

      const result = await backfillMemberPayrollRead(String(org._id), { execute: true })

      expect(await ownListOf(user)).toEqual(without(list, 'payroll.read'))
      expect(result.usersChanged).toBe(1)
    })
  }

  it('which is what actually ends it for a member with no set', async () => {
    const org = await createTestOrg()
    const user = await createTestUser(org._id, { role: 'member', permissions: OWN_LIST, permissionSetIds: [] } as any)
    // The role's defaults no longer hold it, and the merge still brings it back from the row.
    expect((await tokenize((await User.findById(user._id))!)).permissions).toContain('payroll.read')

    await backfillMemberPayrollRead(String(org._id), { execute: true })

    expect((await tokenize((await User.findById(user._id))!)).permissions).not.toContain('payroll.read')
  })

  const kept: [string, Record<string, unknown>][] = [
    ['a member with a write on their list', { role: 'member', permissions: [...OWN_LIST, 'invoicing.write'] }],
    ['a member with little else, granted it on purpose', { role: 'member', permissions: ['payroll.read'] }],
    ['a member whose list was narrowed', { role: 'member', permissions: ['accounting.read', 'payroll.read', 'invoicing.read'] }],
    ['a person in another role', { role: 'hr_manager', permissions: DEFAULT_ROLE_PERMISSIONS.hr_manager }],
    ['a manager with the same reads', { role: 'manager', permissions: OWN_LIST }],
  ]
  for (const [what, overrides] of kept) {
    it(`leaves ${what}`, async () => {
      const org = await createTestOrg()
      const user = await createTestUser(org._id, overrides as any)
      const before = await ownListOf(user)

      const result = await backfillMemberPayrollRead(String(org._id), { execute: true })

      expect(await ownListOf(user)).toEqual(before)
      expect(result.usersChanged).toBe(0)
    })
  }

  it('reports the members it left, so someone can look', async () => {
    const org = await createTestOrg()
    await createTestUser(org._id, { role: 'member', permissions: [...OWN_LIST, 'invoicing.write'] } as any)
    await createTestUser(org._id, { role: 'hr_manager', permissions: DEFAULT_ROLE_PERMISSIONS.hr_manager } as any)

    const result = await backfillMemberPayrollRead(String(org._id), { execute: true })

    expect(result.usersLeftAlone).toBe(1)
  })
})

describe('the backfill, as a run', () => {
  it('writes nothing unless told to, and says what it would do', async () => {
    const org = await createTestOrg()
    const set = await memberSet(org._id)
    const user = await createTestUser(org._id, { role: 'member', permissions: OWN_LIST } as any)
    const setBefore = await permissionsOf(set)
    const userBefore = await ownListOf(user)

    const result = await backfillMemberPayrollRead(String(org._id), { execute: false })

    expect(result.setsChanged).toEqual([MEMBER_SET])
    expect(result.usersChanged).toBe(1)
    expect(await permissionsOf(set)).toEqual(setBefore)
    expect(await ownListOf(user)).toEqual(userBefore)
  })

  it('a second run finds nothing', async () => {
    const org = await createTestOrg()
    await memberSet(org._id)
    await createTestUser(org._id, { role: 'member', permissions: OWN_LIST } as any)

    await backfillMemberPayrollRead(String(org._id), { execute: true })
    const again = await backfillMemberPayrollRead(String(org._id), { execute: false })

    expect(again).toEqual({ setsChanged: [], setsLeftAlone: [], usersChanged: 0, usersLeftAlone: 0 })
  })

  it('keeps to the org it was given', async () => {
    const mine = await createTestOrg()
    const theirs = await createTestOrg()
    const theirSet = await memberSet(theirs._id)
    const theirUser = await createTestUser(theirs._id, { role: 'member', permissions: OWN_LIST } as any)

    await backfillMemberPayrollRead(String(mine._id), { execute: true })

    expect(await permissionsOf(theirSet)).toContain('payroll.read')
    expect(await ownListOf(theirUser)).toContain('payroll.read')
  })

  it('an edit that lands after it looked wins: the write is guarded on the list it read', async () => {
    const org = await createTestOrg()
    const set = await memberSet(org._id)
    const user = await createTestUser(org._id, { role: 'member', permissions: OWN_LIST } as any)

    await backfillMemberPayrollRead(String(org._id), {
      execute: true,
      // Between its read and its write, an admin edits both.
      beforeWrite: async () => {
        await PermissionSet.updateOne({ _id: set._id }, { $addToSet: { permissions: 'invoicing.write' } })
        await User.updateOne({ _id: user._id }, { $addToSet: { permissions: 'invoicing.write' } })
      },
    })

    expect(await permissionsOf(set)).toContain('payroll.read')
    expect(await ownListOf(user)).toContain('payroll.read')
  })
})
