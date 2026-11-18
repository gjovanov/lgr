import { describe, it, expect, beforeAll, afterAll, spyOn } from 'bun:test'
import { Elysia } from 'elysia'
import jwt from '@elysiajs/jwt'
import { setupTestDB, teardownTestDB } from '../setup'
import { createApiApp } from '../../../portal-api/src/api.js'
import { spaErrorHandler } from '../../../portal-api/src/spa-fallback.js'
import { config } from 'config'
import { Identity, Role, User } from 'db/models'
import { register, tokenize } from 'services/biz/auth.service'
import { membershipsOf } from 'services/biz/identity/session.service'
import { exportNomenclature } from 'services/biz/supto-export.service'
import { logger } from 'services/logger'

/**
 * FR-27.3 (#529, the owner's answers 3 and 4 on the issue):
 *
 * - `POST`/`PUT /user` name a role by `roleKey`, a built-in role's template key, which is the same in every org (a role
 *   id is not). An unknown key is 422 `unknown_role_key`; `roleId` with `roleKey` is 422 `role_id_and_key`.
 * - A legacy `role` key is still the built-in role of that key for this release, and each use is logged (warn: the
 *   route, the org, the key; nothing about the person). The next release refuses it (422 `legacy_role_field`).
 * - A built-in role the org renamed shows its own name in the org menu and the SUPTO operators export, as on the
 *   Roles screen; one that still carries its template's name shows its key, as before.
 *
 * NOTE: no `.rejects` / `.resolves` (Bun-on-Windows deadlock, see Known Issues).
 */

const signer = new Elysia().use(jwt({ name: 'jwt', secret: config.jwt.secret }))
let app: Elysia
let org: any
let orgId: string
let adminToken: string

async function call(method: string, path: string, token: string | null, body?: unknown) {
  const res = await app.handle(new Request(`http://localhost/api${path}`, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }))
  let json: any = null
  try { json = await res.json() } catch { /* not json */ }
  return { status: res.status, json }
}

const sign = async (userId: unknown) => (signer as any).decorator.jwt.sign(await tokenize((await User.findById(userId).exec())!))
const builtin = async (key: string): Promise<any> => Role.findOne({ orgId: org._id, isBuiltin: true, templateKey: key }).lean().exec()
const person = (u: string) => ({ email: `${u}@rolekey.test`, username: u, password: 'a-long-password-1', firstName: 'Role', lastName: 'Key' })
const madeId = (r: { json: any }) => String(r.json.user._id ?? r.json.user.id)

beforeAll(async () => {
  await setupTestDB()
  app = new Elysia().onError(spaErrorHandler({}) as any).use(createApiApp()) as any
  const r = await register({ orgName: 'Role Key', orgSlug: 'role-key', email: 'founder@rolekey.test', username: 'founder', password: 'secure123', firstName: 'Fo', lastName: 'Under' })
  await User.updateOne({ _id: r.user._id }, { $set: { isActive: true } })
  await Identity.updateOne({ _id: r.user.identityId }, { $set: { isActive: true } })
  org = r.org
  orgId = String(org._id)
  adminToken = await sign(r.user._id)
}, 60_000)

afterAll(async () => { await teardownTestDB() }, 60_000)

describe('FR-27.3: a role named by its key on the user routes', () => {
  it('POST /user with roleKey: the built-in role of that key, and no legacy key written', async () => {
    const r = await call('POST', `/org/${orgId}/user`, adminToken, { ...person('bykey'), roleKey: 'accountant' })
    expect(r.status).toBe(200)
    const made: any = await User.findById(madeId(r)).lean().exec()
    expect(String(made.roleId)).toBe(String((await builtin('accountant'))._id))
    expect(made.role).toBeUndefined()
  })

  it('PUT /user with roleKey: the person moves to the built-in role of that key', async () => {
    const u: any = await User.findOne({ orgId: org._id, username: 'bykey' }).lean().exec()
    expect((await call('PUT', `/org/${orgId}/user/${u._id}`, adminToken, { roleKey: 'manager' })).status).toBe(200)
    expect(String((await User.findById(u._id).lean().exec() as any).roleId)).toBe(String((await builtin('manager'))._id))
  })

  it('an unknown key is 422 unknown_role_key, on a create (nobody made) and an edit (nothing changed)', async () => {
    const created = await call('POST', `/org/${orgId}/user`, adminToken, { ...person('nokey'), roleKey: 'owner' })
    expect({ status: created.status, code: created.json?.code }).toEqual({ status: 422, code: 'unknown_role_key' })
    expect(created.json.keys).toContain('seller')
    expect(await User.countDocuments({ orgId: org._id, username: 'nokey' })).toBe(0)

    const u: any = await User.findOne({ orgId: org._id, username: 'bykey' }).lean().exec()
    const edited = await call('PUT', `/org/${orgId}/user/${u._id}`, adminToken, { roleKey: 'owner' })
    expect({ status: edited.status, code: edited.json?.code }).toEqual({ status: 422, code: 'unknown_role_key' })
    expect(String((await User.findById(u._id).lean().exec() as any).roleId)).toBe(String(u.roleId))
  })

  it('a role named twice is refused: roleId with roleKey, or either with the legacy role', async () => {
    const seller = String((await builtin('seller'))._id)
    const both = await call('POST', `/org/${orgId}/user`, adminToken, { ...person('twice'), roleId: seller, roleKey: 'seller' })
    expect({ status: both.status, code: both.json?.code }).toEqual({ status: 422, code: 'role_id_and_key' })
    const withLegacy = await call('POST', `/org/${orgId}/user`, adminToken, { ...person('twice'), roleKey: 'seller', role: 'seller' })
    expect({ status: withLegacy.status, code: withLegacy.json?.code }).toEqual({ status: 422, code: 'role_and_legacy' })
    expect(await User.countDocuments({ orgId: org._id, username: 'twice' })).toBe(0)

    const u: any = await User.findOne({ orgId: org._id, username: 'bykey' }).lean().exec()
    const edit = await call('PUT', `/org/${orgId}/user/${u._id}`, adminToken, { roleId: seller, roleKey: 'seller' })
    expect({ status: edit.status, code: edit.json?.code }).toEqual({ status: 422, code: 'role_id_and_key' })
  })

  it('a legacy role key still converts this release, and each use is logged with the route, the org and the key only', async () => {
    const warn = spyOn(logger, 'warn')
    try {
      const r = await call('POST', `/org/${orgId}/user`, adminToken, { ...person('legacy'), role: 'seller' })
      expect(r.status).toBe(200)
      const made: any = await User.findById(madeId(r)).lean().exec()
      expect(String(made.roleId)).toBe(String((await builtin('seller'))._id))
      expect((await call('PUT', `/org/${orgId}/user/${made._id}`, adminToken, { role: 'member' })).status).toBe(200)

      const logged = warn.mock.calls.map(c => c[0] as any).filter(o => o && typeof o === 'object' && 'route' in o)
      expect(logged).toEqual([
        { route: 'POST /user', orgId, key: 'seller' },
        { route: 'PUT /user/:userId', orgId, key: 'member' },
      ])
      // Nothing about the person: no address, no name, no id.
      expect(JSON.stringify(warn.mock.calls)).not.toContain('legacy@rolekey.test')
      expect(JSON.stringify(warn.mock.calls)).not.toContain(String(made._id))
    } finally {
      warn.mockRestore()
    }
  })

  it('roleKey is not logged', async () => {
    const warn = spyOn(logger, 'warn')
    try {
      expect((await call('POST', `/org/${orgId}/user`, adminToken, { ...person('quiet'), roleKey: 'member' })).status).toBe(200)
      expect(warn.mock.calls.map(c => c[0] as any).filter(o => o && typeof o === 'object' && 'route' in o)).toEqual([])
    } finally {
      warn.mockRestore()
    }
  })
})

describe('FR-27 P3-5 (#529, answer 4): a renamed built-in role shows its own name', () => {
  /** The role as the org menu (`membershipsOf`), the SUPTO operators export and the Roles screen name it. */
  async function shown(username: string) {
    const u: any = await User.findOne({ orgId: org._id, username }).lean().exec()
    const menu = (await membershipsOf(u.identityId)).find(m => m.org.id === orgId)?.role
    const exported = (await exportNomenclature(orgId)).users.find((x: any) => x.username === username)?.role
    const roles = (await call('GET', `/org/${orgId}/roles`, adminToken)).json.roles
    const screen = roles.find((r: any) => r.id === String(u.roleId))?.name
    return { menu, exported, screen }
  }

  it('un-renamed: its key, as before (the SPA translates it); the Roles screen its template name', async () => {
    expect((await call('POST', `/org/${orgId}/user`, adminToken, { ...person('seller1'), roleKey: 'seller' })).status).toBe(200)
    expect(await shown('seller1')).toEqual({ menu: 'seller', exported: 'seller', screen: 'Seller' })
  })

  it('renamed: the org menu, the export and the Roles screen agree on its new name', async () => {
    const seller = await builtin('seller')
    expect((await call('PUT', `/org/${orgId}/roles/${seller._id}`, adminToken, { name: 'Counter staff' })).status).toBe(200)
    expect(await shown('seller1')).toEqual({ menu: 'Counter staff', exported: 'Counter staff', screen: 'Counter staff' })
  })
})
