import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { register, login } from 'services/biz/auth.service'
import { User } from 'db/models'

beforeAll(async () => {
  await setupTestDB()
})

afterAll(async () => {
  await teardownTestDB()
})

afterEach(async () => {
  await clearCollections()
})

describe('Auth Flow: Register -> Login -> Access', () => {
  it('should register a new org and admin user', async () => {
    const result = await register({
      orgName: 'Test Corp',
      orgSlug: 'test-corp',
      email: 'admin@test.com',
      username: 'admin',
      password: 'secure123',
      firstName: 'Admin',
      lastName: 'User',
    })

    expect(result.org).toBeDefined()
    expect(result.org.name).toBe('Test Corp')
    expect(result.org.slug).toBe('test-corp')
    expect(result.user).toBeDefined()
    expect(result.user.role).toBe('admin')
    expect(result.user.email).toBe('admin@test.com')
    expect(String(result.user.orgId)).toBe(String(result.org._id))
    expect(String(result.org.ownerId)).toBe(String(result.user._id))
  })

  it('should login with valid credentials', async () => {
    await register({
      orgName: 'Login Org', orgSlug: 'login-org',
      email: 'admin@login.com', username: 'loginadmin', password: 'secure123',
      firstName: 'Admin', lastName: 'User',
    })

    const result = await login({
      username: 'loginadmin',
      password: 'secure123',
      orgSlug: 'login-org',
    })

    expect(result.user).toBeDefined()
    expect(result.user.username).toBe('loginadmin')
    expect(result.user.orgId).toBeDefined()
    expect(result.org.slug).toBe('login-org')
  })

  it('should return correct JWT payload shape', async () => {
    await register({
      orgName: 'JWT Org', orgSlug: 'jwt-org',
      email: 'admin@jwt.com', username: 'jwtadmin', password: 'secure123',
      firstName: 'JWT', lastName: 'Admin',
    })

    const result = await login({
      username: 'jwtadmin',
      password: 'secure123',
      orgSlug: 'jwt-org',
    })

    expect(result.user).toHaveProperty('id')
    expect(result.user).toHaveProperty('email')
    expect(result.user).toHaveProperty('username')
    expect(result.user).toHaveProperty('firstName')
    expect(result.user).toHaveProperty('lastName')
    expect(result.user).toHaveProperty('role')
    expect(result.user).toHaveProperty('orgId')
    expect(result.user).toHaveProperty('permissions')
    expect(typeof result.user.id).toBe('string')
    expect(typeof result.user.orgId).toBe('string')
    expect(result.user.permissions.length).toBeGreaterThan(0)
  })

  it('should reject invalid credentials', async () => {
    await register({
      orgName: 'Bad PW Org', orgSlug: 'bad-pw-org',
      email: 'admin@badpw.com', username: 'admin', password: 'secure123',
      firstName: 'Admin', lastName: 'User',
    })

    await expect(
      login({ username: 'admin', password: 'wrong-password', orgSlug: 'bad-pw-org' }),
    ).rejects.toThrow('Invalid credentials')
  })

  it('should reject login for wrong org', async () => {
    await register({
      orgName: 'Wrong Org', orgSlug: 'wrong-org',
      email: 'admin@wrong.com', username: 'admin', password: 'secure123',
      firstName: 'Admin', lastName: 'User',
    })

    await expect(
      login({ username: 'admin', password: 'secure123', orgSlug: 'non-existent' }),
    ).rejects.toThrow('Organization not found')
  })

  it('should reject login for non-existent username', async () => {
    await register({
      orgName: 'No User Org', orgSlug: 'no-user-org',
      email: 'admin@nouser.com', username: 'realadmin', password: 'secure123',
      firstName: 'Admin', lastName: 'User',
    })

    await expect(
      login({ username: 'ghostuser', password: 'secure123', orgSlug: 'no-user-org' }),
    ).rejects.toThrow('Invalid credentials')
  })

  it('should prevent duplicate org slugs', async () => {
    await register({
      orgName: 'First Corp', orgSlug: 'dup-slug',
      email: 'admin@first.com', username: 'admin1', password: 'secure123',
      firstName: 'Admin', lastName: 'One',
    })

    await expect(
      register({
        orgName: 'Second Corp', orgSlug: 'dup-slug',
        email: 'admin@second.com', username: 'admin2', password: 'secure123',
        firstName: 'Admin', lastName: 'Two',
      }),
    ).rejects.toThrow('Organization slug already taken')
  })

  it('should isolate users between orgs (multi-tenancy)', async () => {
    await register({
      orgName: 'Org One', orgSlug: 'org-one',
      email: 'admin1@test.com', username: 'admin1', password: 'secure123',
      firstName: 'Admin', lastName: 'One',
    })

    await register({
      orgName: 'Org Two', orgSlug: 'org-two',
      email: 'admin2@test.com', username: 'admin2', password: 'secure123',
      firstName: 'Admin', lastName: 'Two',
    })

    // admin1 cannot login to org-two
    await expect(
      login({ username: 'admin1', password: 'secure123', orgSlug: 'org-two' }),
    ).rejects.toThrow('Invalid credentials')
  })

  it('should reject login for disabled account', async () => {
    const { user } = await register({
      orgName: 'Disabled Org', orgSlug: 'disabled-org',
      email: 'admin@disabled.com', username: 'disadmin', password: 'secure123',
      firstName: 'Disabled', lastName: 'Admin',
    })

    await User.findByIdAndUpdate(user._id, { isActive: false })

    await expect(
      login({ username: 'disadmin', password: 'secure123', orgSlug: 'disabled-org' }),
    ).rejects.toThrow('Account is disabled')
  })

  it('should update lastLoginAt on successful login', async () => {
    await register({
      orgName: 'LastLogin Org', orgSlug: 'lastlogin-org',
      email: 'admin@lastlogin.com', username: 'lladmin', password: 'secure123',
      firstName: 'Last', lastName: 'Login',
    })

    const before = new Date()
    await login({ username: 'lladmin', password: 'secure123', orgSlug: 'lastlogin-org' })

    const user = await User.findOne({ username: 'lladmin' })
    expect(user!.lastLoginAt).toBeDefined()
    expect(user!.lastLoginAt!.getTime()).toBeGreaterThanOrEqual(before.getTime() - 1000)
  })
})
