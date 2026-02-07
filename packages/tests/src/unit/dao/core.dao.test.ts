import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { setupTestDB, teardownTestDB, clearCollections } from '../../setup'
import { orgDao } from 'services/dao/org.dao'
import { userDao } from 'services/dao/user.dao'
import { Org, User } from 'db/models'
import { DEFAULT_ROLE_PERMISSIONS } from 'config/constants'
import { createTestOrg, createTestUser } from '../../helpers/factories'

beforeAll(async () => {
  await setupTestDB()
})

afterAll(async () => {
  await teardownTestDB()
})

afterEach(async () => {
  await clearCollections()
})

describe('OrgDao', () => {
  it('should create an org', async () => {
    const org = await createTestOrg({ name: 'Test Corp', slug: 'test-corp' })
    expect(org).toBeDefined()
    expect(org.name).toBe('Test Corp')
    expect(org._id).toBeDefined()
  })

  it('should find org by slug', async () => {
    await createTestOrg({ name: 'Slug Org', slug: 'slug-org' })
    const found = await orgDao.findBySlug('slug-org')
    expect(found).toBeDefined()
    expect(found!.slug).toBe('slug-org')
    expect(found!.name).toBe('Slug Org')
  })

  it('should return null for non-existent slug', async () => {
    const found = await orgDao.findBySlug('non-existent')
    expect(found).toBeNull()
  })

  it('should find org by id', async () => {
    const org = await createTestOrg({ slug: 'findbyid-org' })
    const found = await orgDao.findById(String(org._id))
    expect(found).toBeDefined()
    expect(found!.slug).toBe('findbyid-org')
  })
})

describe('UserDao', () => {
  it('should create a user in an org', async () => {
    const org = await createTestOrg({ slug: 'user-create-org' })
    const user = await createTestUser(org._id, {
      email: 'test@example.com',
      username: 'testuser',
      firstName: 'Test',
      lastName: 'User',
    })

    expect(user).toBeDefined()
    expect(user.email).toBe('test@example.com')
    expect(String(user.orgId)).toBe(String(org._id))
  })

  it('should find user by username and orgId', async () => {
    const org = await createTestOrg({ slug: 'find-user-org' })
    await createTestUser(org._id, { username: 'findme' })

    const found = await userDao.findByUsername('findme', String(org._id))
    expect(found).toBeDefined()
    expect(found!.username).toBe('findme')
  })

  it('should find user by email and orgId', async () => {
    const org = await createTestOrg({ slug: 'find-email-org' })
    await createTestUser(org._id, { email: 'findme@test.com' })

    const found = await userDao.findByEmail('findme@test.com', String(org._id))
    expect(found).toBeDefined()
    expect(found!.email).toBe('findme@test.com')
  })

  it('should find users by orgId', async () => {
    const org = await createTestOrg({ slug: 'multi-user-org' })
    await createTestUser(org._id, { username: 'user1', email: 'u1@test.com' })
    await createTestUser(org._id, { username: 'user2', email: 'u2@test.com' })

    const users = await userDao.findByOrgId(String(org._id))
    expect(users).toHaveLength(2)
  })

  it('should enforce multi-tenancy isolation', async () => {
    const org1 = await createTestOrg({ slug: 'isolation-org-1' })
    const org2 = await createTestOrg({ slug: 'isolation-org-2' })

    await createTestUser(org1._id, { username: 'shared', email: 'org1@test.com' })
    await createTestUser(org2._id, { username: 'shared', email: 'org2@test.com' })

    const org1Users = await userDao.findByOrgId(String(org1._id))
    const org2Users = await userDao.findByOrgId(String(org2._id))

    expect(org1Users).toHaveLength(1)
    expect(org2Users).toHaveLength(1)
    expect(org1Users[0].email).not.toBe(org2Users[0].email)

    // User from org1 should not be found by email in org2
    const crossCheck = await userDao.findByEmail('org1@test.com', String(org2._id))
    expect(crossCheck).toBeNull()
  })
})
