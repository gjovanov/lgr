import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { Elysia } from 'elysia'
import { randomUUID } from 'crypto'
import { config } from 'config'
import { setupTestDB, teardownTestDB } from '../setup'
import { createTestOrg, createTestUser } from '../helpers/factories'
import { withFakeGoogle, type FakeIdentity } from '../helpers/fake-oauth-provider'
import { createApiApp } from '../../../portal-api/src/api.js'
import { Desktop, Identity, User } from 'db/models'
import { inviteDao } from 'services/dao/invite.dao'
import type { Types } from 'mongoose'

/**
 * Multi-org sign-in, Phase 2: OAuth without an org. The provider account names a PERSON, who lands
 * like a password sign-in (rule 5) or chooses, through the real callback and the real redeem.
 *
 * Who it is (rule 4):
 *   - the person holding the provider account: a confirmed link, or a migrated (unconfirmed) one
 *     only when the provider vouches for the person's own address, which confirms it;
 *   - else the person whose address the provider VERIFIED (and the account is linked);
 *   - else nobody: joining an org is an invitation, never a sign-in.
 */

let app: Elysia
let seq = 0

beforeAll(async () => {
  await setupTestDB()
  await Identity.init()
  await User.init()
  app = new Elysia().use(createApiApp())
}, 120_000)

afterAll(async () => {
  await teardownTestDB()
}, 60_000)

async function org(prefix: string) {
  const o = await createTestOrg({ slug: `${prefix}-${Date.now()}-${++seq}` } as any)
  return { id: String(o._id), slug: o.slug as string, _id: o._id as Types.ObjectId }
}

async function person(email: string, orgs: { _id: Types.ObjectId }[], opts: { links?: Array<{ providerId: string; verified: boolean }>; lastOrgId?: unknown } = {}) {
  const identity = await Identity.create({
    email,
    firstName: 'O',
    lastName: 'Auth',
    lastOrgId: opts.lastOrgId,
    oauthProviders: (opts.links ?? []).map(l => ({ provider: 'google', providerId: l.providerId, verified: l.verified, linkedAt: new Date() })),
  })
  for (const o of orgs) await createTestUser(o._id, { email, identityId: identity._id } as any)
  return identity
}

/** Google's redirect back, for a flow this browser started with `state` (no org unless given). */
function callbackRequest(state: Record<string, unknown>): Request {
  const nonce = randomUUID()
  const encoded = Buffer.from(JSON.stringify({ mode: 'login', nonce, ...state })).toString('base64url')
  return new Request(`http://localhost/api/oauth/callback/google?code=provider-code&state=${encoded}`, {
    headers: { cookie: `__Host-oauth_state=${nonce}` },
  })
}

/** Sign in through the callback, then redeem like the SPA does; returns both halves. */
async function signIn(google: FakeIdentity, state: Record<string, unknown> = {}) {
  const callback = await withFakeGoogle(google, () => app.handle(callbackRequest(state)))
  const location = callback.headers.get('location') ?? ''
  const handoff = callback.headers.getSetCookie().find(c => c.startsWith('__Host-oauth_handoff='))
  const sessionCookieSet = callback.headers.getSetCookie().some(c => /^(__Host-)?auth=/.test(c))
  if (!handoff) return { location, sessionCookieSet, redeemed: null as any }
  const res = await app.handle(
    new Request('http://localhost/api/auth/oauth-code/redeem', {
      method: 'POST',
      headers: { cookie: handoff.split(';')[0] },
    }),
  )
  return { location, sessionCookieSet, redeemed: { status: res.status, body: (await res.json()) as any } }
}

const claimsOf = (token: string) => JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString())
/** The callback refuses with a CODE the login page translates, never with message text. */
const refusedWith = (location: string, code?: string) =>
  code ? location === `${config.oauth.frontendUrl}/auth/login?error=${code}` : location.startsWith(`${config.oauth.frontendUrl}/auth/login?error=`)

describe('OAuth without an org', () => {
  it('signs in the person who holds the provider account, into their org', async () => {
    const a = await org('og-link')
    const identity = await person(`link-${seq}@x.test`, [a], { links: [{ providerId: `g-link-${seq}`, verified: true }] })

    const { location, redeemed } = await signIn({ providerId: `g-link-${seq}`, email: `link-${seq}@x.test`, name: 'L' })
    expect(location).toBe(`${config.oauth.frontendUrl}/auth/oauth-callback`)
    expect(redeemed.status).toBe(200)
    expect(redeemed.body.org.slug).toBe(a.slug)
    expect(claimsOf(redeemed.body.token).iid).toBe(String(identity._id))
  })

  it('finds a person by an address the provider verified, and links the account for next time', async () => {
    const a = await org('og-mail')
    const identity = await person(`mail-${seq}@x.test`, [a])

    const { redeemed } = await signIn({ providerId: `g-mail-${seq}`, email: `Mail-${seq}@X.test`, name: 'M' })
    expect(redeemed.body.org.slug).toBe(a.slug)
    const after = await Identity.findById(identity._id).lean().exec()
    expect(after!.oauthProviders.map(l => [l.providerId, l.verified])).toEqual([[`g-mail-${seq}`, true]])
    expect(after!.emailVerified).toBe(true) // the provider just proved the address
  })

  it('finds nobody by an address the provider did not verify', async () => {
    const a = await org('og-unv')
    await person(`unv-${seq}@x.test`, [a])

    const { location, redeemed } = await signIn({ providerId: `g-unv-${seq}`, email: `unv-${seq}@x.test`, name: 'U', emailVerified: false })
    expect(refusedWith(location, 'no_account')).toBe(true)
    expect(redeemed).toBeNull()
  })

  it('honours a migrated link only when the provider vouches for the same address, and confirms it', async () => {
    const a = await org('og-legacy')
    const identity = await person(`legacy-${seq}@x.test`, [a], { links: [{ providerId: `g-legacy-${seq}`, verified: false }] })

    const elsewhere = await signIn({ providerId: `g-legacy-${seq}`, email: `someone.else-${seq}@x.test`, name: 'S' })
    expect(refusedWith(elsewhere.location, 'link_unconfirmed')).toBe(true)

    const vouched = await signIn({ providerId: `g-legacy-${seq}`, email: `legacy-${seq}@x.test`, name: 'L' })
    expect(vouched.redeemed.body.org.slug).toBe(a.slug)
    expect((await Identity.findById(identity._id).lean().exec())!.oauthProviders[0].verified).toBe(true)
  })

  it('gives a person with several orgs and no choice an identity-only sign-in: no cookie, a token to pick with', async () => {
    const [a, b] = [await org('og-two-a'), await org('og-two-b')]
    await person(`two-${seq}@x.test`, [a, b], { links: [{ providerId: `g-two-${seq}`, verified: true }] })

    const { sessionCookieSet, redeemed } = await signIn({ providerId: `g-two-${seq}`, email: `two-${seq}@x.test`, name: 'T' })
    expect(sessionCookieSet).toBe(false)
    expect(redeemed.body.needsOrgChoice).toBe(true)
    expect(redeemed.body.orgs.map((o: any) => o.slug).sort()).toEqual([a.slug, b.slug].sort())
    expect(claimsOf(redeemed.body.token).type).toBe('identity')
  })

  it('lands where this browser was last, when that org is one of the person\'s', async () => {
    const [a, b] = [await org('og-pref-a'), await org('og-pref-b')]
    await person(`pref-${seq}@x.test`, [a, b], { links: [{ providerId: `g-pref-${seq}`, verified: true }] })

    const { redeemed } = await signIn({ providerId: `g-pref-${seq}`, email: `pref-${seq}@x.test`, name: 'P' }, { prefer: b.id })
    expect(redeemed.body.org.slug).toBe(b.slug)
  })

  it('joins the org an invitation names, for a new person with a verified address', async () => {
    const a = await org('og-invite')
    const inviter = await createTestUser(a._id, {} as any)
    const invite = await inviteDao.createInvite({ orgId: a.id, inviterId: String(inviter._id), maxUses: 1 })

    const { redeemed } = await signIn({ providerId: `g-new-${seq}`, email: `new-${seq}@x.test`, name: 'New Comer' }, { inviteCode: invite.code })
    expect(redeemed.body.org.slug).toBe(a.slug)
    const identity = await Identity.findOne({ email: `new-${seq}@x.test` }).lean().exec()
    expect(claimsOf(redeemed.body.token).iid).toBe(String(identity!._id))
  })

  it('refuses a desktop sign-in with no org from an id that names no registered desktop', async () => {
    const res = await withFakeGoogle({ providerId: 'x', email: 'x@x.test', name: 'X' }, () =>
      app.handle(new Request(`http://localhost/api/oauth/google?desktop=d1&code_challenge=${'a'.repeat(43)}`)),
    )
    expect(res.status).toBe(400)
  })

  // Prod, 2026-10-14: the login page sends `org_slug` only when its org field is open, so every
  // desktop provider sign-in answered 400. A registered desktop signs in to its own org.
  describe('a desktop sign-in without org_slug', () => {
    async function desktopIn(o: { _id: Types.ObjectId }, status: 'active' | 'revoked' = 'active') {
      const d = await Desktop.create({
        orgId: o._id, name: 'Till', machineId: `m-${++seq}`, installationId: `i-${seq}`,
        publicKey: 'pk', status,
      } as any)
      return String(d._id)
    }
    const start = (desktopId: string) => withFakeGoogle({ providerId: 'x', email: 'x@x.test', name: 'X' }, () =>
      app.handle(new Request(`http://localhost/api/oauth/google?desktop=${desktopId}&code_challenge=${'a'.repeat(43)}`)),
    )
    const stateOf = (res: Response) => {
      const raw = new URL(res.headers.get('location') ?? 'http://x/').searchParams.get('state') ?? ''
      return JSON.parse(Buffer.from(raw, 'base64url').toString())
    }

    it('goes to the provider carrying the org the desktop is registered in', async () => {
      const a = await org('og-desk')
      const res = await start(await desktopIn(a))
      expect(res.status).toBe(302)
      expect(stateOf(res).orgSlug).toBe(a.slug)
    })

    it('is still refused for a revoked desktop', async () => {
      const a = await org('og-desk-rev')
      const res = await start(await desktopIn(a, 'revoked'))
      expect(res.status).toBe(400)
    })

    it('keeps an org_slug the page did send', async () => {
      const [a, b] = [await org('og-desk-a'), await org('og-desk-b')]
      const res = await withFakeGoogle({ providerId: 'x', email: 'x@x.test', name: 'X' }, async () =>
        app.handle(new Request(`http://localhost/api/oauth/google?org_slug=${b.slug}&desktop=${await desktopIn(a)}&code_challenge=${'a'.repeat(43)}`)),
      )
      expect(res.status).toBe(302)
      expect(stateOf(res).orgSlug).toBe(b.slug)
    })
  })
})

describe('GET /api/oauth/providers', () => {
  it('lists the providers this deployment has credentials for, publicly, and nothing about them', async () => {
    const saved = process.env.GITHUB_CLIENT_ID
    process.env.GITHUB_CLIENT_ID = 'test-github-id'
    try {
      const res = await app.handle(new Request('http://localhost/api/oauth/providers'))
      expect(res.status).toBe(200)
      const body = (await res.json()) as any
      expect(body.providers).toContain('github')
      expect(JSON.stringify(body)).not.toContain('test-github-id')
    } finally {
      if (saved === undefined) delete process.env.GITHUB_CLIENT_ID
      else process.env.GITHUB_CLIENT_ID = saved
    }
  })
})
