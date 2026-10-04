import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { captureRejection, expectRejection } from '../helpers/capture-rejection'
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
    const { user } = await register({
      orgName: 'Login Org', orgSlug: 'login-org',
      email: 'admin@login.com', username: 'loginadmin', password: 'secure123',
      firstName: 'Admin', lastName: 'User',
    })
    await User.findByIdAndUpdate(user._id, { isActive: true })

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
    const { user } = await register({
      orgName: 'JWT Org', orgSlug: 'jwt-org',
      email: 'admin@jwt.com', username: 'jwtadmin', password: 'secure123',
      firstName: 'JWT', lastName: 'Admin',
    })
    await User.findByIdAndUpdate(user._id, { isActive: true })

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
    const { user } = await register({
      orgName: 'Bad PW Org', orgSlug: 'bad-pw-org',
      email: 'admin@badpw.com', username: 'admin', password: 'secure123',
      firstName: 'Admin', lastName: 'User',
    })
    await User.findByIdAndUpdate(user._id, { isActive: true })

    expectRejection(await captureRejection(login({ username: 'admin', password: 'wrong-password', orgSlug: 'bad-pw-org' })), 'Invalid credentials')
  })

  it('should reject login for wrong org', async () => {
    await register({
      orgName: 'Wrong Org', orgSlug: 'wrong-org',
      email: 'admin@wrong.com', username: 'admin', password: 'secure123',
      firstName: 'Admin', lastName: 'User',
    })

    // S-08: an org that does not exist gets the same answer as a wrong password. 'Organization
    // not found' told anyone which org slugs were real.
    expectRejection(await captureRejection(login({ username: 'admin', password: 'secure123', orgSlug: 'non-existent' })), 'Invalid credentials')
  })

  it('should reject login for non-existent username', async () => {
    await register({
      orgName: 'No User Org', orgSlug: 'no-user-org',
      email: 'admin@nouser.com', username: 'realadmin', password: 'secure123',
      firstName: 'Admin', lastName: 'User',
    })

    expectRejection(await captureRejection(login({ username: 'ghostuser', password: 'secure123', orgSlug: 'no-user-org' })), 'Invalid credentials')
  })

  it('should prevent duplicate org slugs', async () => {
    await register({
      orgName: 'First Corp', orgSlug: 'dup-slug',
      email: 'admin@first.com', username: 'admin1', password: 'secure123',
      firstName: 'Admin', lastName: 'One',
    })

    expectRejection(await captureRejection(register({
        orgName: 'Second Corp', orgSlug: 'dup-slug',
        email: 'admin@second.com', username: 'admin2', password: 'secure123',
        firstName: 'Admin', lastName: 'Two',
      })), 'Organization slug already taken')
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
    expectRejection(await captureRejection(login({ username: 'admin1', password: 'secure123', orgSlug: 'org-two' })), 'Invalid credentials')
  })

  it('should tell the password holder an account is not activated yet', async () => {
    await register({
      orgName: 'Disabled Org', orgSlug: 'disabled-org',
      email: 'admin@disabled.com', username: 'disadmin', password: 'secure123',
      firstName: 'Disabled', lastName: 'Admin',
    })

    // User starts as inactive (isActive: false) after registration, no need to set it
    expectRejection(
      await captureRejection(login({ username: 'disadmin', password: 'secure123', orgSlug: 'disabled-org' })),
      'Account not activated. Check your email for the activation link.',
    )
  })

  it('should reject login for an account an admin deactivated', async () => {
    const { user } = await register({
      orgName: 'Deact Org', orgSlug: 'deact-org',
      email: 'admin@deact.com', username: 'deactadmin', password: 'secure123',
      firstName: 'Deact', lastName: 'Admin',
    })
    await User.findByIdAndUpdate(user._id, { isActive: false, deactivatedAt: new Date() })

    expectRejection(await captureRejection(login({ username: 'deactadmin', password: 'secure123', orgSlug: 'deact-org' })), 'Account is disabled')
  })

  // S-08: an account's state is said only to someone who has proven its password. With a wrong one,
  // a pending, a deactivated and a password-less (OAuth-only) account all look like a typo.
  it('should say nothing about an account to someone without its password', async () => {
    const { user: pending } = await register({
      orgName: 'Quiet Org', orgSlug: 'quiet-org',
      email: 'pending@quiet.com', username: 'pending', password: 'secure123',
      firstName: 'Pen', lastName: 'Ding',
    })
    const { user: gone } = await register({
      orgName: 'Quiet Org 2', orgSlug: 'quiet-org-2',
      email: 'gone@quiet.com', username: 'gone', password: 'secure123',
      firstName: 'Go', lastName: 'Ne',
    })
    await User.findByIdAndUpdate(gone._id, { isActive: false, deactivatedAt: new Date() })
    const { user: oauthOnly } = await register({
      orgName: 'Quiet Org 3', orgSlug: 'quiet-org-3',
      email: 'oauth@quiet.com', username: 'oauthonly', password: 'secure123',
      firstName: 'O', lastName: 'Auth',
    })
    await User.findByIdAndUpdate(oauthOnly._id, { isActive: true, $unset: { password: 1 } })
    expect(pending).toBeDefined()

    const WRONG = 'not-it'
    const RIGHT = 'secure123'

    for (const attempt of [
      { username: 'pending', password: WRONG, orgSlug: 'quiet-org' },
      { username: 'gone', password: WRONG, orgSlug: 'quiet-org-2' },
      { username: 'oauthonly', password: RIGHT, orgSlug: 'quiet-org-3' },
    ]) {
      expectRejection(await captureRejection(login(attempt)), 'Invalid credentials')
    }
  })

  it('should update lastLoginAt on successful login', async () => {
    const { user } = await register({
      orgName: 'LastLogin Org', orgSlug: 'lastlogin-org',
      email: 'admin@lastlogin.com', username: 'lladmin', password: 'secure123',
      firstName: 'Last', lastName: 'Login',
    })
    await User.findByIdAndUpdate(user._id, { isActive: true })

    const before = new Date()
    await login({ username: 'lladmin', password: 'secure123', orgSlug: 'lastlogin-org' })

    const updatedUser = await User.findOne({ username: 'lladmin' })
    expect(updatedUser!.lastLoginAt).toBeDefined()
    expect(updatedUser!.lastLoginAt!.getTime()).toBeGreaterThanOrEqual(before.getTime() - 1000)
  })
})
