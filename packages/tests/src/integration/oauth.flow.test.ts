import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { register } from 'services/biz/auth.service'
import {
  buildAuthUrl,
  getOrCreateUser,
  registerWithOAuth,
  parseState,
  type OAuthUserInfo,
} from 'services/biz/oauth.service'
import { User, Org } from 'db/models'

beforeAll(async () => {
  await setupTestDB()
})

afterAll(async () => {
  await teardownTestDB()
})

afterEach(async () => {
  await clearCollections()
})

describe('OAuth Flow', () => {
  it('should build auth URL for google with org_slug in state', () => {
    process.env.GOOGLE_OAUTH_CLIENT_ID = 'test-google-id'
    process.env.GOOGLE_OAUTH_CLIENT_SECRET = 'test-google-secret'

    const url = buildAuthUrl('google', 'test-corp')
    expect(url).toContain('accounts.google.com')
    expect(url).toContain('client_id=')
    expect(url).toContain('scope=email+profile')
    expect(url).toContain('state=')
  })

  it('should throw for unknown provider', () => {
    expect(() => buildAuthUrl('unknown', 'test-corp')).toThrow('Unknown OAuth provider')
  })

  it('should parse state with orgSlug', () => {
    const state = Buffer.from(JSON.stringify({ orgSlug: 'test-corp', nonce: '123' })).toString('base64url')
    const parsed = parseState(state)
    expect(parsed.orgSlug).toBe('test-corp')
  })

  it('should throw on invalid state', () => {
    expect(() => parseState('invalid-base64')).toThrow('Invalid OAuth state')
  })

  it('should create new user from OAuth info', async () => {
    // First register an org
    await register({
      orgName: 'OAuth Org',
      orgSlug: 'oauth-org',
      email: 'owner@oauth.com',
      username: 'owner',
      password: 'secure123',
      firstName: 'Owner',
      lastName: 'User',
    })

    const info: OAuthUserInfo = {
      provider: 'google',
      providerId: 'g-123',
      email: 'newuser@oauth.com',
      name: 'New OAuthUser',
      avatarUrl: 'https://example.com/avatar.jpg',
    }

    const { user, isNew } = await getOrCreateUser(info, 'oauth-org')

    expect(isNew).toBe(true)
    expect(user.email).toBe('newuser@oauth.com')
    expect(user.firstName).toBe('New')
    expect(user.lastName).toBe('OAuthUser')
    expect(user.role).toBe('member')

    // Verify in DB
    const dbUser = await User.findOne({ email: 'newuser@oauth.com' })
    expect(dbUser).not.toBeNull()
    expect(dbUser!.oauthProviders).toHaveLength(1)
    expect(dbUser!.oauthProviders[0].provider).toBe('google')
    expect(dbUser!.oauthProviders[0].providerId).toBe('g-123')
    expect(dbUser!.password).toBeUndefined()
  })

  it('should link OAuth to existing user by email', async () => {
    const { org, user: existingUser } = await register({
      orgName: 'Link Org',
      orgSlug: 'link-org',
      email: 'existing@link.com',
      username: 'existing',
      password: 'secure123',
      firstName: 'Existing',
      lastName: 'User',
    })

    const info: OAuthUserInfo = {
      provider: 'github',
      providerId: 'gh-456',
      email: 'existing@link.com',
      name: 'Existing User',
    }

    const { user, isNew } = await getOrCreateUser(info, 'link-org')

    expect(isNew).toBe(false)
    expect(user.email).toBe('existing@link.com')
    expect(user.username).toBe('existing') // keeps original username

    const dbUser = await User.findOne({ email: 'existing@link.com' })
    expect(dbUser!.oauthProviders).toHaveLength(1)
    expect(dbUser!.oauthProviders[0].provider).toBe('github')
  })

  it('should not duplicate OAuth provider on second login', async () => {
    await register({
      orgName: 'NoDup Org',
      orgSlug: 'nodup-org',
      email: 'owner@nodup.com',
      username: 'owner',
      password: 'secure123',
      firstName: 'Owner',
      lastName: 'User',
    })

    const info: OAuthUserInfo = {
      provider: 'google',
      providerId: 'g-789',
      email: 'oauth@nodup.com',
      name: 'OAuth NoDup',
    }

    await getOrCreateUser(info, 'nodup-org')
    await getOrCreateUser(info, 'nodup-org')

    const dbUser = await User.findOne({ email: 'oauth@nodup.com' })
    expect(dbUser!.oauthProviders).toHaveLength(1)
  })

  it('should throw if org not found', async () => {
    const info: OAuthUserInfo = {
      provider: 'google',
      providerId: 'g-999',
      email: 'nobody@test.com',
      name: 'Nobody',
    }

    expect(getOrCreateUser(info, 'nonexistent-org')).rejects.toThrow('not found')
  })

  it('should build auth URL with mode=register (no orgSlug)', () => {
    process.env.GOOGLE_OAUTH_CLIENT_ID = 'test-google-id'
    process.env.GOOGLE_OAUTH_CLIENT_SECRET = 'test-google-secret'

    const url = buildAuthUrl('google', undefined, 'register')
    expect(url).toContain('accounts.google.com')
    expect(url).toContain('client_id=')
    // state should contain mode=register
    const stateMatch = url.match(/state=([^&]+)/)
    expect(stateMatch).not.toBeNull()
    const decoded = JSON.parse(Buffer.from(decodeURIComponent(stateMatch![1]), 'base64url').toString('utf8'))
    expect(decoded.mode).toBe('register')
    expect(decoded.orgSlug).toBeUndefined()
  })

  it('should parse state with mode=register', () => {
    const state = Buffer.from(JSON.stringify({ mode: 'register', nonce: '456' })).toString('base64url')
    const parsed = parseState(state)
    expect(parsed.mode).toBe('register')
    expect(parsed.orgSlug).toBeUndefined()
  })

  it('should register new user+org with OAuth (registerWithOAuth)', async () => {
    const info: OAuthUserInfo = {
      provider: 'google',
      providerId: 'g-reg-001',
      email: 'newadmin@oauthreg.com',
      name: 'OAuth Admin',
      avatarUrl: 'https://example.com/avatar.jpg',
    }

    const { user, isNew } = await registerWithOAuth(info, 'OAuth Reg Org', 'oauth-reg-org', 'oauthadmin')

    expect(isNew).toBe(true)
    expect(user.email).toBe('newadmin@oauthreg.com')
    expect(user.username).toBe('oauthadmin')
    expect(user.firstName).toBe('OAuth')
    expect(user.lastName).toBe('Admin')
    expect(user.role).toBe('admin')

    // Verify org created
    const org = await Org.findOne({ slug: 'oauth-reg-org' })
    expect(org).not.toBeNull()
    expect(org!.name).toBe('OAuth Reg Org')
    expect(String(org!.ownerId)).toBe(user.id)

    // Verify user in DB
    const dbUser = await User.findOne({ email: 'newadmin@oauthreg.com' })
    expect(dbUser).not.toBeNull()
    expect(dbUser!.oauthProviders).toHaveLength(1)
    expect(dbUser!.oauthProviders[0].provider).toBe('google')
    expect(dbUser!.oauthProviders[0].providerId).toBe('g-reg-001')
    expect(dbUser!.password).toBeUndefined()
    expect(String(dbUser!.orgId)).toBe(String(org!._id))
  })

  it('should reject registerWithOAuth if org slug is taken', async () => {
    await register({
      orgName: 'Taken Org',
      orgSlug: 'taken-org',
      email: 'owner@taken.com',
      username: 'takenowner',
      password: 'secure123',
      firstName: 'Owner',
      lastName: 'User',
    })

    const info: OAuthUserInfo = {
      provider: 'github',
      providerId: 'gh-reg-001',
      email: 'oauth@taken.com',
      name: 'OAuth User',
    }

    expect(registerWithOAuth(info, 'Another Org', 'taken-org', 'oauthuser')).rejects.toThrow('already taken')
  })

  it('OAuth user should not have a password set', async () => {
    await register({
      orgName: 'PassCheck Org',
      orgSlug: 'passcheck-org',
      email: 'owner@passcheck.com',
      username: 'owner',
      password: 'secure123',
      firstName: 'Owner',
      lastName: 'User',
    })

    const info: OAuthUserInfo = {
      provider: 'microsoft',
      providerId: 'ms-111',
      email: 'oauthonly@passcheck.com',
      name: 'OAuth Only',
    }

    await getOrCreateUser(info, 'passcheck-org')

    // Verify no password set
    const dbUser = await User.findOne({ email: 'oauthonly@passcheck.com' })
    expect(dbUser!.password).toBeUndefined()
  })
})
