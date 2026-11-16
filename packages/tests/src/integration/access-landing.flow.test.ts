import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { Elysia } from 'elysia'
import jwt from '@elysiajs/jwt'
import { setupTestDB, teardownTestDB } from '../setup'
import { createTestUser } from '../helpers/factories'
import { createApiApp } from '../../../portal-api/src/api.js'
import { spaErrorHandler } from '../../../portal-api/src/spa-fallback.js'
import { config } from 'config'
import { Org, Role, User } from 'db/models'
import { register, tokenize } from 'services/biz/auth.service'
import { forgetAccessModel } from 'services/biz/access/shadow'
import { forgetMember } from 'services/biz/access/live'

/**
 * FR-27.4 (#529) — a role's landing page: where its people start after signing in, and where "Not available for your
 * role" sends them (FR-27.7). It is a page the role opens, kept so when its capabilities change, and `/auth/me` tells
 * the SPA, which follows an edit through `x-access-version`.
 *
 * NOTE: no `.rejects` / `.resolves` (Bun-on-Windows deadlock, see Known Issues).
 */

const signer = new Elysia().use(jwt({ name: 'jwt', secret: config.jwt.secret }))
let app: Elysia
let orgId: string
let adminToken: string
let member: any
let roleId: string

async function call(method: string, path: string, token: string, body?: unknown) {
  const res = await app.handle(new Request(`http://localhost/api${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }))
  let json: any = null
  try { json = await res.json() } catch { /* not json */ }
  return { status: res.status, json, version: res.headers.get('x-access-version') }
}

const sign = async (userId: unknown) => (signer as any).decorator.jwt.sign(await tokenize((await User.findById(userId).exec())!))

beforeAll(async () => {
  await setupTestDB()
  app = new Elysia().onError(spaErrorHandler({}) as any).use(createApiApp()) as any
  const r = await register({ orgName: 'Landing', orgSlug: 'access-landing', email: 'founder@landing.test', username: 'founder', password: 'secure-pass-123', firstName: 'Fo', lastName: 'Under' })
  // What the activation link does. A session is a live membership's, and a founder still waiting for the link
  // holds none (`liveSessionUser`): the token signed below stood for one the product never gives.
  await User.updateOne({ _id: r.user._id }, { $set: { isActive: true } })
  orgId = String(r.org._id)
  adminToken = await sign(r.user._id)
  member = await createTestUser(r.org._id, { role: 'member', username: 'counter', email: 'counter@landing.test' } as any)
  await Org.updateOne({ _id: r.org._id }, { $set: { 'settings.access.model': 'roles' } }).exec()
  forgetAccessModel(orgId)
}, 60_000)

afterAll(async () => { await teardownTestDB() }, 60_000)

describe('FR-27.4: a landing is a page the role opens', () => {
  it('made with the role, and answered with it', async () => {
    const made = await call('POST', `/org/${orgId}/roles`, adminToken, { name: 'Counter', caps: ['sales-docs.view', 'products.view'], landing: '/inventory/products' })
    expect(made.status).toBe(200)
    expect(made.json.role.landing).toBe('/inventory/products')
    roleId = made.json.role.id
    expect((await call('GET', `/org/${orgId}/roles/${roleId}`, adminToken)).json.role.landing).toBe('/inventory/products')
  })

  it('a page the role does not open, an unknown one, or a variant with a query is refused, and nothing changes', async () => {
    const closed = await call('PUT', `/org/${orgId}/roles/${roleId}`, adminToken, { landing: '/payroll/employees' })
    expect(closed.status).toBe(422)
    expect(closed.json.code).toBe('landing_not_open')
    const unknown = await call('PUT', `/org/${orgId}/roles/${roleId}`, adminToken, { landing: '/nowhere' })
    expect(unknown.status).toBe(422)
    expect(unknown.json.code).toBe('landing_unknown')
    const variant = await call('PUT', `/org/${orgId}/roles/${roleId}`, adminToken, { landing: '/invoicing/invoices/new?type=credit_note' })
    expect(variant.status).toBe(422)
    expect(variant.json.code).toBe('landing_unknown')
    const role: any = await Role.findById(roleId).lean().exec()
    expect(role.landing).toBe('/inventory/products')
  })

  it("a new landing is a new version: the role's people's tabs ask again", async () => {
    const before: any = await Role.findById(roleId).lean().exec()
    const put = await call('PUT', `/org/${orgId}/roles/${roleId}`, adminToken, { landing: '/invoicing/invoices' })
    expect(put.status).toBe(200)
    expect(put.json.role.landing).toBe('/invoicing/invoices')
    expect(put.json.role.version).toBe((before.version ?? 1) + 1)
    // The same one again changes nothing.
    const same = await call('PUT', `/org/${orgId}/roles/${roleId}`, adminToken, { landing: '/invoicing/invoices' })
    expect(same.json.role.version).toBe(put.json.role.version)
  })

  it('capabilities that no longer open it drop it; null clears it', async () => {
    const narrowed = await call('PUT', `/org/${orgId}/roles/${roleId}`, adminToken, { caps: ['products.view'] })
    expect(narrowed.status).toBe(200)
    expect(narrowed.json.role.landing).toBeNull()
    expect(((await Role.findById(roleId).lean().exec()) as any).landing).toBeUndefined()

    await call('PUT', `/org/${orgId}/roles/${roleId}`, adminToken, { landing: '/inventory/products' })
    const cleared = await call('PUT', `/org/${orgId}/roles/${roleId}`, adminToken, { landing: null })
    expect(cleared.status).toBe(200)
    expect(cleared.json.role.landing).toBeNull()
  })
})

describe("FR-27.4: /auth/me tells the role's people", () => {
  it('the landing rides in `access`, with the version the SPA follows', async () => {
    await call('PUT', `/org/${orgId}/roles/${roleId}`, adminToken, { caps: ['sales-docs.view', 'products.view'], landing: '/inventory/products' })
    const assigned = await call('PUT', `/org/${orgId}/user/${member._id}`, adminToken, { roleId })
    expect(assigned.status).toBe(200)
    forgetMember(member._id)
    const me = await call('GET', '/auth/me', await sign(member._id))
    expect(me.status).toBe(200)
    expect(me.json.access.landing).toBe('/inventory/products')
    expect(me.json.access.role.landing).toBe('/inventory/products')
    expect(me.version).toBe(me.json.access.role.version)
  })

  it('a role with none answers null: the SPA starts on the Dashboard', async () => {
    await call('PUT', `/org/${orgId}/roles/${roleId}`, adminToken, { landing: null })
    const me = await call('GET', '/auth/me', await sign(member._id))
    expect(me.json.access.landing).toBeNull()
  })
})
