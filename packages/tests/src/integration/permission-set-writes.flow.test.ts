import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { Elysia } from 'elysia'
import jwt from '@elysiajs/jwt'
import { setupTestDB, teardownTestDB } from '../setup'
import { createTestOrg, createTestUser } from '../helpers/factories'
import { createApiApp } from '../../../portal-api/src/api.js'
import { config } from 'config'
import { PERMISSIONS } from 'config/constants'
import { PermissionSet, User } from 'db/models'
import { tokenize } from 'services/biz/auth.service'
import { createPermissionSet } from 'services/biz/permission-set.service'

/**
 * Writing a permission set is assigning access.
 *
 * Whatever a set grants, everyone who holds it gets, the editor among them, and assigning a set to
 * a person is `admin`'s alone (`user.controller`). The set routes used to be open to `admin.settings`
 * as well, with nothing holding the editor to what they grant. They are `admin`'s now; reading the
 * sets stays under `admin.settings`.
 *
 * Over HTTP, against the real route table, as `route-permission.flow` does. Every refused write is
 * followed by a read of the row, so "403" cannot pass while the write went through anyway.
 *
 * NOTE: no `.rejects` / `.resolves` (Bun-on-Windows deadlock, see Known Issues).
 */

let app: Elysia
let orgId: string
const signer = new Elysia().use(jwt({ name: 'jwt', secret: config.jwt.secret }))

let deputySetId: string
let bystanderSetId: string
let spareSetId: string
let deputyId: string
let bystanderId: string
let setlessId: string
const tokens: Record<string, string> = {}

async function sign(claims: object): Promise<string> {
  return (signer as any).decorator.jwt.sign(claims)
}

async function call(method: string, path: string, token: string, body: unknown = {}) {
  const res = await app.handle(new Request(`http://localhost${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: method === 'DELETE' ? undefined : JSON.stringify(body),
  }))
  let json: any = null
  try { json = await res.json() } catch { /* not json */ }
  return { status: res.status, json }
}

const sets = (p = '') => `/api/org/${orgId}/permission-sets${p}`
const setRow = (id: string) => PermissionSet.findById(id).lean().exec() as Promise<any>

beforeAll(async () => {
  await setupTestDB()
  app = new Elysia().use(createApiApp())
  const org = await createTestOrg({ slug: 'permission-set-writes' } as any)
  orgId = String(org._id)

  const deputySet = await createPermissionSet(orgId, { name: 'Deputy', permissions: ['admin.settings', 'invoicing.read'] })
  const bystanderSet = await createPermissionSet(orgId, { name: 'Bystander', permissions: ['invoicing.read'] })
  const spareSet = await createPermissionSet(orgId, { name: 'Spare', permissions: ['inventory.read'] })
  deputySetId = String(deputySet._id)
  bystanderSetId = String(bystanderSet._id)
  spareSetId = String(spareSet._id)

  const admin = await createTestUser(org._id, { role: 'admin', email: 'admin@psw.test', username: 'psw-admin' } as any)
  const deputy = await createTestUser(org._id, { role: 'member', email: 'deputy@psw.test', username: 'psw-deputy', permissionSetIds: [deputySet._id] } as any)
  const bystander = await createTestUser(org._id, { role: 'member', email: 'by@psw.test', username: 'psw-by', permissionSetIds: [bystanderSet._id] } as any)
  const setless = await createTestUser(org._id, { role: 'sales', email: 'sales@psw.test', username: 'psw-sales' } as any)
  const plain = await createTestUser(org._id, { role: 'member', email: 'plain@psw.test', username: 'psw-plain' } as any)
  deputyId = String(deputy._id)
  bystanderId = String(bystander._id)
  setlessId = String(setless._id)

  // What sign-in issues, so the deputy really holds `admin.settings` and nothing else of the settings.
  tokens.admin = await sign(await tokenize(admin))
  tokens.deputy = await sign(await tokenize(deputy))
  tokens.plain = await sign(await tokenize(plain))
  // The worst case: every permission there is, and still not the admin role.
  tokens.everything = await sign({ ...(await tokenize(deputy)), permissions: [...PERMISSIONS] })
}, 120_000)

afterAll(async () => {
  await teardownTestDB()
})

describe('a holder of admin.settings reads the permission sets', () => {
  it('the list, one set and a person\'s effective access answer 200', async () => {
    const list = await call('GET', sets(), tokens.deputy)
    expect(list.status).toBe(200)
    expect((list.json.permissionSets as any[]).map(s => s.name).sort()).toEqual(['Bystander', 'Deputy', 'Spare'])
    expect((await call('GET', sets(`/${deputySetId}`), tokens.deputy)).status).toBe(200)
    expect((await call('GET', sets(`/effective/${bystanderId}`), tokens.deputy)).status).toBe(200)
  })

  it('a member without it is refused the reads, as before', async () => {
    expect((await call('GET', sets(), tokens.plain)).status).toBe(403)
  })
})

describe('and cannot change what a set grants', () => {
  it('create: 403, and no set appears', async () => {
    const res = await call('POST', sets(), tokens.deputy, { name: 'Mine', permissions: ['payroll.personal'], isAdmin: true })
    expect(res.status).toBe(403)
    expect(await PermissionSet.countDocuments({ orgId, name: 'Mine' })).toBe(0)
  })

  it('edit the set they hold: 403, and it grants what it did', async () => {
    const before = await setRow(deputySetId)
    expect((await call('PUT', sets(`/${deputySetId}`), tokens.deputy, { isAdmin: true })).status).toBe(403)
    expect((await call('PUT', sets(`/${deputySetId}`), tokens.deputy, { permissions: [...PERMISSIONS] })).status).toBe(403)
    expect((await call('PUT', sets(`/${deputySetId}`), tokens.deputy, { areas: null })).status).toBe(403)
    const after = await setRow(deputySetId)
    expect(after.isAdmin).toBe(false)
    expect([...after.permissions].sort()).toEqual([...before.permissions].sort())
  })

  it('edit someone else\'s set: 403, unchanged', async () => {
    const before = await setRow(bystanderSetId)
    expect((await call('PUT', sets(`/${bystanderSetId}`), tokens.deputy, { isAdmin: true, permissions: ['payroll.write'] })).status).toBe(403)
    const after = await setRow(bystanderSetId)
    expect(after.isAdmin).toBe(false)
    expect([...after.permissions]).toEqual([...before.permissions])
  })

  it('delete: 403, and the set stays', async () => {
    expect((await call('DELETE', sets(`/${spareSetId}`), tokens.deputy)).status).toBe(403)
    expect(await setRow(spareSetId)).not.toBeNull()
  })

  it('migrate: 403, and nobody is moved onto a set', async () => {
    expect((await call('POST', sets('/migrate'), tokens.deputy)).status).toBe(403)
    const u = await User.findById(setlessId).lean().exec() as any
    expect((u.permissionSetIds ?? []).length).toBe(0)
  })

  it('the refusal says why, and is the same for a holder of every permission without the admin role', async () => {
    const res = await call('PUT', sets(`/${deputySetId}`), tokens.everything, { isAdmin: true })
    expect(res.status).toBe(403)
    // S-28's order: refused before the body is read, by the route's floor (`roles.edit`), which only the admin role
    // holds on the legacy model.
    expect(res.json).toMatchObject({ code: 'permission_required', capabilities: ['roles.edit'] })
    expect((await setRow(deputySetId)).isAdmin).toBe(false)
  })

  it('the session they sign in with next is what it was', async () => {
    const reissued = await tokenize((await User.findById(deputyId).exec()) as any)
    expect([...reissued.permissions].sort()).toEqual(['admin.settings', 'invoicing.read'])
  })
})

describe('the same bar as assigning a set to a person', () => {
  it('PUT user is the admin role\'s too, so a set cannot be taken by another road', async () => {
    const res = await call('PUT', `/api/org/${orgId}/user/${bystanderId}`, tokens.everything, { permissionSetIds: [deputySetId] })
    expect(res.status).toBe(403)
    const u = await User.findById(bystanderId).lean().exec() as any
    expect(u.permissionSetIds.map(String)).toEqual([bystanderSetId])
  })
})

describe('an administrator writes them as before', () => {
  it('create, edit and delete answer 200 and take effect', async () => {
    const created = await call('POST', sets(), tokens.admin, { name: 'Counter', permissions: ['invoicing.read'] })
    expect(created.status).toBe(200)
    const id = String(created.json.permissionSet._id)

    const edited = await call('PUT', sets(`/${id}`), tokens.admin, { permissions: ['invoicing.read', 'invoicing.write'], description: 'edited' })
    expect(edited.status).toBe(200)
    expect([...(await setRow(id)).permissions].sort()).toEqual(['invoicing.read', 'invoicing.write'])

    expect((await call('DELETE', sets(`/${id}`), tokens.admin)).status).toBe(200)
    expect(await setRow(id)).toBeNull()
  })

  it('migrate is theirs too', async () => {
    expect((await call('POST', sets('/migrate'), tokens.admin)).status).toBe(200)
  })
})
