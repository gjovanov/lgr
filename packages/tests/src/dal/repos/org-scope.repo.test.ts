import { describe, test, expect, beforeAll, beforeEach, afterAll } from 'bun:test'
import type { RepositoryRegistry } from 'dal'
import { ScopedRepository } from 'services/biz/scoped-repository'
import { setupMongoRepos, teardownMongo, createTestOrg, releaseMongoRepos } from '../helpers/dal-test-setup'

/**
 * `findByIdInOrg` / `updateInOrg` / `deleteInOrg` (FR-20.7).
 *
 * A route that takes an id from its URL must not reach a document of another org: the tenant
 * guard only checks the URL's `:orgId`, and `tenantPlugin` filters nothing. These are the three
 * methods every such route uses, so the property is asserted here once, on the interface, and
 * over the real route table in `tenant-isolation.flow.test.ts`.
 *
 * NOTE: no `.rejects` / `.resolves` (Bun-on-Windows deadlock, see Known Issues).
 */

const backends: [string, () => Promise<RepositoryRegistry>, () => Promise<void>][] = [
  ['mongo', setupMongoRepos, teardownMongo],
]

for (const [name, setup, cleanup] of backends) {
  describe(`org-scoped by-id operations [${name}]`, () => {
    let repos: RepositoryRegistry
    let orgA: string
    let orgB: string

    beforeAll(async () => { repos = await setup() })
    beforeEach(async () => {
      await cleanup()
      orgA = await createTestOrg(repos)
      orgB = await createTestOrg(repos)
    })
    afterAll(async () => { await releaseMongoRepos() })

    const account = (orgId: string, code: string) => repos.accounts.create({
      orgId, code, name: `Cash ${code}`, type: 'asset', subType: 'current_asset', isActive: true,
    } as any)

    test('findByIdInOrg finds the org\'s own document and nothing of another org\'s', async () => {
      const a = await account(orgA, '1000')
      const b = await account(orgB, '1000')

      expect((await repos.accounts.findByIdInOrg(a.id, orgA))?.id).toBe(a.id)
      expect(await repos.accounts.findByIdInOrg(b.id, orgA)).toBeNull()
    })

    test('updateInOrg leaves another org\'s document untouched', async () => {
      const b = await account(orgB, '1000')

      expect(await repos.accounts.updateInOrg(b.id, orgA, { name: 'changed' } as any)).toBeNull()
      expect((await repos.accounts.findById(b.id) as any).name).toBe('Cash 1000')
    })

    test('updateInOrg never moves a document to another org', async () => {
      const a = await account(orgA, '1000')

      const updated = await repos.accounts.updateInOrg(a.id, orgA, { name: 'renamed', orgId: orgB } as any)

      expect((updated as any).name).toBe('renamed')
      expect(String((updated as any).orgId)).toBe(orgA)
      expect(await repos.accounts.findByIdInOrg(a.id, orgB)).toBeNull()
    })

    test('deleteInOrg deletes only the org\'s own document', async () => {
      const a = await account(orgA, '1000')
      const b = await account(orgB, '1000')

      expect(await repos.accounts.deleteInOrg(b.id, orgA)).toBe(false)
      expect(await repos.accounts.findById(b.id)).not.toBeNull()

      expect(await repos.accounts.deleteInOrg(a.id, orgA)).toBe(true)
      expect(await repos.accounts.findById(a.id)).toBeNull()
    })

    test('a malformed id or an empty org answers "not found", never throws', async () => {
      const a = await account(orgA, '1000')

      expect(await repos.accounts.findByIdInOrg('not-an-id', orgA)).toBeNull()
      expect(await repos.accounts.updateInOrg('not-an-id', orgA, { name: 'x' } as any)).toBeNull()
      expect(await repos.accounts.deleteInOrg('not-an-id', orgA)).toBe(false)
      expect(await repos.accounts.findByIdInOrg(a.id, '')).toBeNull()
    })

    test('the own-records wrapper keeps the org scope under its own', async () => {
      const b = await account(orgB, '1000')
      // A scope every document matches, so only the org can be what refuses.
      const scoped = new ScopedRepository(repos.accounts as any, { isActive: true })

      expect(await scoped.findByIdInOrg(b.id, orgA)).toBeNull()
      expect(await scoped.updateInOrg(b.id, orgA, { name: 'x' })).toBeNull()
      expect(await scoped.deleteInOrg(b.id, orgA)).toBe(false)
      expect((await scoped.findByIdInOrg(b.id, orgB))?.id).toBe(b.id)
    })
  })
}
