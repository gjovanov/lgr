import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'bun:test'
import { Elysia } from 'elysia'
import jwt from '@elysiajs/jwt'
import { setupTestDB, teardownTestDB } from '../setup'
import { createTestOrg, createTestUser } from '../helpers/factories'
import { captureRejection } from '../helpers/capture-rejection'
import { createApiApp } from '../../../portal-api/src/api.js'
import { config } from 'config'
import { DEFAULT_ROLE_PERMISSIONS } from 'config/constants'
import { Identity, Invite, Org, User } from 'db/models'
import { register } from 'services/biz/auth.service'
import { getOrCreateUser, registerWithOAuth, type OAuthUserInfo } from 'services/biz/oauth.service'
import { inviteDao } from 'services/dao/invite.dao'
import { codeDao } from 'services/dao/code.dao'
import { IdentityError } from 'services/biz/identity/identity.service'
import type { Types } from 'mongoose'

/**
 * Multi-org sign-in, Phase 1B: every path that creates or edits a user keeps the person's
 * `Identity` in step, so the migration can run and sign-in can move onto identities.
 *
 * The rule the admin paths hold: **an org admin never controls the credentials of someone who
 * also works in another org.** An admin who could set the password of a person also in org B
 * would have org B. So creating a user at an address that is already someone's is refused (the
 * person is invited and joins by proving it is them), and the password, email and name of a
 * person active elsewhere are theirs alone. Role, permissions and position stay per org.
 */

let app: Elysia
const signer = new Elysia().use(jwt({ name: 'jwt', secret: config.jwt.secret }))
const sign = (claims: Record<string, unknown>): Promise<string> => (signer as any).decorator.jwt.sign(claims)
// Fresh per run: no credential-shaped literal in the repository.
const PW_A = crypto.randomUUID()
const PW_B = crypto.randomUUID()

beforeAll(async () => {
  await setupTestDB()
  await Identity.init()
  await User.init()
  app = new Elysia().use(createApiApp())
}, 120_000)

afterAll(async () => {
  await teardownTestDB()
}, 60_000)

beforeEach(async () => {
  await Identity.deleteMany({}).exec()
})

let seq = 0
async function org(prefix = 'org') {
  return createTestOrg({ slug: `${prefix}-${Date.now()}-${++seq}` } as any)
}

/** An admin of `o` (an unlinked user, which is all the guard needs) and their bearer token. */
async function adminOf(o: { _id: unknown }) {
  const admin = await createTestUser(o._id as Types.ObjectId, { role: 'admin' } as any)
  const token = await sign({
    id: String(admin._id),
    orgId: String(o._id),
    email: admin.email,
    username: admin.username,
    firstName: 'A',
    lastName: 'Dmin',
    role: 'admin',
    permissions: DEFAULT_ROLE_PERMISSIONS.admin,
    ownRecordsModules: [],
    exp: Math.floor(Date.now() / 1000) + 3600,
  })
  return { admin, token }
}

async function api(method: string, path: string, token: string, body?: unknown) {
  const res = await app.handle(
    new Request(`http://localhost/api${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  )
  return { status: res.status, body: (await res.json().catch(() => null)) as any }
}

const person = (email: string, extra: Record<string, unknown> = {}) => ({
  email,
  username: email.split('@')[0].replace(/[^a-z0-9]/gi, '').slice(0, 20) + seq,
  password: PW_A,
  firstName: 'Pat',
  lastName: 'Doe',
  ...extra,
})

/** One person, active in two orgs: an identity with a membership in each. */
async function sharedPerson(email: string) {
  const a = await org('shared-a')
  const b = await org('shared-b')
  const identity = await Identity.create({ email, firstName: 'Sam', lastName: 'Two', password: await Bun.password.hash(PW_A), passwordSetBy: 'self' })
  const inA = await createTestUser(a._id as Types.ObjectId, { email, identityId: identity._id, firstName: 'Sam', lastName: 'Two' } as any)
  const inB = await createTestUser(b._id as Types.ObjectId, { email, identityId: identity._id, firstName: 'Sam', lastName: 'Two' } as any)
  return { a, b, identity, inA, inB }
}

// ── An admin creating a user ─────────────────────────────────────────────────────────────────

describe('an admin creating a user', () => {
  it("creates the person's identity with the membership: admin-set password, active, unverified", async () => {
    const o = await org()
    const { token } = await adminOf(o)

    const res = await api('POST', `/org/${o._id}/user`, token, person('New.Person@Example.com'))
    expect(res.status).toBe(200)

    const identity = await Identity.findOne({ email: 'new.person@example.com' }).select('+password').lean().exec()
    expect(identity).not.toBeNull()
    expect(identity!.passwordSetBy).toBe('admin')
    expect(String(identity!.passwordSetByOrgId)).toBe(String(o._id))
    expect(identity!.isActive).toBe(true)
    expect(identity!.emailVerified).toBe(false)
    expect(identity!.lastOrgId).toBeUndefined() // only the person's own sign-ins set it
    expect(await Bun.password.verify(PW_A, identity!.password!)).toBe(true)

    const member = await User.findById(res.body.user._id).lean().exec()
    expect(String(member!.identityId)).toBe(String(identity!._id))
    expect(member!.email).toBe('new.person@example.com')
  })

  it("refuses an address that is already someone's, and creates nothing", async () => {
    const o = await org()
    const { token } = await adminOf(o)
    await Identity.create({ email: 'taken@example.com', firstName: 'T', lastName: 'Aken' })

    const res = await api('POST', `/org/${o._id}/user`, token, person('Taken@Example.com'))
    expect(res.status).toBe(409)
    expect(res.body.code).toBe('identity_exists')
    expect(await User.countDocuments({ orgId: o._id, email: /taken@example\.com/i })).toBe(0)
  })

  it('counts an unlinked user in another org as someone too, until the migration has run', async () => {
    const elsewhere = await org('elsewhere')
    await createTestUser(elsewhere._id as Types.ObjectId, { email: 'Waiting@Example.com' } as any)
    const o = await org()
    const { token } = await adminOf(o)

    const res = await api('POST', `/org/${o._id}/user`, token, person('waiting@example.com'))
    expect(res.status).toBe(409)
    expect(res.body.code).toBe('identity_exists')
    expect(await Identity.countDocuments({ email: 'waiting@example.com' })).toBe(0)
  })

  it('leaves no identity behind when the membership itself cannot be created', async () => {
    const o = await org()
    const { token } = await adminOf(o)
    await createTestUser(o._id as Types.ObjectId, { username: 'dupname' } as any)

    const res = await api('POST', `/org/${o._id}/user`, token, person('fresh@example.com', { username: 'dupname' }))
    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(await Identity.countDocuments({ email: 'fresh@example.com' })).toBe(0)
  })
})

// ── An admin editing a user ──────────────────────────────────────────────────────────────────

describe('an admin editing a user', () => {
  it('changes the password of someone who works only here: the identity, its revocation counter and the legacy copy move together', async () => {
    const o = await org()
    const { token } = await adminOf(o)
    const created = await api('POST', `/org/${o._id}/user`, token, person('solo@example.com'))
    const userId = created.body.user._id

    const res = await api('PUT', `/org/${o._id}/user/${userId}`, token, { password: PW_B })
    expect(res.status).toBe(200)

    const identity = await Identity.findOne({ email: 'solo@example.com' }).select('+password').lean().exec()
    expect(await Bun.password.verify(PW_B, identity!.password!)).toBe(true)
    expect(identity!.passwordSetBy).toBe('admin')
    expect(identity!.tokenVersion).toBe(1)
    const member = await User.findById(userId).lean().exec()
    expect(await Bun.password.verify(PW_B, member!.password!)).toBe(true)
  })

  it('refuses the password, email and name of a person active in another org, but not their role or position', async () => {
    const { a, identity, inA } = await sharedPerson('both@example.com')
    const { token } = await adminOf(a)
    const path = `/org/${a._id}/user/${inA._id}`

    for (const edit of [{ password: PW_B }, { email: 'moved@example.com' }, { firstName: 'Renamed' }, { lastName: 'Renamed' }]) {
      const res = await api('PUT', path, token, edit)
      expect({ edit: Object.keys(edit)[0], status: res.status, code: res.body?.code }).toEqual({
        edit: Object.keys(edit)[0],
        status: 403,
        code: 'identity_shared',
      })
    }
    const after = await Identity.findById(identity._id).select('+password').lean().exec()
    expect(await Bun.password.verify(PW_A, after!.password!)).toBe(true)
    expect(after!.email).toBe('both@example.com')
    expect(after!.firstName).toBe('Sam')

    const ok = await api('PUT', path, token, { position: 'Buyer', role: 'manager' })
    expect(ok.status).toBe(200)
    expect((await User.findById(inA._id).lean().exec())!.position).toBe('Buyer')
  })

  it('lets the admin manage the person again once their other membership is deactivated', async () => {
    const { a, inA, inB, identity } = await sharedPerson('left@example.com')
    await User.updateOne({ _id: inB._id }, { $set: { isActive: false, deactivatedAt: new Date() } })
    const { token } = await adminOf(a)

    const res = await api('PUT', `/org/${a._id}/user/${inA._id}`, token, { password: PW_B })
    expect(res.status).toBe(200)
    const after = await Identity.findById(identity._id).select('+password').lean().exec()
    expect(await Bun.password.verify(PW_B, after!.password!)).toBe(true)
    // The legacy copy follows on every membership, so a rollback still signs the person in.
    expect(await Bun.password.verify(PW_B, (await User.findById(inB._id).lean().exec())!.password!)).toBe(true)
  })

  it("refuses an email that is someone else's", async () => {
    const o = await org()
    const { token } = await adminOf(o)
    const created = await api('POST', `/org/${o._id}/user`, token, person('mine@example.com'))
    await Identity.create({ email: 'theirs@example.com', firstName: 'T', lastName: 'Heirs' })
    const unlinkedElsewhere = await org('unlinked')
    await createTestUser(unlinkedElsewhere._id as Types.ObjectId, { email: 'Pending.Migration@Example.com' } as any)

    for (const email of ['theirs@example.com', 'pending.migration@example.com']) {
      const res = await api('PUT', `/org/${o._id}/user/${created.body.user._id}`, token, { email })
      expect({ email, status: res.status, code: res.body?.code }).toEqual({ email, status: 409, code: 'email_taken' })
    }
  })

  it('edits an unlinked user (before the migration) exactly as before', async () => {
    const o = await org()
    const { token } = await adminOf(o)
    const unlinked = await createTestUser(o._id as Types.ObjectId, { email: 'old.style@example.com' } as any)

    const res = await api('PUT', `/org/${o._id}/user/${unlinked._id}`, token, { password: PW_B, firstName: 'Newname' })
    expect(res.status).toBe(200)
    const after = await User.findById(unlinked._id).lean().exec()
    expect(await Bun.password.verify(PW_B, after!.password!)).toBe(true)
    expect(after!.firstName).toBe('Newname')
    expect(after!.identityId).toBeUndefined()
    expect(await Identity.countDocuments({})).toBe(0)
  })
})

// ── Self-registration ────────────────────────────────────────────────────────────────────────

describe('registering', () => {
  it('creates a pending identity with a self-chosen password, which activation completes', async () => {
    const slug = `reg-${Date.now()}`
    const { user } = await register({ orgName: 'Reg Org', orgSlug: slug, ...person('Founder@Example.com') })

    const pending = await Identity.findOne({ email: 'founder@example.com' }).lean().exec()
    expect(pending!.isActive).toBe(false)
    expect(pending!.passwordSetBy).toBe('self')
    expect(pending!.emailVerified).toBe(false)
    expect(String(user.identityId)).toBe(String(pending!._id))

    const { token: code } = await codeDao.createActivationCode(String(user._id), String(user.orgId), 30)
    const res = await app.handle(
      new Request('http://localhost/api/auth/activate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ userId: String(user._id), token: code }),
      }),
    )
    expect(res.status).toBe(200)
    const active = await Identity.findById(pending!._id).lean().exec()
    expect(active!.isActive).toBe(true)
    expect(active!.emailVerified).toBe(true)
  })

  it('refuses an address that already has an account, over HTTP as 409, and founds no org', async () => {
    await Identity.create({ email: 'has.account@example.com', firstName: 'H', lastName: 'As' })
    const slug = `reg-dup-${Date.now()}`

    const thrown = await captureRejection(register({ orgName: 'Dup', orgSlug: slug, ...person('Has.Account@Example.com') }))
    expect(thrown).toBeInstanceOf(IdentityError)
    expect((thrown as IdentityError).code).toBe('account_exists')

    const res = await app.handle(
      new Request('http://localhost/api/auth/register', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ orgName: 'Dup', orgSlug: slug, ...person('has.account@example.com') }),
      }),
    )
    expect(res.status).toBe(409)
    expect(((await res.json()) as any).code).toBe('account_exists')
    expect(await Org.countDocuments({ slug })).toBe(0)
  })

  it('joins a new person to the inviting org, matching the pinned email case-insensitively', async () => {
    const o = await org('inviting')
    const { admin } = await adminOf(o)
    const invite = await inviteDao.createInvite({ orgId: String(o._id), inviterId: String(admin._id), targetEmail: 'Invitee@Example.com' })

    const { user } = await register({ ...person('invitee@example.com'), inviteCode: invite.code })
    expect(String(user.orgId)).toBe(String(o._id))
    const identity = await Identity.findOne({ email: 'invitee@example.com' }).lean().exec()
    expect(String(user.identityId)).toBe(String(identity!._id))
  })

  it('leaves no identity, and burns no invite use, when the membership cannot be created', async () => {
    const o = await org('inviting')
    const { admin } = await adminOf(o)
    await createTestUser(o._id as Types.ObjectId, { username: 'takenname' } as any)
    const invite = await inviteDao.createInvite({ orgId: String(o._id), inviterId: String(admin._id), maxUses: 1 })

    const thrown = await captureRejection(register({ ...person('nope@example.com', { username: 'takenname' }), inviteCode: invite.code }))
    expect(thrown).toBeDefined()
    expect(await Identity.countDocuments({ email: 'nope@example.com' })).toBe(0)
    expect((await Invite.findById(invite._id).lean().exec())!.useCount).toBe(0)
  })

  it('gives a claimed invite use back after a failed sign-up, but never revives a revoked invite', async () => {
    const o = await org('inviting')
    const { admin } = await adminOf(o)
    const single = await inviteDao.createInvite({ orgId: String(o._id), inviterId: String(admin._id), maxUses: 1 })
    await inviteDao.incrementUseCount(String(single._id))
    expect((await Invite.findById(single._id).lean().exec())!.status).toBe('exhausted')

    await inviteDao.releaseUse(String(single._id))
    const released = await Invite.findById(single._id).lean().exec()
    expect([released!.useCount, released!.status]).toEqual([0, 'active'])

    const revoked = await inviteDao.createInvite({ orgId: String(o._id), inviterId: String(admin._id), maxUses: 1 })
    await inviteDao.incrementUseCount(String(revoked._id))
    await Invite.updateOne({ _id: revoked._id }, { $set: { status: 'revoked' } })
    await inviteDao.releaseUse(String(revoked._id))
    expect((await Invite.findById(revoked._id).lean().exec())!.status).toBe('revoked')
  })
})

// ── OAuth ────────────────────────────────────────────────────────────────────────────────────

const google = (email: string, providerId: string, emailVerified = true): OAuthUserInfo => ({
  provider: 'google',
  providerId,
  email,
  name: 'Gee Oogle',
  emailVerified,
})

describe('OAuth', () => {
  it('founds an org with a person whose provider link is trusted and who has no password', async () => {
    const slug = `oauth-reg-${Date.now()}`
    await registerWithOAuth(google('Founder.G@Example.com', 'g-founder'), 'G Org', slug, 'founderg')

    const identity = await Identity.findOne({ email: 'founder.g@example.com' }).select('+password').lean().exec()
    expect(identity!.password).toBeUndefined()
    expect(identity!.emailVerified).toBe(true)
    expect(identity!.isActive).toBe(true)
    expect(identity!.oauthProviders.map(l => [l.provider, l.providerId, l.verified])).toEqual([['google', 'g-founder', true]])
    const member = await User.findOne({ email: 'founder.g@example.com' }).lean().exec()
    expect(String(member!.identityId)).toBe(String(identity!._id))
  })

  it('refuses to found an org on an email the provider did not verify, or one that already has an account', async () => {
    const unverified = await captureRejection(registerWithOAuth(google('x@example.com', 'g-x', false), 'X', `oauth-x-${Date.now()}`, 'xx'))
    expect((unverified as IdentityError).code).toBe('unverified_email')

    await Identity.create({ email: 'exists@example.com', firstName: 'E', lastName: 'X' })
    const exists = await captureRejection(registerWithOAuth(google('exists@example.com', 'g-e'), 'E', `oauth-e-${Date.now()}`, 'ee'))
    expect((exists as IdentityError).code).toBe('account_exists')
    expect(await Org.countDocuments({ name: 'E' })).toBe(0)
  })

  it('makes an invited stranger with a verified email a new person', async () => {
    const o = await org('og')
    const { admin } = await adminOf(o)
    const invite = await inviteDao.createInvite({ orgId: String(o._id), inviterId: String(admin._id), maxUses: 1 })

    const { user } = await getOrCreateUser(google('stranger@example.com', 'g-stranger'), o.slug, invite.code)
    const identity = await Identity.findOne({ email: 'stranger@example.com' }).lean().exec()
    expect(identity!.oauthProviders.map(l => l.providerId)).toEqual(['g-stranger'])
    expect(String((await User.findById(user.id).lean().exec())!.identityId)).toBe(String(identity!._id))
  })

  it('joins an invited person who already has an identity AS that identity, and links the provider to it', async () => {
    const { identity } = await sharedPerson('known@example.com')
    const o = await org('og')
    const { admin } = await adminOf(o)
    const invite = await inviteDao.createInvite({ orgId: String(o._id), inviterId: String(admin._id), maxUses: 1 })

    const { user } = await getOrCreateUser(google('Known@Example.com', 'g-known'), o.slug, invite.code)
    expect(String((await User.findById(user.id).lean().exec())!.identityId)).toBe(String(identity._id))
    expect(await Identity.countDocuments({ email: 'known@example.com' })).toBe(1)
    const after = await Identity.findById(identity._id).lean().exec()
    expect(after!.oauthProviders.map(l => [l.providerId, l.verified])).toEqual([['g-known', true]])
  })

  it('never founds a person on an email the provider did not verify, and burns no invite use refusing', async () => {
    const o = await org('og')
    const { admin } = await adminOf(o)
    const invite = await inviteDao.createInvite({ orgId: String(o._id), inviterId: String(admin._id), maxUses: 1 })

    const thrown = await captureRejection(getOrCreateUser({ ...google('claimed@example.com', 'ms-1', false), provider: 'microsoft' }, o.slug, invite.code))
    expect((thrown as IdentityError).code).toBe('unverified_email')
    expect(await Identity.countDocuments({})).toBe(0)
    expect(await User.countDocuments({ email: 'claimed@example.com' })).toBe(0)
    expect((await Invite.findById(invite._id).lean().exec())!.useCount).toBe(0)
  })

  it('before the migration, joins a person whose address still has unlinked users without an identity', async () => {
    const elsewhere = await org('legacy')
    await createTestUser(elsewhere._id as Types.ObjectId, { email: 'legacy@example.com' } as any)
    const o = await org('og')
    const { admin } = await adminOf(o)
    const invite = await inviteDao.createInvite({ orgId: String(o._id), inviterId: String(admin._id), maxUses: 1 })

    const { user } = await getOrCreateUser(google('legacy@example.com', 'g-legacy'), o.slug, invite.code)
    expect((await User.findById(user.id).lean().exec())!.identityId).toBeUndefined()
    // The migration groups all of them later; an identity made now would split the person in two.
    expect(await Identity.countDocuments({})).toBe(0)
  })

  it("links a provider that signs in by verified email onto the member's identity too", async () => {
    const { a, identity } = await sharedPerson('links@example.com')

    await getOrCreateUser(google('links@example.com', 'g-links'), a.slug)
    const after = await Identity.findById(identity._id).lean().exec()
    expect(after!.oauthProviders.map(l => [l.provider, l.providerId, l.verified])).toEqual([['google', 'g-links', true]])
  })
})
