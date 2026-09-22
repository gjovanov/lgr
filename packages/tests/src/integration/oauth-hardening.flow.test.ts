import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { captureRejection, expectRejection } from '../helpers/capture-rejection'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { register } from 'services/biz/auth.service'
import { buildAuthUrl, parseState, getOrCreateUser, type OAuthUserInfo } from 'services/biz/oauth.service'
import { inviteDao } from 'services/dao/invite.dao'
import { User } from 'db/models'

/**
 * The two OAuth holes from the 2026-09-21 review (#49), asserted closed.
 *
 * ⚠ They are separate findings with separate fixes, and the distinction is the point:
 *
 *   S-04 (login CSRF) — `state` carried a nonce nobody remembered, so the callback completed
 *         for anybody. Fixed by binding the nonce to an httpOnly cookie.
 *   S-17 (self-enrolment) — `orgSlug` is the CALLER's choice, and `getOrCreateUser` created a
 *         `member` in whatever org it named. Fixed by requiring membership to pre-exist or be
 *         granted by an invite.
 *
 * Verifying the state does NOT close S-17: the attacker drives their own browser, so their own
 * nonce matches perfectly. A test that only covered the nonce would have looked like coverage.
 */

beforeAll(async () => { await setupTestDB() })
afterAll(async () => { await teardownTestDB() })
afterEach(async () => { await clearCollections() })

const stranger: OAuthUserInfo = {
  provider: 'google', providerId: 'g-attacker', email: 'attacker@gmail.com', name: 'A Stranger',
}

async function seedOrg(slug: string) {
  const { org, user } = await register({
    orgName: `Org ${slug}`, orgSlug: slug, email: `owner@${slug}.example`,
    username: `owner_${slug}`, password: 'secure123', firstName: 'Ow', lastName: 'Ner',
  })
  return { org, ownerId: String(user._id) }
}

describe('S-17 — OAuth may not self-enrol into an organisation', () => {
  it('refuses a stranger naming an org they have no relationship with', async () => {
    await seedOrg('victim-ltd')

    // The whole attack, before the fix: the victim org's slug is all it took.
    const err = await captureRejection(getOrCreateUser(stranger, 'victim-ltd'))
    expectRejection(err, 'Ask an administrator for an invitation')

    expect(await User.findOne({ email: 'attacker@gmail.com' })).toBeNull()
  })

  it('still signs in someone who is already a member', async () => {
    const { org } = await seedOrg('member-org')
    await User.create({
      email: 'staff@member-org.example', username: 'staff', firstName: 'St', lastName: 'Aff',
      role: 'member', orgId: org._id, isActive: true, permissions: [],
    })
    const info = { ...stranger, email: 'staff@member-org.example' }

    const { user, isNew } = await getOrCreateUser(info, 'member-org')
    expect(isNew).toBe(false)
    expect(user.email).toBe('staff@member-org.example')
  })

  it('admits a stranger holding a valid invite, with the invite’s role', async () => {
    const { org, ownerId } = await seedOrg('invited-org')
    const invite = await inviteDao.createInvite({
      orgId: String(org._id), inviterId: ownerId, maxUses: 1, assignRole: 'accountant',
    })

    const { user, isNew } = await getOrCreateUser(stranger, 'invited-org', invite.code)
    expect(isNew).toBe(true)
    expect(user.role).toBe('accountant') // the invite decides, not a hardcoded 'member'
  })

  it('refuses an invite issued by a DIFFERENT org', async () => {
    await seedOrg('target-org')
    const { org: other, ownerId } = await seedOrg('other-org')
    const invite = await inviteDao.createInvite({
      orgId: String(other._id), inviterId: ownerId, maxUses: 1,
    })

    // A valid invite somewhere else must not become a key to anywhere else.
    const err = await captureRejection(getOrCreateUser(stranger, 'target-org', invite.code))
    expectRejection(err, 'different organisation')
    expect(await User.findOne({ email: 'attacker@gmail.com' })).toBeNull()
  })

  it('refuses an invite pinned to someone else’s email', async () => {
    const { org, ownerId } = await seedOrg('pinned-org')
    const invite = await inviteDao.createInvite({
      orgId: String(org._id), inviterId: ownerId, maxUses: 1, targetEmail: 'the.real.hire@example.com',
    })

    const err = await captureRejection(getOrCreateUser(stranger, 'pinned-org', invite.code))
    expectRejection(err, 'different email address')
  })

  it('refuses a bad invite code', async () => {
    await seedOrg('badcode-org')
    const err = await captureRejection(getOrCreateUser(stranger, 'badcode-org', 'not-a-real-code'))
    expectRejection(err, 'Invalid invite code')
  })

  it('will not let a single-use invite admit two people', async () => {
    const { org, ownerId } = await seedOrg('once-org')
    const invite = await inviteDao.createInvite({
      orgId: String(org._id), inviterId: ownerId, maxUses: 1,
    })

    await getOrCreateUser(stranger, 'once-org', invite.code)
    const second = { ...stranger, providerId: 'g-second', email: 'second@gmail.com' }
    const err = await captureRejection(getOrCreateUser(second, 'once-org', invite.code))
    expectRejection(err, 'exhausted') // inviteDao.validate's own wording for a spent invite

    expect(await User.findOne({ email: 'second@gmail.com' })).toBeNull()
  })
})

describe('S-04 — the OAuth state nonce', () => {
  it('round-trips the caller’s nonce rather than inventing its own', () => {
    process.env.GOOGLE_OAUTH_CLIENT_ID = 'test-google-id'
    const url = buildAuthUrl('google', 'some-org', 'login', 'the-known-nonce')
    const state = decodeURIComponent(new URL(url).searchParams.get('state')!)

    // The controller can only compare the callback against its cookie if the value it chose
    // is the value that travels. Before the fix this function minted its own and discarded it.
    expect(parseState(state).nonce).toBe('the-known-nonce')
    expect(parseState(state).orgSlug).toBe('some-org')
  })

  it('refuses to start a flow with no nonce', () => {
    process.env.GOOGLE_OAUTH_CLIENT_ID = 'test-google-id'
    expect(() => buildAuthUrl('google', 'some-org', 'login', '')).toThrow('requires a nonce')
  })

  it('carries an invite code through the provider round trip', () => {
    process.env.GOOGLE_OAUTH_CLIENT_ID = 'test-google-id'
    const url = buildAuthUrl('google', 'some-org', 'login', 'n', 'INVITE-123')
    const state = decodeURIComponent(new URL(url).searchParams.get('state')!)
    expect(parseState(state).inviteCode).toBe('INVITE-123')
  })

  /**
   * ⚠ `parseState` reads attacker-influenced data. It must not become a way to inject fields
   * the callback never asked for, and it must not hand back a non-string where a string is
   * expected — `orgSlug.toLowerCase()` on a number is a 500, not a login page.
   */
  it('coerces a hostile state to known string fields only', () => {
    const hostile = Buffer.from(JSON.stringify({
      orgSlug: { $ne: null }, mode: 42, nonce: ['a'], inviteCode: 'x', isAdmin: true,
    })).toString('base64url')

    const parsed = parseState(hostile) as Record<string, unknown>
    expect(parsed.orgSlug).toBeUndefined()
    expect(parsed.mode).toBeUndefined()
    expect(parsed.nonce).toBeUndefined()
    expect(parsed.inviteCode).toBe('x')
    expect(parsed.isAdmin).toBeUndefined() // not copied through
  })

  it('throws on a state that is not an object', () => {
    const notObject = Buffer.from(JSON.stringify('just a string')).toString('base64url')
    expect(() => parseState(notObject)).toThrow('Invalid OAuth state parameter')
  })
})
