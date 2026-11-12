import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { Elysia } from 'elysia'
import { createHash, randomBytes } from 'crypto'
import { config } from 'config'
import { setupTestDB, teardownTestDB } from '../setup'
import { createTestOrg, createTestUser } from '../helpers/factories'
import { createApiApp } from '../../../portal-api/src/api.js'
import { AuthToken, Code, Identity, Invite, OrgApp, PermissionSet, User } from 'db/models'
import { inviteDao } from 'services/dao/invite.dao'
import { resendActivation, sessionFor } from 'services/biz/auth.service'
import jwt from '@elysiajs/jwt'
import type { Types } from 'mongoose'

/**
 * Multi-org sign-in, Phase 4 (backend): the person's own account.
 *
 *   - change the password (proving the current one), which ends their other sessions;
 *   - forgot / reset by email, with the token stored hashed and usable once;
 *   - accept an invitation, and found an org, while signed in.
 *
 * Rule 3 runs through the last two: joining or founding another org needs a credential the person
 * owns. A password an admin set, or one the migration carried, may be known to someone else.
 */

let app: Elysia
// Fresh per run, and short-named: no credential-shaped literal sits in the repository.
const PW = crypto.randomUUID()
const PW2 = crypto.randomUUID()
let seq = 0

beforeAll(async () => {
  await setupTestDB()
  await Identity.init()
  await User.init()
  await AuthToken.init()
  app = new Elysia().use(createApiApp())
}, 120_000)

afterAll(async () => {
  await teardownTestDB()
}, 60_000)

async function call(method: string, path: string, opts: { token?: string; cookie?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (opts.token) headers.authorization = `Bearer ${opts.token}`
  if (opts.cookie) headers.cookie = opts.cookie
  const res = await app.handle(
    new Request(`http://localhost/api${path}`, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) }),
  )
  return { status: res.status, body: (await res.json().catch(() => null)) as any }
}

/** Bodies built from parameters: no literal credential pair in this file. */
const signIn = (username: string, password: string) => call('POST', '/auth/login', { body: { username, password } })
const change = (token: string, currentPassword: string, newPassword: string) =>
  call('POST', '/auth/password', { token, body: { currentPassword, newPassword } })
const signInToOrg = (username: string, password: string, orgSlug: string) => call('POST', '/auth/login', { body: { username, password, orgSlug } })
const changeBody = (currentPassword: string, newPassword: string) => ({ currentPassword, newPassword })
const reset = (token: string, newPassword: string) => call('POST', '/auth/password/reset', { body: { token, newPassword } })
const claimsOf = (token: string) => JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString())
const signer = new Elysia().use(jwt({ name: 'jwt', secret: config.jwt.secret }))
/** The session an OAuth sign-in would mint for this membership: a person with no password has no other. */
async function providerSession(member: any, identity: any) {
  const claims = await sessionFor(member, identity)
  return (signer as any).decorator.jwt.sign({ ...claims, exp: Math.floor(Date.now() / 1000) + 3600 }) as Promise<string>
}

async function org(prefix: string) {
  const o = await createTestOrg({ slug: `${prefix}-${Date.now()}-${++seq}` } as any)
  return { id: String(o._id), slug: o.slug as string, _id: o._id as Types.ObjectId }
}

/** A person with a membership in each org. `setBy` decides whose password it is (rule 3). */
async function person(
  email: string,
  orgs: { _id: Types.ObjectId }[],
  opts: { setBy?: 'self' | 'admin' | 'legacy'; password?: string | null; links?: boolean; active?: boolean } = {},
) {
  const hash = opts.password === null ? undefined : await Bun.password.hash(opts.password ?? PW)
  const identity = await Identity.create({
    email,
    firstName: 'Ac',
    lastName: 'Count',
    password: hash,
    passwordSetBy: hash ? (opts.setBy ?? 'self') : undefined,
    isActive: opts.active ?? true,
    oauthProviders: opts.links ? [{ provider: 'google', providerId: `g-${email}`, verified: true, linkedAt: new Date() }] : [],
  })
  const members = []
  for (const o of orgs) members.push(await createTestUser(o._id, { email, identityId: identity._id, isActive: opts.active ?? true } as any))
  return { identity, members }
}

async function sessionOf(email: string) {
  const res = await signIn(email, PW)
  expect(res.status).toBe(200)
  return res.body.token as string
}

// ── Changing the password ──────────────────────────────────────────────────────────────────

describe('changing the password', () => {
  it('needs the current one, makes the new one the person\'s own, and ends their other sessions', async () => {
    const a = await org('chg')
    const { identity, members } = await person(`chg-${seq}@x.test`, [a], { setBy: 'admin' })
    const tab = await sessionOf(`chg-${seq}@x.test`)
    const otherTab = await sessionOf(`chg-${seq}@x.test`)

    expect((await change(tab, PW2, PW)).body.code).toBe('wrong_password')

    const done = await change(tab, PW, PW2)
    expect(done.status).toBe(200)
    const after = await Identity.findById(identity._id).select('+password').lean().exec()
    expect(after!.passwordSetBy).toBe('self')
    expect(await Bun.password.verify(PW2, after!.password!)).toBe(true)
    // The legacy copy follows, so a rollback still signs the person in.
    expect(await Bun.password.verify(PW2, (await User.findById(members[0]._id).lean().exec())!.password!)).toBe(true)

    // This tab carries on with its fresh token; every other session has ended.
    expect((await call('GET', '/auth/me', { token: done.body.token })).status).toBe(200)
    expect((await call('GET', '/auth/me', { token: otherTab })).status).toBe(401)
  })

  it('wants at least 12 characters, a Bearer token, and a person behind the session', async () => {
    const a = await org('chg-rules')
    await person(`rules-${seq}@x.test`, [a])
    const tab = await sessionOf(`rules-${seq}@x.test`)

    expect((await change(tab, PW, 'short')).status).toBe(422)
    expect((await call('POST', '/auth/password', { cookie: `__Host-auth=${tab}`, body: changeBody(PW, PW2) })).body.code).toBe('bearer_required')

    const unlinked = await createTestUser(a._id, { username: `ul${seq}`, password: await Bun.password.hash(PW) } as any)
    const legacy = (await signInToOrg(unlinked.username, PW, a.slug)).body.token
    expect((await change(legacy, PW, PW2)).body.code).toBe('not_a_person')
  })

  it('tells a person with no password (provider sign-in only) to use the reset link instead', async () => {
    const a = await org('chg-none')
    const { identity, members } = await person(`none-${seq}@x.test`, [a], { password: null, links: true })
    const tab = await providerSession(members[0], identity)
    expect((await change(tab, PW, PW2)).body.code).toBe('no_password')
  })
})

// ── Forgot / reset ─────────────────────────────────────────────────────────────────────────

describe('forgot and reset', () => {
  it('answers the same for any address, and stores only a hash of the link it mails', async () => {
    const a = await org('fgt')
    const { identity } = await person(`fgt-${seq}@x.test`, [a])

    const known = await call('POST', '/auth/password/forgot', { body: { email: `FGT-${seq}@x.test` } })
    const unknown = await call('POST', '/auth/password/forgot', { body: { email: `nobody-${seq}@x.test` } })
    expect([known.status, known.body]).toEqual([unknown.status, unknown.body])

    const tokens = await AuthToken.find({ identityId: identity._id }).lean().exec()
    expect(tokens).toHaveLength(1)
    expect(tokens[0].tokenHash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('resets once: the password becomes the person\'s own, a waiting person goes live, the link is spent', async () => {
    const a = await org('rst')
    const { identity, members } = await person(`rst-${seq}@x.test`, [a], { setBy: 'admin', active: false })
    const token = randomBytes(32).toString('base64url')
    await AuthToken.create({
      purpose: 'password_reset',
      identityId: identity._id,
      tokenHash: createHash('sha256').update(token).digest('hex'),
      expiresAt: new Date(Date.now() + 60_000),
    })

    expect((await reset(token, PW2)).status).toBe(200)
    const after = await Identity.findById(identity._id).select('+password').lean().exec()
    expect([after!.passwordSetBy, after!.isActive, after!.emailVerified]).toEqual(['self', true, true])
    expect(await Bun.password.verify(PW2, after!.password!)).toBe(true)
    expect((await User.findById(members[0]._id).lean().exec())!.isActive).toBe(true)

    expect((await reset(token, PW)).body.code).toBe('reset_invalid')
    expect((await signIn(`rst-${seq}@x.test`, PW2)).status).toBe(200)
  })

  it('refuses an expired link and an unknown one alike', async () => {
    const a = await org('exp')
    const { identity } = await person(`exp-${seq}@x.test`, [a])
    const token = randomBytes(32).toString('base64url')
    await AuthToken.create({
      purpose: 'password_reset',
      identityId: identity._id,
      tokenHash: createHash('sha256').update(token).digest('hex'),
      expiresAt: new Date(Date.now() - 1000),
    })
    expect((await reset(token, PW2)).body.code).toBe('reset_invalid')
    expect((await reset(randomBytes(32).toString('base64url'), PW2)).body.code).toBe('reset_invalid')
  })

  it('limits reset mail per address, without touching anyone\'s sign-in', async () => {
    const saved = { ...config.loginThrottle }
    Object.assign(config.loginThrottle, { enabled: true })
    try {
      const a = await org('lim')
      await person(`lim-${seq}@x.test`, [a])
      const ask = () => call('POST', '/auth/password/forgot', { body: { email: `lim-${seq}@x.test` } })
      for (let i = 0; i < 3; i++) expect((await ask()).status).toBe(200)
      expect((await ask()).status).toBe(429)
      expect((await signIn(`lim-${seq}@x.test`, PW)).status).toBe(200)
    } finally {
      Object.assign(config.loginThrottle, saved)
    }
  })
})

// ── Switched off by an administrator ───────────────────────────────────────────────────────

/**
 * A member an administrator switches off has no way in from then on: the session they hold ends, and what a person
 * may ask for themselves (a reset link, an activation mail) gives them no membership back. Both ways of switching
 * off say when: the Users form's Active switch (`PUT … { isActive: false }`) and the list's remove (`DELETE`).
 */
describe('a member an administrator switches off', () => {
  /** An org with its administrator and one more member, signed in. */
  async function pair(prefix: string) {
    const a = await org(prefix)
    const boss = await person(`boss-${seq}@x.test`, [a])
    const email = `gone-${seq}@x.test`
    const gone = await person(email, [a])
    return { a, admin: await sessionOf(boss.identity.email), email, identity: gone.identity, member: gone.members[0], session: await sessionOf(email) }
  }
  async function linkFor(identityId: unknown) {
    const token = randomBytes(32).toString('base64url')
    await AuthToken.create({ purpose: 'password_reset', identityId, tokenHash: createHash('sha256').update(token).digest('hex'), expiresAt: new Date(Date.now() + 60_000) })
    return token
  }
  const stateOf = async (id: unknown) => {
    const m = await User.findById(id).lean().exec()
    return { isActive: m!.isActive, dated: m!.deactivatedAt instanceof Date }
  }
  const reads = async (w: { a: { id: string } }, token: string) => (await call('GET', `/org/${w.a.id}/user?size=1`, { token })).status
  /** The org a sign-in by the person lands in: none when no membership of theirs is live. */
  const landsIn = async (email: string, password: string) => {
    const res = await signIn(email, password)
    return res.body?.token ? claimsOf(res.body.token).orgId : undefined
  }

  for (const [how, switchOff] of [
    ["the Users form's switch", (w: any) => call('PUT', `/org/${w.a.id}/user/${w.member._id}`, { token: w.admin, body: { isActive: false } })],
    ["the list's remove", (w: any) => call('DELETE', `/org/${w.a.id}/user/${w.member._id}`, { token: w.admin })],
  ] as const) {
    it(`by ${how}: they are deactivated, the session they hold ends, and no link of their own brings them back`, async () => {
      const w = await pair('off')
      expect(await reads(w, w.session)).toBe(200)

      expect((await switchOff(w)).status).toBe(200)
      expect(await stateOf(w.member._id)).toEqual({ isActive: false, dated: true })
      // The session they held answers nothing more, here at once and on another pod within its cache minute.
      expect(await reads(w, w.session)).toBe(401)
      expect((await call('GET', '/auth/me', { token: w.session })).status).toBe(401)
      // They are still a person, so a sign-in may answer: with no org behind it, and the org itself refuses them.
      expect(await landsIn(w.email, PW)).toBeUndefined()
      expect((await signInToOrg(w.email, PW, w.a.slug)).status).not.toBe(200)

      // A reset link is the person's to ask for and to use: it gives them a password, and no way back in.
      expect((await reset(await linkFor(w.identity._id), PW2)).status).toBe(200)
      expect(await stateOf(w.member._id)).toEqual({ isActive: false, dated: true })
      expect(await landsIn(w.email, PW2)).toBeUndefined()
      expect((await signInToOrg(w.email, PW2, w.a.slug)).status).not.toBe(200)
      // Nor an activation mail: none is made for them.
      await resendActivation(w.email)
      expect(await Code.countDocuments({ userId: w.member._id })).toBe(0)
      // The administrator's own session is untouched.
      expect(await reads(w, w.admin)).toBe(200)
    })
  }

  it('switched on again by the administrator: they sign in, and the next switching off is dated anew', async () => {
    const w = await pair('on')
    const put = (isActive: boolean) => call('PUT', `/org/${w.a.id}/user/${w.member._id}`, { token: w.admin, body: { isActive } })
    expect((await put(false)).status).toBe(200)
    expect((await put(true)).status).toBe(200)
    expect(await stateOf(w.member._id)).toEqual({ isActive: true, dated: false })
    const back = await signIn(w.email, PW)
    expect(back.status).toBe(200)
    expect(await reads(w, back.body.token)).toBe(200)

    expect((await put(false)).status).toBe(200)
    expect(await stateOf(w.member._id)).toEqual({ isActive: false, dated: true })
    expect(await reads(w, back.body.token)).toBe(401)
  })

  it('in one of their two orgs: the other still takes their sign-in, and a reset link opens only that one', async () => {
    const a = await org('two-a')
    const b = await org('two-b')
    const boss = await person(`boss-${seq}@x.test`, [a])
    const email = `two-${seq}@x.test`
    const both = await person(email, [a, b])
    const inA = both.members[0]
    const admin = await sessionOf(boss.identity.email)

    expect((await call('PUT', `/org/${a.id}/user/${inA._id}`, { token: admin, body: { isActive: false } })).status).toBe(200)
    expect((await reset(await linkFor(both.identity._id), PW2)).status).toBe(200)
    expect(await stateOf(inA._id)).toEqual({ isActive: false, dated: true })
    expect((await signInToOrg(email, PW2, a.slug)).status).not.toBe(200)
    expect((await signInToOrg(email, PW2, b.slug)).status).toBe(200)
  })

  it('saved with the switch off while still waiting for a first activation: that is no deactivation, and they finish it', async () => {
    const a = await org('wait')
    const boss = await person(`boss-${seq}@x.test`, [a])
    const email = `wait-${seq}@x.test`
    const waiting = await person(email, [a], { active: false })
    const admin = await sessionOf(boss.identity.email)

    expect((await call('PUT', `/org/${a.id}/user/${waiting.members[0]._id}`, { token: admin, body: { isActive: false, position: 'Clerk' } })).status).toBe(200)
    expect(await stateOf(waiting.members[0]._id)).toEqual({ isActive: false, dated: false })
    expect((await reset(await linkFor(waiting.identity._id), PW2)).status).toBe(200)
    expect(await stateOf(waiting.members[0]._id)).toEqual({ isActive: true, dated: false })
    expect((await signIn(email, PW2)).status).toBe(200)
  })
})

// ── Joining and founding (rule 3) ──────────────────────────────────────────────────────────

describe('accepting an invitation while signed in', () => {
  async function invited(email: string, opts: Parameters<typeof person>[2] = {}) {
    const [home, target] = [await org('home'), await org('target')]
    const { identity } = await person(email, [home], opts)
    const inviter = await createTestUser(target._id, {} as any)
    const invite = await inviteDao.createInvite({ orgId: target.id, inviterId: String(inviter._id), targetEmail: email.toUpperCase(), assignRole: 'accountant' })
    return { identity, target, invite }
  }

  it('joins with the invite\'s role and lands there; the invite is spent', async () => {
    const email = `join-${seq}@x.test` // once: invited() makes orgs, which moves `seq`
    const { identity, target, invite } = await invited(email)
    const tab = await sessionOf(email)

    const res = await call('POST', `/invite/${invite.code}/accept`, { token: tab })
    expect(res.status).toBe(200)
    expect(res.body.org.slug).toBe(target.slug)
    expect(res.body.user.role).toBe('accountant')
    expect(claimsOf(res.body.token).iid).toBe(String(identity._id))
    expect((await Invite.findById(invite._id).lean().exec())!.status).toBe('exhausted')

    expect((await call('POST', `/invite/${invite.code}/accept`, { token: tab })).body.code).toBe('invite_invalid')
  })

  it('refuses an invite for another address, and a member joining twice, without spending it', async () => {
    const { invite: forOther } = await invited(`owner-${seq}@x.test`)
    const [stranger] = [await org('str')]
    await person(`stranger-${seq}@x.test`, [stranger])
    const strangerTab = await sessionOf(`stranger-${seq}@x.test`)
    expect((await call('POST', `/invite/${forOther.code}/accept`, { token: strangerTab })).body.code).toBe('invite_for_other_email')
    expect((await Invite.findById(forOther._id).lean().exec())!.useCount).toBe(0)

    const twice = `twice-${seq}@x.test`
    const { target, invite } = await invited(twice)
    await createTestUser(target._id, { email: twice, identityId: (await Identity.findOne({ email: twice }))!._id } as any)
    const tab = await sessionOf(twice)
    expect((await call('POST', `/invite/${invite.code}/accept`, { token: tab })).body.code).toBe('already_member')
    expect((await Invite.findById(invite._id).lean().exec())!.useCount).toBe(0)
  })

  it('wants a credential the person owns (rule 3): an admin-set password must be changed first', async () => {
    const email = `adminset-${seq}@x.test`
    const { invite } = await invited(email, { setBy: 'admin' })
    const tab = await sessionOf(email)
    expect((await call('POST', `/invite/${invite.code}/accept`, { token: tab })).body.code).toBe('own_password_required')

    const changed = await change(tab, PW, PW2)
    expect((await call('POST', `/invite/${invite.code}/accept`, { token: changed.body.token })).status).toBe(200)
  })
})

describe('founding an organization while signed in', () => {
  it('makes the person its admin, provisions it like a registration, and lands there', async () => {
    const a = await org('fnd')
    await person(`fnd-${seq}@x.test`, [a])
    const tab = await sessionOf(`fnd-${seq}@x.test`)
    const slug = `new-org-${Date.now()}-${seq}`

    const res = await call('POST', '/auth/orgs', { token: tab, body: { name: 'New Org', slug } })
    expect(res.status).toBe(200)
    expect(res.body.org.slug).toBe(slug)
    expect(res.body.user.role).toBe('admin')
    expect(res.body.orgs.map((o: any) => o.slug)).toContain(a.slug)
    const orgId = res.body.org.id
    expect(await OrgApp.countDocuments({ orgId })).toBeGreaterThan(0)
    expect(await PermissionSet.countDocuments({ orgId, name: 'Administrator' })).toBe(1)

    expect((await call('POST', '/auth/orgs', { token: tab, body: { name: 'Again', slug } })).body.code).toBe('slug_taken')
  })

  it('wants a credential the person owns: a migrated password is refused, provider-only sign-in passes', async () => {
    const a = await org('fnd-rule')
    await person(`legacy-${seq}@x.test`, [a], { setBy: 'legacy' })
    const legacyTab = await sessionOf(`legacy-${seq}@x.test`)
    expect((await call('POST', '/auth/orgs', { token: legacyTab, body: { name: 'Nope', slug: `nope-${seq}` } })).body.code).toBe('own_password_required')

    const b = await org('fnd-oauth')
    const { identity, members } = await person(`oauth-only-${seq}@x.test`, [b], { password: null, links: true })
    const tab = await providerSession(members[0], identity)
    expect((await call('POST', '/auth/orgs', { token: tab, body: { name: 'Mine', slug: `mine-${Date.now()}-${seq}` } })).status).toBe(200)
  })
})

describe('the admin users list', () => {
  it('marks who also works in another org, so the screen can lock their password, email and name', async () => {
    const [a, b] = [await org('ml-a'), await org('ml-b')]
    await person(`both-${seq}@x.test`, [a, b])
    await person(`here-${seq}@x.test`, [a])
    const admin = await sessionOf(`both-${seq}@x.test`)
    // The session is in a or b (several orgs, no landing → identity-only). Switch into a.
    const tab = claimsOf(admin).type === 'identity'
      ? (await call('POST', '/auth/switch', { token: admin, body: { orgId: a.id } })).body.token
      : admin
    await User.updateMany({ orgId: a._id, email: `both-${seq}@x.test` }, { $set: { role: 'admin' } })
    const fresh = (await call('POST', '/auth/switch', { token: tab, body: { orgId: a.id } })).body.token

    const res = await call('GET', `/org/${a.id}/user`, { token: fresh })
    const flag = (email: string) => res.body.users.find((u: any) => u.email === email)?.multiOrg
    expect([flag(`both-${seq}@x.test`), flag(`here-${seq}@x.test`)]).toEqual([true, false])
  })
})
