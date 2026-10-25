import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { Elysia } from 'elysia'
import { createHash, randomBytes } from 'crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { config } from 'config'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { createTestOrg, createTestUser } from '../helpers/factories'
import { makeNodeStub, nodeEnrollBody } from '../helpers/node-stub'
import { createApiApp } from '../../../portal-api/src/api.js'
import { Identity } from 'db/models'
import { forgetAllHomes, homeNewOrg } from 'db/home/home'
import { enrollNode, issueNodeToken, mintNodeEnrollmentCode } from 'services/biz/node/node.service'
import { sessionFor } from 'services/biz/auth.service'
import { redirectAllowed } from 'services/biz/idp/idp.service'
import { acceptedIdpKeys, signAssertion, verifyAssertion } from 'services/biz/idp/idp-token'
import { ephemeralSigningKey } from 'services/biz/crypto/ed-jws'

/**
 * "Sign in with LGR" (FR-20.39, plan step P2-4).
 *
 * lgrai.app hands a person's consent to sign in to one of their org's servers as a 60-second code,
 * bound to that server, its redirect and the browser's PKCE challenge. The server redeems it with its
 * node token and the browser's verifier for a 5-minute assertion, verifies it with the identity key
 * built into its package, and turns the membership it names into its own session.
 */

const ENROLL = 'https://lgrai.app/api/node/v1/enroll'
const TOKEN = 'https://lgrai.app/api/node/v1/token'
const REDIRECT = 'http://127.0.0.1:47123/auth/idp/callback'
const realFetch = globalThis.fetch
const saved = { role: config.node.role, id: config.node.id, tokenFile: config.outbox.tokenFile }
let tmp = ''

beforeAll(async () => { await setupTestDB() })
afterAll(async () => { await teardownTestDB() })
afterEach(async () => {
  globalThis.fetch = realFetch
  ;(config.node as any).role = saved.role
  ;(config.node as any).id = saved.id
  ;(config.outbox as any).tokenFile = saved.tokenFile
  forgetAllHomes()
  await clearCollections()
  if (tmp) rmSync(tmp, { recursive: true, force: true })
  tmp = ''
})

const jwt = async () => ((new Elysia().use((await import('@elysiajs/jwt')).default({ name: 'jwt', secret: config.jwt.secret })) as any).decorator.jwt)
const call = (app: any, method: string, path: string, token?: string, body?: unknown) => app.handle(new Request(`http://localhost${path}`, {
  method,
  headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
  body: body !== undefined ? JSON.stringify(body) : undefined,
}))
const pkce = () => {
  const verifier = randomBytes(32).toString('base64url')
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') }
}

/** A person, a membership in an org, that org's server, and the person's lgrai.app session. */
async function aPersonAndTheirServer() {
  const org = await createTestOrg({ slug: `shop-${randomBytes(3).toString('hex')}` } as any)
  const identity: any = await Identity.create({ email: `p-${randomBytes(3).toString('hex')}@shop.test`, firstName: 'Petya', lastName: 'Petrova' })
  const member: any = await createTestUser(org._id, { role: 'admin', identityId: identity._id, email: identity.email } as any)
  const stub = makeNodeStub()
  const { code } = await mintNodeEnrollmentCode(String(org._id), String(member._id))
  await enrollNode({ ...nodeEnrollBody(stub, ENROLL), code } as any, [ENROLL])
  const nodeToken = (await issueNodeToken(stub.assertion({ sub: stub.nodeId, audience: TOKEN }), [TOKEN])).token
  const session = await (await jwt()).sign({ ...(await sessionFor(member, identity)), exp: Math.floor(Date.now() / 1000) + 3600 })
  return { orgId: String(org._id), slug: org.slug, identity, member, nodeId: stub.nodeId, nodeToken, session, app: new Elysia().use(createApiApp()) }
}

async function aCode(p: Awaited<ReturnType<typeof aPersonAndTheirServer>>, challenge: string) {
  const r = await call(p.app, 'POST', '/api/idp/authorize', p.session, { clientId: p.nodeId, orgId: p.orgId, redirectUri: REDIRECT, state: 'state-0123456789abcdef', codeChallenge: challenge, codeChallengeMethod: 'S256' })
  expect(r.status).toBe(200)
  const back = new URL((await r.json()).redirect)
  expect(back.origin + back.pathname).toBe(REDIRECT)
  expect(back.searchParams.get('state')).toBe('state-0123456789abcdef')
  return back.searchParams.get('code')!
}

describe('the redirects a server may ask for', () => {
  it('the desktop, a loopback address, or one of its orgs under lgrai.app; always the callback', () => {
    expect(redirectAllowed('lgr://login', [])).toBe(true)
    expect(redirectAllowed('http://127.0.0.1:5555/auth/idp/callback', [])).toBe(true)
    expect(redirectAllowed('https://localhost:4443/auth/idp/callback', [])).toBe(true)
    expect(redirectAllowed('https://shop.lgrai.app/auth/idp/callback', ['shop'])).toBe(true)
    expect(redirectAllowed('https://other.lgrai.app/auth/idp/callback', ['shop'])).toBe(false)
    expect(redirectAllowed('https://evil.test/auth/idp/callback', ['shop'])).toBe(false)
    expect(redirectAllowed('http://127.0.0.1:5555/elsewhere', [])).toBe(false)
    expect(redirectAllowed('http://127.0.0.1:5555/auth/idp/callback?next=x', [])).toBe(false)
    expect(redirectAllowed('https://user@127.0.0.1/auth/idp/callback', [])).toBe(false)
  })
})

describe('the assertion', () => {
  it('is for one server, and only for five minutes', () => {
    const key = ephemeralSigningKey()
    const keys = new Map([[key.kid, key.publicKey]])
    const ids = { sub: '0123456789abcdef01234567', org: '0123456789abcdef01234568', uid: '0123456789abcdef01234569' }
    const { jws } = signAssertion({ aud: 'master-aaaaaaaaaaaaaaaa', ...ids, email: 'p@shop.test', tv: 3, amr: ['pwd'] }, key)
    expect(verifyAssertion(jws, 'master-aaaaaaaaaaaaaaaa', keys).ok).toBe(true)
    expect(verifyAssertion(jws, 'master-bbbbbbbbbbbbbbbb', keys)).toEqual({ ok: false, reason: 'wrong_audience' })
    expect(verifyAssertion(jws, 'master-aaaaaaaaaaaaaaaa', keys, Date.now() + 6 * 60_000)).toEqual({ ok: false, reason: 'expired' })
    expect(verifyAssertion(jws, 'master-aaaaaaaaaaaaaaaa', new Map([[key.kid, ephemeralSigningKey().publicKey]]))).toEqual({ ok: false, reason: 'bad_signature' })
  })
})

describe('lgrai.app: what the person agrees to', () => {
  it('shows the server and the person\'s orgs on it, and refuses a stranger, a bad redirect and no session', async () => {
    const p = await aPersonAndTheirServer()
    const q = (redirect = REDIRECT, client = p.nodeId) => `/api/idp/client?client_id=${client}&redirect_uri=${encodeURIComponent(redirect)}`
    const ok = await call(p.app, 'GET', q(), p.session)
    expect(ok.status).toBe(200)
    const view = await ok.json()
    expect(view.node.id).toBe(p.nodeId)
    expect(view.orgs).toEqual([{ id: p.orgId, slug: p.slug, name: expect.any(String) }])
    expect((await call(p.app, 'GET', q())).status).toBe(401)
    expect((await (await call(p.app, 'GET', q('https://evil.test/auth/idp/callback'), p.session)).json()).code).toBe('bad_redirect_uri')
    expect((await call(p.app, 'GET', q(REDIRECT, 'master-zzzzzzzzzzzzzzzz'), p.session)).status).toBe(404)

    // Someone who is not a member there gets no code.
    const stranger: any = await Identity.create({ email: 'stranger@else.test', firstName: 'S', lastName: 'T' })
    const otherOrg = await createTestOrg()
    const theirs: any = await createTestUser(otherOrg._id, { identityId: stranger._id, email: stranger.email } as any)
    const theirSession = await (await jwt()).sign({ ...(await sessionFor(theirs, stranger)), exp: Math.floor(Date.now() / 1000) + 3600 })
    const refused = await call(p.app, 'POST', '/api/idp/authorize', theirSession, { clientId: p.nodeId, orgId: p.orgId, redirectUri: REDIRECT, state: 'state-0123456789abcdef', codeChallenge: pkce().challenge, codeChallengeMethod: 'S256' })
    expect(refused.status).toBe(403)
    // PKCE is S256 or nothing.
    const plain = await call(p.app, 'POST', '/api/idp/authorize', p.session, { clientId: p.nodeId, orgId: p.orgId, redirectUri: REDIRECT, state: 'state-0123456789abcdef', codeChallenge: 'x'.repeat(43), codeChallengeMethod: 'plain' })
    expect(plain.status).toBe(400)
  })
})

describe('the server redeems the code', () => {
  it('once, with its own token and the browser\'s verifier; any mismatch spends it', async () => {
    const p = await aPersonAndTheirServer()
    const redeem = (code: string, verifier: string, token = p.nodeToken) => call(p.app, 'POST', '/api/node/v1/idp/redeem', token, { code, codeVerifier: verifier, redirectUri: REDIRECT })

    const one = pkce()
    const code = await aCode(p, one.challenge)
    const r = await redeem(code, one.verifier)
    expect(r.status).toBe(200)
    const v = verifyAssertion((await r.json()).assertion, p.nodeId, acceptedIdpKeys())
    expect(v.ok && { sub: v.claims.sub, org: v.claims.org, uid: v.claims.uid }).toEqual({ sub: String(p.identity._id), org: p.orgId, uid: String(p.member._id) })
    expect((await redeem(code, one.verifier)).status).toBe(400)

    // A wrong verifier spends the code: the right one cannot use it after.
    const two = pkce()
    const code2 = await aCode(p, two.challenge)
    expect((await redeem(code2, pkce().verifier)).status).toBe(400)
    expect((await redeem(code2, two.verifier)).status).toBe(400)

    // Another server cannot redeem it.
    const three = pkce()
    const code3 = await aCode(p, three.challenge)
    const other = makeNodeStub()
    const { code: enroll } = await mintNodeEnrollmentCode(p.orgId, String(p.member._id))
    await enrollNode({ ...nodeEnrollBody(other, ENROLL), code: enroll } as any, [ENROLL])
    const otherToken = (await issueNodeToken(other.assertion({ sub: other.nodeId, audience: TOKEN }), [TOKEN])).token
    expect((await redeem(code3, three.verifier, otherToken)).status).toBe(400)
  })
})

describe('a master signs the person in', () => {
  async function asMaster(p: Awaited<ReturnType<typeof aPersonAndTheirServer>>) {
    tmp = mkdtempSync(join(tmpdir(), 'lgr-idp-'))
    const file = join(tmp, 'node-token.json')
    writeFileSync(file, JSON.stringify({ server: 'https://lgrai.test', token: p.nodeToken, expiresAt: Math.floor(Date.now() / 1000) + 600 }))
    ;(config.outbox as any).tokenFile = file
    ;(config.node as any).role = 'master'
    ;(config.node as any).id = p.nodeId
    await homeNewOrg(p.orgId)
    // lgrai.app, in this same process: the redemption runs as global, the rest as the master.
    globalThis.fetch = (async (url: any, init: any) => {
      const u = new URL(String(url))
      if (u.origin !== 'https://lgrai.test') return realFetch(url, init)
      ;(config.node as any).role = 'global'
      try {
        return await p.app.handle(new Request(`http://localhost${u.pathname}`, { method: init.method, headers: init.headers, body: init.body }))
      } finally {
        ;(config.node as any).role = 'master'
      }
    }) as any
  }

  it('offers the button only when linked, and turns the code into its own session', async () => {
    const p = await aPersonAndTheirServer()
    expect((await call(p.app, 'GET', '/api/auth/idp/config')).status).toBe(404) // global
    const one = pkce()
    const code = await aCode(p, one.challenge) // consent on lgrai.app, before the role changes
    await asMaster(p)
    expect(await (await call(p.app, 'GET', '/api/auth/idp/config')).json()).toEqual({ enabled: true, server: 'https://lgrai.test', clientId: p.nodeId })

    const r = await call(p.app, 'POST', '/api/auth/idp/redeem', undefined, { code, codeVerifier: one.verifier, redirectUri: REDIRECT })
    expect(r.status).toBe(200)
    const answer = await r.json()
    expect(answer.org.id).toBe(p.orgId)
    expect(answer.user.id).toBe(String(p.member._id))
    const claims = await (await jwt()).verify(answer.token)
    expect(claims.iid).toBe(String(p.identity._id))
    expect(r.headers.get('set-cookie') ?? '').toContain('__Host-auth=')
  })

  it('refuses an assertion that does not verify, and an org this server is not home for', async () => {
    const p = await aPersonAndTheirServer()
    const one = pkce()
    const code = await aCode(p, one.challenge)
    await asMaster(p)
    // lgrai.app answering with an assertion no built-in key signed.
    const forged = signAssertion({ aud: p.nodeId, sub: String(p.identity._id), org: p.orgId, uid: String(p.member._id), email: p.identity.email, tv: 0, amr: ['pwd'] }, ephemeralSigningKey()).jws
    const realRoute = globalThis.fetch
    globalThis.fetch = (async () => Response.json({ assertion: forged })) as any
    expect((await (await call(p.app, 'POST', '/api/auth/idp/redeem', undefined, { code, codeVerifier: one.verifier, redirectUri: REDIRECT })).json()).code).toBe('bad_assertion')
    globalThis.fetch = realRoute

    // An org whose home is not here.
    ;(config.node as any).id = 'master-aaaaaaaaaaaaaaaa'
    forgetAllHomes()
    ;(config.node as any).role = 'global'
    const two = pkce()
    const code2 = await aCode(p, two.challenge)
    ;(config.node as any).role = 'master'
    ;(config.node as any).id = p.nodeId
    // The assertion names this node; the org was homed above, so move its home away.
    const { OrgHome } = await import('db/models')
    await OrgHome.updateOne({ orgId: p.orgId }, { $set: { home: 'master-cccccccccccccccc' } })
    forgetAllHomes()
    const away = await call(p.app, 'POST', '/api/auth/idp/redeem', undefined, { code: code2, codeVerifier: two.verifier, redirectUri: REDIRECT })
    expect((await away.json()).code).toBe('org_home_elsewhere')
  })
})
