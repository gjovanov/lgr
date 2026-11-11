import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { Elysia } from 'elysia'
import jwt from '@elysiajs/jwt'
import { setupTestDB, teardownTestDB } from '../setup'
import { createTestUser } from '../helpers/factories'
import { createApiApp } from '../../../portal-api/src/api.js'
import { spaErrorHandler } from '../../../portal-api/src/spa-fallback.js'
import { config } from 'config'
import { APP_IDS, APP_REGISTRY } from 'config/constants'
import { Org, User } from 'db/models'
import { register, tokenize } from 'services/biz/auth.service'
import { forgetAccessModel } from 'services/biz/access/shadow'
import { forgetMember } from 'services/biz/access/live'

/**
 * FR-27.5 (#529) — the App Hub in an org on `roles`: a tile for each app whose pages the person's role opens, read
 * live. A role that opens the Products page but holds only part of `inventory.read` gets the Inventory tile (its
 * projection carries no `inventory.read`), and an edit reaches the tiles with the same token, no sign-out. Back on the
 * legacy model the token's permissions decide, as before.
 *
 * NOTE: no `.rejects` / `.resolves` (Bun-on-Windows deadlock, see Known Issues).
 */

const signer = new Elysia().use(jwt({ name: 'jwt', secret: config.jwt.secret }))
let app: Elysia
let orgId: string
let adminToken: string
let member: any
let memberToken: string
let roleId: string

async function call(method: string, path: string, token: string, body?: unknown) {
  const res = await app.handle(new Request(`http://localhost/api${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }))
  let json: any = null
  try { json = await res.json() } catch { /* not json */ }
  return { status: res.status, json }
}

const sign = async (userId: unknown) => (signer as any).decorator.jwt.sign(await tokenize((await User.findById(userId).exec())!))
const tiles = async (token: string) => {
  const res = await call('GET', `/org/${orgId}/apps`, token)
  expect(res.status).toBe(200)
  return res.json.apps.map((a: any) => a.id).sort()
}

beforeAll(async () => {
  await setupTestDB()
  app = new Elysia().onError(spaErrorHandler({}) as any).use(createApiApp()) as any
  const r = await register({ orgName: 'App Hub', orgSlug: 'access-app-hub', email: 'founder@app-hub.test', username: 'founder', password: 'secure-pass-123', firstName: 'Fo', lastName: 'Under' })
  orgId = String(r.org._id)
  adminToken = await sign(r.user._id)
  member = await createTestUser(r.org._id, { role: 'member', username: 'clerk', email: 'clerk@app-hub.test', permissions: ['inventory.read'] } as any)
  await Org.updateOne({ _id: r.org._id }, { $set: { 'settings.access.model': 'roles' } }).exec()
  forgetAccessModel(orgId)
}, 60_000)

afterAll(async () => { await teardownTestDB() }, 60_000)

describe("FR-27.5: the App Hub shows the role's apps, live", () => {
  it('a role that opens Products, and holds nothing else of Inventory, has the Inventory tile', async () => {
    const made = await call('POST', `/org/${orgId}/roles`, adminToken, { name: 'Shelf', caps: ['products.view'] })
    expect(made.status).toBe(200)
    roleId = made.json.role.id
    const assigned = await call('PUT', `/org/${orgId}/user/${member._id}`, adminToken, { roleId })
    expect(assigned.status).toBe(200)
    forgetMember(member._id)
    memberToken = await sign(member._id)
    // What its token says: the projection holds no permission whose every capability the role holds.
    const claims = JSON.parse(atob(memberToken.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')))
    expect(claims.permissions ?? []).not.toContain('inventory.read')
    expect(await tiles(memberToken)).toEqual(['inventory'])
  })

  it('an edit reaches the tiles with the same token: Invoicing comes, and goes again', async () => {
    expect((await call('PUT', `/org/${orgId}/roles/${roleId}`, adminToken, { caps: ['products.view', 'sales-docs.view'] })).status).toBe(200)
    expect(await tiles(memberToken)).toEqual(['inventory', 'invoicing'])
    expect((await call('PUT', `/org/${orgId}/roles/${roleId}`, adminToken, { caps: ['sales-docs.view'] })).status).toBe(200)
    expect(await tiles(memberToken)).toEqual(['invoicing'])
  })

  it('the Administrator has every tile', async () => {
    expect(await tiles(adminToken)).toEqual(['accounting', 'files', 'inventory', 'invoicing', 'payroll', 'reports'])
  })

  it("back on the legacy model, the token's permissions decide, as before", async () => {
    await Org.updateOne({ _id: orgId }, { $set: { 'settings.access.model': 'legacy' } }).exec()
    forgetAccessModel(orgId)
    const legacyClerk = await createTestUser(orgId as any, { role: 'member', username: 'legacy-clerk', email: 'legacy@app-hub.test', permissions: ['inventory.read'] } as any)
    const token = await sign(legacyClerk._id)
    const perms: string[] = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).permissions ?? []
    const expected = APP_IDS.filter(a => [APP_REGISTRY[a].requiredPermission, ...(APP_REGISTRY[a].alsoOpenedBy ?? [])].some(x => perms.includes(x)))
    expect(expected).toContain('inventory')
    expect(await tiles(token)).toEqual([...expected].sort())
  })
})
