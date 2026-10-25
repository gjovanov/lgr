import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { Elysia } from 'elysia'
import { randomBytes } from 'crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { config } from 'config'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { createTestOrg, createTestUser } from '../helpers/factories'
import { createApiApp } from '../../../portal-api/src/api.js'
import { Identity, User } from 'db/models'
import { forgetAllHomes, homeNewOrg } from 'db/home/home'
import { sessionFor } from 'services/biz/auth.service'

/**
 * FR-20.42 — on a LINKED master (registered with lgrai.app) the people are lgrai.app's: their names,
 * addresses and passwords are changed there and reach the master through the identity feed. An
 * admin on the master manages memberships: role, permissions, operator code. An Air-gapped master
 * owns its people (FR-20.41) and keeps today's behaviour.
 */

const GLOBAL_PW = 'global-password-0123'
const saved = { role: config.node.role, id: config.node.id, tokenFile: config.outbox.tokenFile }
let tmp = ''

beforeAll(async () => { await setupTestDB() })
afterAll(async () => { await teardownTestDB() })
afterEach(async () => {
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

async function aMaster(linked: boolean) {
  const org = await createTestOrg()
  const person = async (first: string, role: string) => {
    const identity: any = await Identity.create({
      email: `${first.toLowerCase()}-${randomBytes(3).toString('hex')}@shop.test`, firstName: first, lastName: 'Shop',
      password: await Bun.password.hash(GLOBAL_PW), passwordSetBy: 'self',
    })
    const member: any = await createTestUser(org._id, { role, identityId: identity._id, email: identity.email, firstName: first, lastName: 'Shop' } as any)
    return { identity, member }
  }
  const admin = await person('Ana', 'admin')
  const clerk = await person('Boris', 'member')
  ;(config.node as any).role = 'master'
  ;(config.node as any).id = 'master-abcdefghijklmnop'
  await homeNewOrg(String(org._id))
  if (linked) {
    // What the supervisor keeps while the master is registered: its token may well have run out.
    tmp = mkdtempSync(join(tmpdir(), 'lgr-linked-'))
    const file = join(tmp, 'node-token.json')
    writeFileSync(file, JSON.stringify({ server: 'https://lgrai.test', token: 'expired', expiresAt: 0 }))
    ;(config.outbox as any).tokenFile = file
  } else {
    ;(config.outbox as any).tokenFile = ''
  }
  const session = await (await jwt()).sign({ ...(await sessionFor(admin.member, admin.identity)), exp: Math.floor(Date.now() / 1000) + 3600 })
  return { orgId: String(org._id), admin, clerk, session, app: new Elysia().use(createApiApp()) }
}

describe('a linked master', () => {
  it('refuses changes to a person and points to lgrai.app; the membership stays its own', async () => {
    const m = await aMaster(true)
    const edit = (body: unknown) => call(m.app, 'PUT', `/api/org/${m.orgId}/user/${m.clerk.member._id}`, m.session, body)

    for (const body of [{ firstName: 'Borislav' }, { email: 'new@shop.test' }, { password: 'admin-set-password-1' }]) {
      const r = await edit(body)
      expect([r.status, (await r.json()).code]).toEqual([409, 'edit_on_lgrai'])
    }
    expect(((await Identity.findById(m.clerk.identity._id).lean()) as any).firstName).toBe('Boris')

    // The membership is the master's: a role change, with the person's fields sent back unchanged.
    const role = await edit({ role: 'manager', firstName: 'Boris', lastName: 'Shop', email: m.clerk.identity.email })
    expect(role.status).toBe(200)
    expect(((await User.findById(m.clerk.member._id).lean()) as any).role).toBe('manager')

    const own = await call(m.app, 'POST', '/api/auth/password', m.session, { currentPassword: GLOBAL_PW, newPassword: 'another-password-456' })
    expect([own.status, (await own.json()).code]).toEqual([409, 'edit_on_lgrai'])
    const forgot = await call(m.app, 'POST', '/api/auth/password/forgot', undefined, { email: m.admin.identity.email })
    expect(forgot.status).toBe(409)
    expect(await forgot.json()).toMatchObject({ code: 'edit_on_lgrai', manageOn: 'https://lgrai.test' })
    const reset = await call(m.app, 'POST', '/api/auth/password/reset', undefined, { token: 'x'.repeat(40), newPassword: 'another-password-456' })
    expect([reset.status, (await reset.json()).code]).toEqual([409, 'edit_on_lgrai'])

    const me = await (await call(m.app, 'GET', '/api/auth/me', m.session)).json()
    expect(me.identity.manageOn).toBe('https://lgrai.test')
  })
})

describe('an Air-gapped master', () => {
  it('owns its people: an admin edits them, and a person changes their own password', async () => {
    const m = await aMaster(false)
    const r = await call(m.app, 'PUT', `/api/org/${m.orgId}/user/${m.clerk.member._id}`, m.session, { firstName: 'Borislav' })
    expect(r.status).toBe(200)
    expect(((await Identity.findById(m.clerk.identity._id).lean()) as any).firstName).toBe('Borislav')
    expect((await call(m.app, 'GET', '/api/auth/me', m.session).then(x => x.json())).identity.manageOn).toBeNull()
    const own = await call(m.app, 'POST', '/api/auth/password', m.session, { currentPassword: GLOBAL_PW, newPassword: 'another-password-456' })
    expect(own.status).toBe(200)
  })
})
