import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { captureRejection, expectRejection } from '../helpers/capture-rejection'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { register } from 'services/biz/auth.service'
import {
  buildAuthUrl,
  parseState,
  getOrCreateUser,
  createLoginHandoff,
  redeemLoginHandoff,
  HandoffError,
  HANDOFF_REFUSED,
  type OAuthUserInfo,
} from 'services/biz/oauth.service'
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
  emailVerified: false,
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
    // S-20: a member matched by EMAIL links only when the provider verified that email.
    const info = { ...stranger, email: 'staff@member-org.example', emailVerified: true }

    const { user, isNew } = await getOrCreateUser(info, 'member-org')
    expect(isNew).toBe(false)
    expect(user.email).toBe('staff@member-org.example')
  })

  it('admits a stranger holding a valid invite, with the invite’s role', async () => {
    const { org, ownerId } = await seedOrg('invited-org')
    const invite = await inviteDao.createInvite({
      orgId: String(org._id), inviterId: ownerId, maxUses: 1, assignRole: 'accountant',
    })

    // Verified: an invite admits a stranger, but only a provider-verified address founds a new person.
    const { user, isNew } = await getOrCreateUser({ ...stranger, emailVerified: true }, 'invited-org', invite.code)
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

    // Both verified, so the only thing standing between the second person and the org is the invite.
    await getOrCreateUser({ ...stranger, emailVerified: true }, 'once-org', invite.code)
    const second = { ...stranger, providerId: 'g-second', email: 'second@gmail.com', emailVerified: true }
    const err = await captureRejection(getOrCreateUser(second, 'once-org', invite.code))
    expectRejection(err, 'exhausted') // inviteDao.validate's own wording for a spent invite

    expect(await User.findOne({ email: 'second@gmail.com' })).toBeNull()
  })
})

describe('S-20 — an OAuth email links an existing account only when the provider verified it', () => {
  /**
   * The published "nOAuth" account takeover. `getOrCreateUser` used to find the member by
   * `info.email` alone and sign in as them — but a provider email is proof of identity only if the
   * PROVIDER verified it. Microsoft Graph's `mail` is set by the admin of any Entra tenant and
   * verified by nobody (so is Facebook's address), so an attacker mints a tenant, sets `mail` to a
   * victim admin's address, calls the multi-tenant login, and is signed in as that admin — payroll
   * and all.
   *
   * S-17 closed self-ENROLMENT (joining an org you are not in). This is the EXISTING-member path
   * S-17 did not touch, which is exactly where this attack lands. The properties below:
   *   1. an unverified email never links to, or signs in as, an existing member;
   *   2. a verified email still does, and an already-linked identity still does regardless;
   *   3. a deactivated account cannot sign in by either route, in parity with password login;
   *   4. not-a-member, unverified and deactivated are ONE refusal string, so the endpoint cannot
   *      be used to enumerate who belongs to an org.
   */

  // ── Negative: an unverified email must not reach an existing (active) member ──────────────

  it('refuses a Microsoft identity whose email equals an existing member (nOAuth) and links nothing', async () => {
    const { org } = await seedOrg('ms-victim')
    await User.create({
      email: 'cfo@ms-victim.example', username: 'cfo', firstName: 'C', lastName: 'FO',
      role: 'admin', orgId: org._id, isActive: true, permissions: [],
    })
    const attacker: OAuthUserInfo = {
      provider: 'microsoft', providerId: 'ms-attacker', email: 'cfo@ms-victim.example',
      name: 'Not The CFO', emailVerified: false, // Microsoft `mail` is admin-set — always false
    }
    const err = await captureRejection(getOrCreateUser(attacker, 'ms-victim'))
    expectRejection(err, 'Ask an administrator for an invitation')

    const victim = await User.findOne({ email: 'cfo@ms-victim.example' })
    expect((victim!.oauthProviders || []).some((p) => p.provider === 'microsoft')).toBe(false)
  })

  it('refuses the same for Google when verified_email was false', async () => {
    const { org } = await seedOrg('g-victim')
    await User.create({
      email: 'staff@g-victim.example', username: 'staff', firstName: 'S', lastName: 'T',
      role: 'member', orgId: org._id, isActive: true, permissions: [],
    })
    const attacker: OAuthUserInfo = {
      provider: 'google', providerId: 'g-attacker2', email: 'staff@g-victim.example',
      name: 'x', emailVerified: false,
    }
    const err = await captureRejection(getOrCreateUser(attacker, 'g-victim'))
    expectRejection(err, 'Ask an administrator for an invitation')
    const victim = await User.findOne({ email: 'staff@g-victim.example' })
    expect((victim!.oauthProviders || []).some((p) => p.provider === 'google')).toBe(false)
  })

  it('refuses the same for Facebook, which sends no verification signal at all', async () => {
    const { org } = await seedOrg('fb-victim')
    await User.create({
      email: 'boss@fb-victim.example', username: 'boss', firstName: 'B', lastName: 'S',
      role: 'admin', orgId: org._id, isActive: true, permissions: [],
    })
    const attacker: OAuthUserInfo = {
      provider: 'facebook', providerId: 'fb-attacker', email: 'boss@fb-victim.example',
      name: 'x', emailVerified: false,
    }
    const err = await captureRejection(getOrCreateUser(attacker, 'fb-victim'))
    expectRejection(err, 'Ask an administrator for an invitation')
    const victim = await User.findOne({ email: 'boss@fb-victim.example' })
    expect((victim!.oauthProviders || []).some((p) => p.provider === 'facebook')).toBe(false)
  })

  it('refuses a pinned invite when the provider did not verify the email', async () => {
    const { org, ownerId } = await seedOrg('pin-unverified')
    const invite = await inviteDao.createInvite({
      orgId: String(org._id), inviterId: ownerId, maxUses: 1, targetEmail: 'newhire@pin-unverified.example',
    })
    // The email MATCHES the pin, but an unverified address can be set to anything, so the pin —
    // which exists to restrict the invite to one person — protects nothing here.
    const info: OAuthUserInfo = {
      provider: 'microsoft', providerId: 'ms-hire', email: 'newhire@pin-unverified.example',
      name: 'New Hire', emailVerified: false,
    }
    const err = await captureRejection(getOrCreateUser(info, 'pin-unverified', invite.code))
    expectRejection(err, 'Complete your sign-up with a password')
    expect(await User.findOne({ email: 'newhire@pin-unverified.example' })).toBeNull()
  })

  // ── Deactivated accounts cannot sign in by EITHER route (parity with password login) ─────

  it('refuses a deactivated member who signs in with an ALREADY-LINKED identity', async () => {
    const { org } = await seedOrg('deact-linked')
    await User.create({
      email: 'ex@deact-linked.example', username: 'ex', firstName: 'E', lastName: 'X',
      role: 'member', orgId: org._id, isActive: false, permissions: [],
      oauthProviders: [{ provider: 'google', providerId: 'g-ex' }],
    })
    // Verified email, and the identity is already linked — the only thing left to stop them is isActive.
    const info: OAuthUserInfo = {
      provider: 'google', providerId: 'g-ex', email: 'ex@deact-linked.example', name: 'E X', emailVerified: true,
    }
    const err = await captureRejection(getOrCreateUser(info, 'deact-linked'))
    expectRejection(err, 'Ask an administrator for an invitation')
  })

  it('refuses a deactivated member matched by a VERIFIED email, and links nothing', async () => {
    const { org } = await seedOrg('deact-email')
    await User.create({
      email: 'ex2@deact-email.example', username: 'ex2', firstName: 'E', lastName: 'X2',
      role: 'member', orgId: org._id, isActive: false, permissions: [],
    })
    const info: OAuthUserInfo = {
      provider: 'google', providerId: 'g-new', email: 'ex2@deact-email.example', name: 'E X2', emailVerified: true,
    }
    const err = await captureRejection(getOrCreateUser(info, 'deact-email'))
    expectRejection(err, 'Ask an administrator for an invitation')
    const dead = await User.findOne({ email: 'ex2@deact-email.example' })
    expect((dead!.oauthProviders || []).length).toBe(0)
  })

  it('gives ONE refusal for not-a-member, unverified and deactivated — no membership oracle', async () => {
    const { org } = await seedOrg('oracle-org')
    await User.create({
      email: 'real@oracle-org.example', username: 'real', firstName: 'R', lastName: 'L',
      role: 'member', orgId: org._id, isActive: true, permissions: [],
    })
    await User.create({
      email: 'gone@oracle-org.example', username: 'gone', firstName: 'G', lastName: 'One',
      role: 'member', orgId: org._id, isActive: false, permissions: [],
    })

    const notMember = await captureRejection(
      getOrCreateUser({ ...stranger, email: 'nobody@oracle-org.example' }, 'oracle-org'),
    )
    const unverified = await captureRejection(
      getOrCreateUser({ provider: 'microsoft', providerId: 'ms-o', email: 'real@oracle-org.example', name: 'x', emailVerified: false }, 'oracle-org'),
    )
    const deactivated = await captureRejection(
      getOrCreateUser({ provider: 'google', providerId: 'g-o', email: 'gone@oracle-org.example', name: 'x', emailVerified: true }, 'oracle-org'),
    )

    expectRejection(notMember, 'Ask an administrator for an invitation')
    expectRejection(unverified, 'Ask an administrator for an invitation')
    expectRejection(deactivated, 'Ask an administrator for an invitation')
    // The whole point: the three are indistinguishable, so you cannot probe who is a member.
    expect(notMember.message).toBe(unverified.message)
    expect(unverified.message).toBe(deactivated.message)
    // And the message does not leak the address that was tried.
    expect(unverified.message).not.toContain('real@oracle-org.example')
  })

  // ── Positive controls: the good paths still work ─────────────────────────────────────────

  it('signs in an already-linked identity even when the current email is unverified', async () => {
    const { org } = await seedOrg('linked-org')
    const member = await User.create({
      email: 'person@linked-org.example', username: 'person', firstName: 'Per', lastName: 'Son',
      role: 'member', orgId: org._id, isActive: true, permissions: [],
      oauthProviders: [{ provider: 'microsoft', providerId: 'ms-kept' }],
    })
    // The provider now reports a different, unverified address. A linked identity is trusted on the
    // (provider, providerId) pair, not the email — the link was made on an earlier authorised sign-in.
    const info: OAuthUserInfo = {
      provider: 'microsoft', providerId: 'ms-kept', email: 'changed@elsewhere.example', name: 'Per Son', emailVerified: false,
    }
    const { user, isNew } = await getOrCreateUser(info, 'linked-org')
    expect(isNew).toBe(false)
    expect(user.id).toBe(String(member._id))
    expect(user.email).toBe('person@linked-org.example') // signs in AS the member; the email is not overwritten
  })

  it('links a verified Google email to an existing member', async () => {
    const { org } = await seedOrg('gverify-org')
    const member = await User.create({
      email: 'joins@gverify-org.example', username: 'joins', firstName: 'Jo', lastName: 'Ins',
      role: 'member', orgId: org._id, isActive: true, permissions: [],
    })
    const info: OAuthUserInfo = {
      provider: 'google', providerId: 'g-verified', email: 'joins@gverify-org.example', name: 'Jo Ins', emailVerified: true,
    }
    const { user, isNew } = await getOrCreateUser(info, 'gverify-org')
    expect(isNew).toBe(false)
    expect(user.id).toBe(String(member._id))
    const db = await User.findOne({ email: 'joins@gverify-org.example' })
    expect((db!.oauthProviders || []).some((p) => p.provider === 'google' && p.providerId === 'g-verified')).toBe(true)
  })

  it('still admits a stranger holding an UNPINNED invite — it is a bearer secret', async () => {
    const { org, ownerId } = await seedOrg('unpinned-org')
    const invite = await inviteDao.createInvite({
      orgId: String(org._id), inviterId: ownerId, maxUses: 1, assignRole: 'accountant',
    })
    const info: OAuthUserInfo = { ...stranger, email: 'contractor@elsewhere.example', emailVerified: true }
    const { user, isNew } = await getOrCreateUser(info, 'unpinned-org', invite.code)
    expect(isNew).toBe(true)
    expect(user.role).toBe('accountant')
  })

  it('but an unverified email can no longer found the person it admits (multi-org Phase 1B)', async () => {
    // This test used to read "verified or not". Since an account is global, the email it is created
    // with is the person's sign-in and password-reset address everywhere. An unverified one (any
    // Microsoft tenant's `mail`) would put on a NEW person an address nobody proved: whoever owns it
    // could later reset the password and inherit an account the attacker's provider still opens.
    // The invite itself is untouched, so the person can complete it with a password instead.
    const { org, ownerId } = await seedOrg('unpinned-unverified')
    const invite = await inviteDao.createInvite({
      orgId: String(org._id), inviterId: ownerId, maxUses: 1, assignRole: 'accountant',
    })
    const info: OAuthUserInfo = { ...stranger, email: 'contractor@elsewhere.example', emailVerified: false }
    const err = await captureRejection(getOrCreateUser(info, 'unpinned-unverified', invite.code))
    expectRejection(err, 'did not confirm this email')
    expect(await User.findOne({ email: 'contractor@elsewhere.example' })).toBeNull()
    expect((await inviteDao.findByCode(invite.code))!.useCount).toBe(0)
  })

  // ── The S-05 handoff must re-check the account at redeem, not only at the callback ────────

  it('refuses to redeem an S-05 handoff for a member deactivated after the callback', async () => {
    const { org } = await seedOrg('handoff-deact')
    const member = await User.create({
      email: 'live@handoff-deact.example', username: 'live', firstName: 'Li', lastName: 'Ve',
      role: 'member', orgId: org._id, isActive: true, permissions: [],
    })
    const payload = {
      id: String(member._id), email: member.email, username: 'live', firstName: 'Li', lastName: 'Ve',
      role: 'member', orgId: String(org._id), permissions: [], ownRecordsModules: [],
    }
    const code = await createLoginHandoff(payload)
    // An admin disables the account in the window between the callback minting the code and the SPA
    // redeeming it. Without a re-check, the stored claims would still mint a full session.
    await User.updateOne({ _id: member._id }, { $set: { isActive: false } })

    const err = await captureRejection(redeemLoginHandoff(code))
    expect(err).toBeInstanceOf(HandoffError)
    expect((err as Error).message).toBe(HANDOFF_REFUSED)
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
