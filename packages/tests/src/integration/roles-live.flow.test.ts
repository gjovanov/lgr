import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { Elysia } from 'elysia'
import jwt from '@elysiajs/jwt'
import { setupTestDB, teardownTestDB } from '../setup'
import { createTestOrg, createTestUser } from '../helpers/factories'
import { createApiApp } from '../../../portal-api/src/api.js'
import { spaErrorHandler } from '../../../portal-api/src/spa-fallback.js'
import { config } from 'config'
import { mongoose } from 'db/connection'
import { AccessShadowDiff, Org, PermissionSet, Role, User, type IUser } from 'db/models'
import { tokenize } from 'services/biz/auth.service'
import { seedDefaultPermissionSets } from 'services/biz/permission-set.seed'
import { flushShadowDiffs, forgetAccessModel } from 'services/biz/access/shadow'
import { forgetMember, forgetRole } from 'services/biz/access/live'
import { rolesFromSets } from 'migrations/migrations/0015-roles-from-sets'

/**
 * FR-27.5 (#529) — an org on `roles`: each request is decided by the person's role, read live.
 *
 * - The same answers as the legacy rules for a migrated person (built-in roles are today's access).
 * - A change of a person's role, or of a role, reaches a session that is already signed in: no new token, nobody
 *   signed out. (Within the minute on another pod; at once here, where the change's own process forgets.)
 * - The legacy rules are asked beside it, and a role a release that reads no roles would serve otherwise is counted.
 * - Back on `legacy`, the token's claims decide again.
 *
 * NOTE: no `.rejects` / `.resolves` (Bun-on-Windows deadlock, see Known Issues).
 */

const signer = new Elysia().use(jwt({ name: 'jwt', secret: config.jwt.secret }))
let app: Elysia
let org: any
let orgId: string
const people: Record<string, IUser> = {}
const tokens: Record<string, string> = {}

async function request(method: string, path: string, token: string) {
  const res = await app.handle(new Request(`http://localhost/api/org/${orgId}${path}`, { method, headers: { authorization: `Bearer ${token}` } }))
  return { status: res.status, version: res.headers.get('x-access-version') }
}

async function model(m: 'legacy' | 'roles') {
  await Org.updateOne({ _id: org._id }, { $set: { 'settings.access.model': m } }).exec()
  forgetAccessModel(orgId)
}

const roleOf = async (key: string) => (await Role.findOne({ orgId: org._id, templateKey: key }).lean().exec()) as any

beforeAll(async () => {
  await setupTestDB()
  app = new Elysia().onError(spaErrorHandler({}) as any).use(createApiApp()) as any
  org = await createTestOrg({ slug: 'roles-live' } as any)
  orgId = String(org._id)
  await seedDefaultPermissionSets(orgId)
  const seller = (await PermissionSet.findOne({ orgId: org._id, name: 'Seller' }).lean().exec()) as any
  people.accountant = await createTestUser(org._id, { role: 'accountant', username: 'accountant', email: 'accountant@roles-live.test' } as any)
  people.seller = await createTestUser(org._id, { role: 'seller', username: 'seller', email: 'seller@roles-live.test', permissionSetIds: [seller._id] } as any)
  await rolesFromSets.up({ db: mongoose.connection.db as any, log: () => {}, orgFilter: {} })
  // Signed in while the org was still on the legacy model: these tokens carry no role.
  for (const key of Object.keys(people)) tokens[key] = await (signer as any).decorator.jwt.sign(await tokenize((await User.findById(people[key]._id).exec())!))
  await model('roles')
}, 60_000)

afterAll(async () => { await teardownTestDB() }, 60_000)

describe('FR-27.5: an org on roles', () => {
  it("a migrated person's role answers as the legacy rules did, and says its version", async () => {
    const accountant = await roleOf('accountant')
    // The journal: accounting's alone (the invoice form reads the chart of accounts, not the journal).
    const r = await request('GET', '/accounting/journal', tokens.accountant)
    expect(r.status).toBe(200)
    expect(r.version).toBe(`${accountant._id}:1`)
    expect((await request('GET', '/invoicing/payment-order', tokens.seller)).status).toBe(403)
    expect((await request('GET', '/invoices', tokens.seller)).status).toBe(200)
  })

  it('sign-in in such an org carries the role and its version, and its projection as the claims', async () => {
    const token = await tokenize((await User.findById(people.seller._id).exec())!)
    const seller = await roleOf('seller')
    expect(token).toMatchObject({ rid: String(seller._id), rv: 1, role: 'seller', areas: [] })
  })

  it("a change of a person's role reaches the session they are signed in with: no new token, no sign-out", async () => {
    const seller = await roleOf('seller')
    await User.updateOne({ _id: people.accountant._id }, { $set: { roleId: seller._id } }).exec()
    forgetMember(people.accountant._id)
    expect((await request('GET', '/accounting/journal', tokens.accountant)).status).toBe(403)
    expect((await request('GET', '/invoices', tokens.accountant)).status).toBe(200)
    const accountant = await roleOf('accountant')
    await User.updateOne({ _id: people.accountant._id }, { $set: { roleId: accountant._id } }).exec()
    forgetMember(people.accountant._id)
    expect((await request('GET', '/accounting/journal', tokens.accountant)).status).toBe(200)
  })

  it('an edit of a role reaches its people, and where a release that reads no roles would answer otherwise, it is counted', async () => {
    const seller = await roleOf('seller')
    await Role.updateOne({ _id: seller._id }, { $set: { edited: true, caps: ['sales-docs.view', 'payments.view'] }, $inc: { version: 1 } }).exec()
    forgetRole(seller._id)
    const r = await request('GET', '/invoicing/payment-order', tokens.seller)
    expect(r.status).toBe(200)
    expect(r.version).toBe(`${seller._id}:2`)
    await new Promise(res => setTimeout(res, 50))
    await flushShadowDiffs()
    const diff: any = await AccessShadowDiff.findOne({ org: org._id, route: '/api/org/:orgId/invoicing/payment-order' }).lean().exec()
    expect(diff).toMatchObject({ legacy: 'refuse', evaluator: 'allow', role: 'seller' })
  })

  it('back on legacy, the token decides again', async () => {
    await model('legacy')
    const r = await request('GET', '/invoicing/payment-order', tokens.seller)
    expect(r.status).toBe(403)
    expect(r.version).toBeNull()
  })
})
