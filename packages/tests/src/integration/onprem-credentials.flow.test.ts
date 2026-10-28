import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { Elysia } from 'elysia'
import { randomBytes } from 'crypto'
import { config } from 'config'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { createTestOrg, createTestUser } from '../helpers/factories'
import { makeNodeStub, nodeEnrollBody } from '../helpers/node-stub'
import { createApiApp } from '../../../portal-api/src/api.js'
import { Identity, LocalCredential, NodeState, OnpremCredential, ServerNode } from 'db/models'
import { forgetAllHomes, homeNewOrg } from 'db/home/home'
import { enrollNode, issueNodeToken, mintNodeEnrollmentCode } from 'services/biz/node/node.service'
import { login, sessionFor } from 'services/biz/auth.service'
import { generateSealKey, openSealed } from 'services/biz/crypto/node-seal'
import { masterSealKey } from 'services/biz/node/node-seal-key'
import { credentialAad, credentialFeedPass } from 'services/biz/identity/onprem-credentials.service'
import { applyIdentityChanges } from 'services/biz/identity/identity-feed.service'
import { pinSignIn, forgetDesktopStreaks, setPin } from 'services/biz/identity/local-credentials.service'
import { captureRejection } from '../helpers/capture-rejection'

/**
 * Local credentials for an org's on-prem server, set on lgrai.app (FR-20.40, plan step P2-4c).
 *
 * A person sets a local password, and at a till a PIN, on their lgrai.app account. Global keeps an
 * argon2id verifier, refuses a local password equal to the global one, and delivers each verifier
 * to the org's master sealed to the master's seal key, which only the node key can vouch for. The
 * master opens them into `local_credentials`, where its sign-ins find them, and a password change on
 * lgrai.app ends them there.
 */

const ENROLL = 'https://lgrai.app/api/node/v1/enroll'
const TOKEN = 'https://lgrai.app/api/node/v1/token'
const GLOBAL_PW = 'global-password-0123'
const LOCAL_PW = 'local-password-4567'
const PIN = '583014'
const saved = { role: config.node.role, id: config.node.id }

beforeAll(async () => { await setupTestDB() })
afterAll(async () => { await teardownTestDB() })
afterEach(async () => {
  ;(config.node as any).role = saved.role
  ;(config.node as any).id = saved.id
  forgetAllHomes()
  forgetDesktopStreaks()
  await clearCollections()
})

const jwt = async () => ((new Elysia().use((await import('@elysiajs/jwt')).default({ name: 'jwt', secret: config.jwt.secret })) as any).decorator.jwt)
const call = (app: any, method: string, path: string, token?: string, body?: unknown) => app.handle(new Request(`http://localhost${path}`, {
  method,
  headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
  body: body !== undefined ? JSON.stringify(body) : undefined,
}))

/** A person with a password of their own, a till operator in an org that has a server, and their session. */
async function aShopWithAServer() {
  const org = await createTestOrg({ slug: `shop-${randomBytes(3).toString('hex')}` } as any)
  const identity: any = await Identity.create({
    email: `ana-${randomBytes(3).toString('hex')}@shop.test`, firstName: 'Ana', lastName: 'Shop',
    password: await Bun.password.hash(GLOBAL_PW), passwordSetBy: 'self',
  })
  const member: any = await createTestUser(org._id, { role: 'admin', identityId: identity._id, email: identity.email, operatorCode: '0007' } as any)
  const stub = makeNodeStub()
  const { code } = await mintNodeEnrollmentCode(String(org._id), String(member._id))
  await enrollNode({ ...nodeEnrollBody(stub, ENROLL), code } as any, [ENROLL])
  const token = async (claims?: Record<string, unknown>) =>
    (await issueNodeToken(stub.assertion({ sub: stub.nodeId, audience: TOKEN, claims }), [TOKEN])).token
  const session = await (await jwt()).sign({ ...(await sessionFor(member, identity)), exp: Math.floor(Date.now() / 1000) + 3600 })
  return { org, orgId: String(org._id), identity, member, nodeId: stub.nodeId, token, session, app: new Elysia().use(createApiApp()) }
}

describe('the seal key', () => {
  it('reaches global only inside a token assertion the node key signed', async () => {
    const s = await aShopWithAServer()
    await s.token()
    expect(((await ServerNode.findById(s.nodeId).lean()) as any).sealKey).toBeUndefined()

    const key = generateSealKey()
    await s.token({ seal: key.publicKey })
    const node: any = await ServerNode.findById(s.nodeId).lean()
    expect(node.sealKey).toBe(key.publicKey)
    expect(node.sealKeyAt).toBeInstanceOf(Date)

    // A token without the claim keeps it; a claim that is no key is ignored.
    await s.token()
    await s.token({ seal: Buffer.alloc(32).toString('base64url') })
    await s.token({ seal: 'not-a-key' })
    expect(((await ServerNode.findById(s.nodeId).lean()) as any).sealKey).toBe(key.publicKey)
  })
})

describe('the person sets them on lgrai.app', () => {
  it('lists the orgs with a server and keeps only a verifier, never the global password', async () => {
    const s = await aShopWithAServer()
    const list = async () => (await (await call(s.app, 'GET', '/api/auth/onprem', s.session)).json()).orgs
    const put = (kind: string, body: unknown, token = s.session) => call(s.app, 'PUT', `/api/auth/onprem/${s.orgId}/${kind}`, token, body)

    const [row] = await list()
    expect(row).toMatchObject({ orgId: s.orgId, operatorCode: true, password: null, pin: null })
    expect(row.servers).toEqual([{ id: s.nodeId, name: 'Kasa server', ready: false }])
    expect((await call(s.app, 'GET', '/api/auth/onprem')).status).toBe(401)

    expect((await put('password', { secret: LOCAL_PW, currentPassword: 'wrong-password-000' })).status).toBe(403)
    const same = await put('password', { secret: GLOBAL_PW, currentPassword: GLOBAL_PW })
    expect([same.status, (await same.json()).code]).toEqual([422, 'same_as_global'])
    expect((await put('password', { secret: 'short', currentPassword: GLOBAL_PW })).status).toBe(422)
    expect((await put('password', { secret: LOCAL_PW, currentPassword: GLOBAL_PW })).status).toBe(200)
    const weak = await put('pin', { secret: '123456', currentPassword: GLOBAL_PW })
    expect([weak.status, (await weak.json()).code]).toEqual([422, 'pin_rule'])
    expect((await put('pin', { secret: PIN, currentPassword: GLOBAL_PW })).status).toBe(200)
    expect((await put('kind', { secret: PIN, currentPassword: GLOBAL_PW })).status).toBe(404)

    const after = (await list())[0]
    expect(after.password).toMatchObject({ live: true })
    expect(after.pin).toMatchObject({ live: true })
    const stored: any[] = await OnpremCredential.find({ identityId: s.identity._id }).select('+verifier').lean()
    expect(stored).toHaveLength(2)
    for (const c of stored) expect(c.verifier).toStartWith('$argon2id$')
    expect(await Bun.password.verify(LOCAL_PW, stored.find(c => c.kind === 'password').verifier)).toBe(true)

    // Removed: a tombstone, so the master hears of it.
    expect((await (await call(s.app, 'DELETE', `/api/auth/onprem/${s.orgId}/pin`, s.session)).json()).removed).toBe(true)
    expect((await list())[0].pin).toBeNull()
    const tomb: any = await OnpremCredential.findOne({ identityId: s.identity._id, kind: 'pin' }).select('+verifier').lean()
    expect(tomb.removedAt).toBeInstanceOf(Date)
    expect(tomb.verifier).toBeUndefined()

    // A password change ends them on lgrai.app too.
    await Identity.updateOne({ _id: s.identity._id }, { $inc: { tokenVersion: 1 } })
    expect((await list())[0].password).toMatchObject({ live: false })
  })

  it('refuses an org with no server, a PIN without an operator code, and a password someone else set', async () => {
    const s = await aShopWithAServer()
    const other = await createTestOrg()
    await createTestUser(other._id, { identityId: s.identity._id, email: s.identity.email } as any)
    const noServer = await call(s.app, 'PUT', `/api/auth/onprem/${other._id}/password`, s.session, { secret: LOCAL_PW, currentPassword: GLOBAL_PW })
    expect([noServer.status, (await noServer.json()).code]).toEqual([409, 'no_server'])
    expect((await (await call(s.app, 'GET', '/api/auth/onprem', s.session)).json()).orgs.map((o: any) => o.orgId)).toEqual([s.orgId])

    const { User } = await import('db/models')
    await User.updateOne({ _id: s.member._id }, { $unset: { operatorCode: 1 } })
    const noCode = await call(s.app, 'PUT', `/api/auth/onprem/${s.orgId}/pin`, s.session, { secret: PIN, currentPassword: GLOBAL_PW })
    expect([noCode.status, (await noCode.json()).code]).toEqual([422, 'no_operator_code'])

    await Identity.updateOne({ _id: s.identity._id }, { $set: { passwordSetBy: 'admin' } })
    const notOwn = await call(s.app, 'PUT', `/api/auth/onprem/${s.orgId}/password`, s.session, { secret: LOCAL_PW, currentPassword: GLOBAL_PW })
    expect([notOwn.status, (await notOwn.json()).code]).toEqual([403, 'own_password_required'])

    ;(config.node as any).role = 'master'
    expect((await call(s.app, 'GET', '/api/auth/onprem', s.session)).status).toBe(404)
  })
})

describe('the credential feed', () => {
  it('waits for the seal key, then seals each credential to that server alone', async () => {
    const s = await aShopWithAServer()
    await call(s.app, 'PUT', `/api/auth/onprem/${s.orgId}/password`, s.session, { secret: LOCAL_PW, currentPassword: GLOBAL_PW })
    const token = await s.token()
    expect((await call(s.app, 'GET', '/api/node/v1/credential-changes')).status).toBe(401)
    const waiting = await call(s.app, 'GET', '/api/node/v1/credential-changes', token)
    expect([waiting.status, (await waiting.json()).code]).toEqual([409, 'no_seal_key'])

    const key = generateSealKey()
    const sealedToken = await s.token({ seal: key.publicKey })
    const res = await call(s.app, 'GET', '/api/node/v1/credential-changes', sealedToken)
    const text = await res.text()
    for (const shape of ['$argon2', '$2a$', '$2b$', LOCAL_PW]) expect(text).not.toContain(shape)
    const body = JSON.parse(text)
    expect(body.sealKey).toBe(key.publicKey)
    expect(body.items).toHaveLength(1)
    const [item] = body.items
    expect(item).toMatchObject({ iid: String(s.identity._id), org: s.orgId, kind: 'password', tv: 0 })

    const opened = JSON.parse(openSealed(key.privateKey, item.sealed, credentialAad(s.nodeId, item))!)
    expect(await Bun.password.verify(LOCAL_PW, opened.verifier)).toBe(true)
    // Bound to its item and its server: moved, altered or opened elsewhere it does not open.
    expect(openSealed(key.privateKey, item.sealed, credentialAad(s.nodeId, { ...item, tv: 1 }))).toBeNull()
    expect(openSealed(key.privateKey, item.sealed, credentialAad('master-aaaaaaaaaaaaaaaa', item))).toBeNull()
    expect(openSealed(generateSealKey().privateKey, item.sealed, credentialAad(s.nodeId, item))).toBeNull()

    // Nothing new past the cursor; a password change makes it travel as nothing, on a full pass.
    expect((await (await call(s.app, 'GET', `/api/node/v1/credential-changes?after=${encodeURIComponent(body.cursor)}`, sealedToken)).json()).items).toEqual([])
    await Identity.updateOne({ _id: s.identity._id }, { $inc: { tokenVersion: 1 } })
    const full = await (await call(s.app, 'GET', '/api/node/v1/credential-changes', sealedToken)).json()
    expect(full.items[0].sealed).toBeNull()

    // A cloned disk holds the seal key too: a server in clone alarm is delivered nothing.
    await ServerNode.updateOne({ _id: s.nodeId }, { $set: { cloneAlarm: { at: new Date(), channel: 'interactive', bootNonces: ['a', 'b'] } } })
    const clone = await call(s.app, 'GET', '/api/node/v1/credential-changes', sealedToken)
    expect([clone.status, (await clone.json()).code]).toEqual([409, 'clone_alarm'])
  })
})

describe('a master', () => {
  /** lgrai.app in this same process: its answer runs as global. */
  const viaGlobal = (app: any) => (async (url: any, init: any) => {
    const u = new URL(String(url))
    ;(config.node as any).role = 'global'
    try {
      return await app.handle(new Request(`http://localhost${u.pathname}${u.search}`, { headers: init?.headers }))
    } finally {
      ;(config.node as any).role = 'master'
    }
  }) as any

  async function aLinkedMaster() {
    const s = await aShopWithAServer()
    for (const [kind, secret] of [['password', LOCAL_PW], ['pin', PIN]]) {
      expect((await call(s.app, 'PUT', `/api/auth/onprem/${s.orgId}/${kind}`, s.session, { secret, currentPassword: GLOBAL_PW })).status).toBe(200)
    }
    ;(config.node as any).role = 'master'
    ;(config.node as any).id = s.nodeId
    await homeNewOrg(s.orgId)
    // The master's seal key, which its supervisor signs into the next token assertion.
    const key = (await masterSealKey())!
    const token = { server: 'https://lgrai.test', token: await s.token({ seal: key.publicKey }) }
    const pass = () => credentialFeedPass(token, new Date(), viaGlobal(s.app))
    const signIn = (password: string, localAllowed?: boolean) =>
      captureRejection(login({ orgSlug: s.org.slug, username: s.member.username, password, localAllowed }))
    return { ...s, key, pass, signIn }
  }

  it('opens them, and its PIN and local password sign-ins take them; the global password stops there', async () => {
    const m = await aLinkedMaster()
    expect(await m.pass()).toBe(2)
    const held: any[] = await LocalCredential.find({ identityId: m.identity._id }).lean()
    expect(held.map(c => [c.kind, c.source, String(c.forOrgId)]).sort()).toEqual([['password', 'lgrai', m.orgId], ['pin', 'lgrai', m.orgId]])

    expect((await pinSignIn({ orgId: m.orgId, operatorCode: '0007', pin: PIN })).identity.email).toBe(m.identity.email)
    expect(await m.signIn(LOCAL_PW)).toBeNull()
    // The local password stands in for the copy of the global one: once there is one, that does not sign in.
    expect((await m.signIn(GLOBAL_PW))?.code).toBe('invalid_credentials')
    // Through the tunnel a local credential does not sign in (FR-20.40).
    expect((await m.signIn(LOCAL_PW, false))?.code).toBe('invalid_credentials')
    expect(await m.signIn(GLOBAL_PW, false)).toBeNull()
    // Changing the PIN here takes the password that signs in here: the local one.
    expect((await captureRejection(setPin(String(m.identity._id), GLOBAL_PW, '736251')))?.code).toBe('wrong_password')
    expect(await captureRejection(setPin(String(m.identity._id), LOCAL_PW, '736251'))).toBeNull()
    expect((await pinSignIn({ orgId: m.orgId, operatorCode: '0007', pin: '736251' })).identity.email).toBe(m.identity.email)
    expect(((await LocalCredential.findOne({ identityId: m.identity._id, kind: 'pin' }).lean()) as any).source).toBeUndefined()

    // The daily full pass delivers the same again, and changes nothing: the PIN set here is newer
    // and stays, and the password's failure streak survives it.
    await LocalCredential.updateOne({ identityId: m.identity._id, kind: 'password' }, { $set: { failures: 2 } })
    await NodeState.updateOne({ _id: 'credential-feed' }, { $set: { 'value.fullAt': null } })
    expect(await m.pass()).toBe(0)
    expect(((await LocalCredential.findOne({ identityId: m.identity._id, kind: 'password' }).lean()) as any).failures).toBe(2)
    expect((await pinSignIn({ orgId: m.orgId, operatorCode: '0007', pin: '736251' })).identity.email).toBe(m.identity.email)
  })

  it('a password change on lgrai.app ends them here; a removal and a lost tombstone take them away', async () => {
    const m = await aLinkedMaster()
    await m.pass()
    // The identity feed brings the new tokenVersion: the local credentials it ends go.
    expect(await applyIdentityChanges([{ iid: String(m.identity._id), email: m.identity.email, firstName: 'Ana', lastName: 'Shop', tv: 1, active: true }])).toBe(1)
    expect(await LocalCredential.countDocuments({ identityId: m.identity._id })).toBe(0)
    const ended = await captureRejection(pinSignIn({ orgId: m.orgId, operatorCode: '0007', pin: PIN }))
    expect(ended?.code).toBe('pin_not_set')

    // Set again after the change: delivered again.
    ;(config.node as any).role = 'global'
    const session = await (await jwt()).sign({ ...(await sessionFor(m.member, (await Identity.findById(m.identity._id))!)), exp: Math.floor(Date.now() / 1000) + 3600 })
    expect((await call(m.app, 'PUT', `/api/auth/onprem/${m.orgId}/pin`, session, { secret: PIN, currentPassword: GLOBAL_PW })).status).toBe(200)
    ;(config.node as any).role = 'master'
    expect(await m.pass()).toBe(1)
    expect((await pinSignIn({ orgId: m.orgId, operatorCode: '0007', pin: PIN })).user.operatorCode).toBe('0007')

    // Removed on lgrai.app: the tombstone takes it away here.
    ;(config.node as any).role = 'global'
    expect((await (await call(m.app, 'DELETE', `/api/auth/onprem/${m.orgId}/pin`, session)).json()).removed).toBe(true)
    ;(config.node as any).role = 'master'
    expect(await m.pass()).toBe(1)
    expect(await LocalCredential.countDocuments({ identityId: m.identity._id, kind: 'pin' })).toBe(0)

    // A delivered credential lgrai.app no longer has at all (its tombstone expired) goes on the full pass.
    await LocalCredential.create({ identityId: m.identity._id, kind: 'password', verifier: '$argon2id$v=19$m=1,t=1,p=1$x$y', tvAtSet: 1, source: 'lgrai', forOrgId: '0123456789abcdef01234567' })
    await NodeState.updateOne({ _id: 'credential-feed' }, { $set: { 'value.fullAt': null } })
    await m.pass()
    expect(await LocalCredential.countDocuments({ identityId: m.identity._id, source: 'lgrai' })).toBe(0)
  })

  it('waits while lgrai.app seals to a key it no longer has', async () => {
    const m = await aLinkedMaster()
    // lgrai.app holds another key for this server (the master's own was lost and made again).
    await ServerNode.updateOne({ _id: m.nodeId }, { $set: { sealKey: generateSealKey().publicKey } })
    expect(await m.pass()).toBe(0)
    expect(await LocalCredential.countDocuments({ identityId: m.identity._id })).toBe(0)
    // The supervisor's next token signs the master's key in again, and everything arrives.
    await m.token({ seal: m.key.publicKey })
    expect(await m.pass()).toBe(2)
  })
})
