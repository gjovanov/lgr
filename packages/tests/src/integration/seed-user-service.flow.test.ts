import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { setupTestDB, teardownTestDB, testDbUri } from '../setup'
import { Identity, PermissionSet, Sequence, User } from 'db/models'
import { tokenize } from 'services/biz/auth.service'
import { createTestOrg } from '../helpers/factories'

/**
 * `seed-user.ts --permissions`: a service account whose only rights are the ones named, from a set of its
 * own that opens no area. And the script's index guard: it connects without building indexes, and refuses
 * to write when a unique index it relies on is missing.
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
  await Promise.all([User, Identity, PermissionSet, Sequence].map(M => M.init()))
  await createTestOrg({ name: 'Service user test', slug: 'service-user-test' } as any)
}, 60_000)

afterAll(async () => {
  await teardownTestDB()
}, 60_000)

describe('seed-user --permissions: a service account', () => {
  it('links a set holding exactly the named permissions and no area, and the token carries only those', async () => {
    const res = await seedUser('--email', 'books-sync@lgr.internal', '--username', 'books-sync', '--role', 'member',
      '--permissions', 'accounting.import', '--set-name', 'Service: books import', '--execute')
    expect(res.code).toBe(0)

    const user: any = await User.findOne({ username: 'books-sync' }).lean()
    const set: any = await PermissionSet.findOne({ name: 'Service: books import' }).lean()
    expect(set.permissions).toEqual(['accounting.import'])
    expect([set.isAdmin, set.areas]).toEqual([false, []])
    expect(user.permissionSetIds.map(String)).toEqual([String(set._id)])
    expect(user.permissions).toEqual(['accounting.import'])
    expect((await tokenize(user)).permissions).toEqual(['accounting.import'])
  }, 60_000)

  it('refuses a set of that name that holds other permissions, and an unknown permission', async () => {
    const other = await seedUser('--email', 'other@lgr.internal', '--username', 'other', '--role', 'member',
      '--permissions', 'accounting.import,payroll.read', '--set-name', 'Service: books import', '--execute')
    expect(other.code).toBe(2)
    expect(other.out).toContain('exists with other permissions')
    expect(await User.countDocuments({ username: 'other' })).toBe(0)

    const unknown = await seedUser('--email', 'x@lgr.internal', '--username', 'x', '--permissions', 'books.everything', '--execute')
    expect(unknown.code).toBe(2)
    expect(unknown.out).toContain('Unknown permission')
  }, 60_000)

  it('refuses to write when a unique index it relies on is missing, and builds none', async () => {
    await PermissionSet.collection.dropIndex('orgId_1_name_1')
    const res = await seedUser('--email', 'late@lgr.internal', '--username', 'late', '--role', 'member', '--execute')
    expect(res.code).not.toBe(0)
    expect(res.out).toContain('unique index missing (permissionsets {"orgId":1,"name":1})')
    expect(await User.countDocuments({ username: 'late' })).toBe(0)
    expect((await PermissionSet.collection.indexes()).some((i: any) => i.name === 'orgId_1_name_1')).toBe(false)
  }, 60_000)
})
