import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { setupTestDB, teardownTestDB, testDbUri } from '../setup'
import { Identity, PermissionSet, Role, Sequence, User } from 'db/models'
import { tokenize } from 'services/biz/auth.service'
import { createTestOrg } from '../helpers/factories'

/**
 * `seed-user.ts --permissions` / `--caps`: a service account whose only rights are the ones named, from a role of its
 * own (FR-27 P3-5: no permission set, no legacy fields). And the script's index guard: it connects without building
 * indexes, and refuses to write when a unique index it relies on is missing.
 */

const REPO = join(import.meta.dir, '..', '..', '..', '..')
const password = randomBytes(18).toString('base64url')

async function seedUser(...args: string[]) {
  const proc = Bun.spawn(['bun', join(REPO, 'scripts', 'seed-user.ts'), '--org', 'service-user-test', '--password', password, '--first', 'Books', '--last', 'Sync', ...args], {
    cwd: REPO,
    env: { ...process.env, MONGODB_URI: testDbUri() },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
  return { code, out: out + err }
}

beforeAll(async () => {
  await setupTestDB()
  // What the app does on start, and the script no longer does: build the indexes.
  await Promise.all([User, Identity, PermissionSet, Role, Sequence].map(M => M.init()))
  await createTestOrg({ name: 'Service user test', slug: 'service-user-test' } as any)
}, 60_000)

afterAll(async () => {
  await teardownTestDB()
}, 60_000)

describe('seed-user --permissions: a service account', () => {
  it('gives a role of its own holding exactly what the named permissions gave, and writes nothing of the legacy model', async () => {
    const res = await seedUser('--email', 'books-sync@lgr.internal', '--username', 'books-sync', '--role', 'member',
      '--permissions', 'accounting.import', '--set-name', 'Service: books import', '--execute')
    expect(res.code).toBe(0)

    const user: any = await User.findOne({ username: 'books-sync' }).lean()
    expect([user.role, user.permissions, user.permissionSetIds]).toEqual([undefined, undefined, undefined])
    expect(await PermissionSet.exists({ name: 'Service: books import' })).toBeNull()

    // FR-27 (#529): what `accounting.import` gave a session opening no area, and nothing else.
    const role: any = await Role.findById(user.roleId).lean()
    expect([role.name, role.isBuiltin, role.caps]).toEqual(['Service: books import', false, ['books-import.run']])
    expect(String(user.roleHistory[0].roleId)).toBe(String(role._id))
    expect((await tokenize(user)).rid).toBe(String(role._id))
    expect(res.out).toContain('role: Service: books import')
  }, 60_000)

  it('--caps names the capabilities themselves, and the same role is found again', async () => {
    const res = await seedUser('--email', 'books-two@lgr.internal', '--username', 'books-two',
      '--caps', 'books-import.run', '--set-name', 'Service: books import', '--execute')
    expect(res.code).toBe(0)
    const user: any = await User.findOne({ username: 'books-two' }).lean()
    const role: any = await Role.findById(user.roleId).lean()
    expect(role.name).toBe('Service: books import')
    expect(await Role.countDocuments({ name: 'Service: books import' })).toBe(1)
  }, 60_000)

  it('a plain role gets the built-in role of that key (#529)', async () => {
    const res = await seedUser('--email', 'acc@lgr.internal', '--username', 'acc', '--role', 'accountant', '--execute')
    expect(res.code).toBe(0)
    const user: any = await User.findOne({ username: 'acc' }).lean()
    const role: any = await Role.findById(user.roleId).lean()
    expect([role.isBuiltin, role.templateKey]).toEqual([true, 'accountant'])
  }, 60_000)

  it('refuses a role of that name that holds other capabilities, and an unknown permission', async () => {
    const other = await seedUser('--email', 'other@lgr.internal', '--username', 'other', '--role', 'member',
      '--permissions', 'accounting.import,payroll.read', '--set-name', 'Service: books import', '--execute')
    expect(other.code).toBe(2)
    expect(other.out).toContain('exists with other capabilities')
    expect(await User.countDocuments({ username: 'other' })).toBe(0)

    const unknown = await seedUser('--email', 'x@lgr.internal', '--username', 'x', '--permissions', 'books.everything', '--execute')
    expect(unknown.code).toBe(2)
    expect(unknown.out).toContain('Unknown permission')
  }, 60_000)

  it('refuses to write when a unique index it relies on is missing, and builds none', async () => {
    await Role.collection.dropIndex('orgId_1_name_1')
    const res = await seedUser('--email', 'late@lgr.internal', '--username', 'late', '--role', 'member', '--execute')
    expect(res.code).not.toBe(0)
    expect(res.out).toContain('unique index missing (roles {"orgId":1,"name":1})')
    expect(await User.countDocuments({ username: 'late' })).toBe(0)
    expect((await Role.collection.indexes()).some((i: any) => i.name === 'orgId_1_name_1')).toBe(false)
  }, 60_000)
})
