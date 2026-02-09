import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { register } from 'services/biz/auth.service'
import {
  buildAuthUrl,
  getOrCreateUser,
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
    // This will throw if GOOGLE_OAUTH_CLIENT_ID is not set in config
    // For test, we set env vars
    process.env.GOOGLE_OAUTH_CLIENT_ID = 'test-google-id'
    process.env.GOOGLE_OAUTH_CLIENT_SECRET = 'test-google-secret'

    const url = buildAuthUrl('google', 'test-corp')
    expect(url).toContain('accounts.google.com')
    expect(url).toContain('client_id=test-google-id')
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
