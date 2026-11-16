import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { join } from 'node:path'
import { setupTestDB, teardownTestDB, testDbUri } from '../setup'
import { AccessShadowDiff, AuditLog, Org, PermissionSet, User } from 'db/models'
import { createTestOrg, createTestUser } from '../helpers/factories'
import { seedDefaultPermissionSets } from 'services/biz/permission-set.seed'

/**
 * FR-27 Phase 3, P3-1 (#529) — `access-model.ts --all`, run as a script against the test database: every org one step
 * towards `roles`, legacy → shadow (roles given first, by 0015's own code) → roles after a clean day.
 *
 * NOTE: no `.rejects` / `.resolves` (Bun-on-Windows deadlock, see Known Issues).
 */

const REPO = join(import.meta.dir, '..', '..', '..', '..')

async function run(...args: string[]) {
  const proc = Bun.spawn(['bun', join(REPO, 'scripts', 'access-model.ts'), ...args], {
    cwd: REPO, env: { ...process.env, MONGODB_URI: testDbUri() }, stdout: 'pipe', stderr: 'pipe',
  })
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
  return { code, out: out + err }
}

const model = async (slug: string) => ((await Org.findOne({ slug }).lean()) as any)?.settings?.access?.model ?? 'legacy'
let plain: any, custom: any, done: any

beforeAll(async () => {
  await setupTestDB()
  plain = await createTestOrg({ slug: 'all-plain' } as any)
  custom = await createTestOrg({ slug: 'all-custom' } as any)
  done = await createTestOrg({ slug: 'all-done', settings: { access: { model: 'roles' } } } as any)
  for (const org of [plain, custom, done]) await seedDefaultPermissionSets(String(org._id))
  await createTestUser(plain._id, { role: 'admin', username: 'a1', email: 'a1@all.test' } as any)
  await createTestUser(plain._id, { role: 'accountant', username: 'a2', email: 'a2@all.test' } as any)
  // A service account on a set of its own: 0015 gives it an imported role with exactly that.
  const set = await PermissionSet.create({ orgId: custom._id, name: 'Service: books import', permissions: ['accounting.import'], areas: [], isAdmin: false, isDefault: false, isSystem: false } as any)
  await createTestUser(custom._id, { role: 'member', username: 'svc', email: 'svc@all.test', permissions: ['accounting.import'], permissionSetIds: [set._id] } as any)
  // The factory gives every person a role (FR-27 P3-4); these orgs are production's 84 as they were on legacy, before
  // 0015 gave their newcomers one: nobody has a role, so `--set shadow` is what gives them.
  await User.updateMany({}, { $unset: { roleId: 1 } }).exec()
}, 60_000)

afterAll(async () => { await teardownTestDB() }, 60_000)

describe('access-model --all', () => {
  it('a dry run moves nothing and says what it would', async () => {
    const r = await run('--all', '--set', 'shadow')
    expect(r.code).toBe(0)
    expect(r.out).toContain('DRY RUN')
    expect(r.out).toContain('would  all-plain: legacy → shadow')
    expect(r.out).toContain('would  all-custom: legacy → shadow')
    expect(r.out).toContain('skip  all-done: on roles already')
    expect([await model('all-plain'), await model('all-custom')]).toEqual(['legacy', 'legacy'])
    expect(await User.countDocuments({ roleId: { $exists: true } })).toBe(0)
  }, 120_000)

  it('--set roles never moves an org straight from legacy', async () => {
    const r = await run('--all', '--set', 'roles', '--execute')
    expect(r.out).toContain('skip  all-plain: on legacy: --set shadow first')
    expect(await model('all-plain')).toBe('legacy')
  }, 120_000)

  it('--set shadow gives everyone a role with exactly their access, then moves the org, audited', async () => {
    const r = await run('--all', '--set', 'shadow', '--execute')
    expect(r.code).toBe(0)
    expect([await model('all-plain'), await model('all-custom'), await model('all-done')]).toEqual(['shadow', 'shadow', 'roles'])
    expect(await User.countDocuments({ roleId: { $exists: false } })).toBe(0)
    expect(await AuditLog.countDocuments({ entityType: 'org', via: 'scripts/access-model.ts' })).toBe(2)
  }, 120_000)

  it('--set roles waits a day on shadow, then moves only the orgs with no difference', async () => {
    expect((await run('--all', '--set', 'roles', '--execute')).out).toContain('less than 1')
    expect(await model('all-plain')).toBe('shadow')

    // A day later, and one difference counted in one of them.
    await AuditLog.updateMany({ entityType: 'org', via: 'scripts/access-model.ts' }, { $set: { timestamp: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000) } })
    await AccessShadowDiff.create({ org: custom._id, day: new Date().toISOString().slice(0, 10), method: 'GET', route: '/x', role: 'member', legacy: 'refuse', evaluator: 'allow', count: 1, lastAt: new Date() } as any)

    const r = await run('--all', '--set', 'roles', '--execute')
    expect(r.out).toContain('moved all-plain: shadow → roles')
    expect(r.out).toContain('skip  all-custom: 1 difference(s)')
    expect([await model('all-plain'), await model('all-custom')]).toEqual(['roles', 'shadow'])
  }, 120_000)
})
