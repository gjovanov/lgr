import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { join } from 'node:path'
import { Types } from 'mongoose'
import { setupTestDB, teardownTestDB, testDbUri } from '../setup'
import { Org, User } from 'db/models'
import { mongoose } from 'db/connection'
import { createTestOrg, createTestUser } from '../helpers/factories'

/**
 * FR-27 P3-6 (#529) — `scripts/access-model.ts`, run as a script against the test database. The legacy model and
 * shadow mode are gone: it reports who has no role and gives the people from before roles theirs (0015's own `up`),
 * and refuses the switches it used to make, saying why.
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

let plain: any, done: any

beforeAll(async () => {
  await setupTestDB()
  plain = await createTestOrg({ slug: 'all-plain' } as any)
  done = await createTestOrg({ slug: 'all-done' } as any)
  await createTestUser(done._id, { role: 'admin', username: 'd1', email: 'd1@all.test' } as any)
  // A person from before roles, as production kept them: legacy fields and no role (raw: nothing writes them now).
  await mongoose.connection.db!.collection('users').insertOne({
    _id: new Types.ObjectId(), orgId: plain._id, email: 'a2@all.test', username: 'a2', firstName: 'A', lastName: 'Two',
    isActive: true, role: 'accountant', roleHistory: [],
  })
}, 60_000)

afterAll(async () => { await teardownTestDB() }, 60_000)

describe('access-model (FR-27 P3-6)', () => {
  it('refuses the switches of the legacy model, saying why, and writes nothing', async () => {
    for (const a of [['--org', 'all-plain', '--set', 'roles'], ['--all', '--set', 'shadow', '--execute'], ['--org', 'all-plain', '--report']]) {
      const r = await run(...a)
      expect(r.code).toBe(1)
      expect(r.out).toContain('gone with the legacy model (FR-27 P3-6)')
    }
    expect(((await Org.findOne({ slug: 'all-plain' }).lean()) as any)?.settings?.access?.model).toBeUndefined()
  }, 120_000)

  it('--all lists the orgs with someone without a role', async () => {
    const r = await run('--all')
    expect(r.code).toBe(0)
    expect(r.out).toContain('all-plain: 1 person(s) without a role')
    expect(r.out).not.toContain('all-done:')
  }, 120_000)

  it('--give-roles gives the people from before roles theirs, by 0015', async () => {
    const r = await run('--org', 'all-plain', '--give-roles')
    expect(r.code).toBe(0)
    expect(r.out).toContain('all-plain: 0 person(s) without a role')
    const person: any = await User.findOne({ username: 'a2' }).lean().exec()
    expect(person.roleId).toBeDefined()
  }, 120_000)
})
