import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { Elysia } from 'elysia'
import jwt from '@elysiajs/jwt'
import { setupTestDB, teardownTestDB } from '../setup'
import { createTestOrg, createTestUser } from '../helpers/factories'
import { createApiApp } from '../../../portal-api/src/api.js'
import { spaErrorHandler } from '../../../portal-api/src/spa-fallback.js'
import { config } from 'config'
import { mongoose } from 'db/connection'
import { Org, Role, User } from 'db/models'
import { tokenize } from 'services/biz/auth.service'
import { forgetAccessModel } from 'services/biz/access/shadow'
import { forgetMember, forgetRole } from 'services/biz/access/live'

/**
 * FR-27.7 (#529) — the Files app reads with `files.view` and changes documents with `files.manage` (upload, OCR, book,
 * undo, reconcile, delete, pack and unpack an archive). The legacy model grants both with `admin.settings`, so only a
 * role tells them apart: one that reads the documents is refused every change, before anything runs.
 *
 * NOTE: no `.rejects` / `.resolves` (Bun-on-Windows deadlock, see Known Issues).
 */

const signer = new Elysia().use(jwt({ name: 'jwt', secret: config.jwt.secret }))
let app: Elysia
let orgId: string
const tokens: Record<string, string> = {}

async function call(method: string, path: string, token: string, body?: unknown) {
  const res = await app.handle(new Request(`http://localhost/api/org/${orgId}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }))
  let json: any = null
  try { json = await res.json() } catch { /* not json */ }
  return { status: res.status, json }
}

const sign = async (id: unknown) => (signer as any).decorator.jwt.sign(await tokenize((await User.findById(id).exec())!))

beforeAll(async () => {
  await setupTestDB()
  app = new Elysia().onError(spaErrorHandler({}) as any).use(createApiApp()) as any
  const org: any = await createTestOrg({ slug: 'access-files-manage' } as any)
  orgId = String(org._id)
  const admin = await createTestUser(org._id, { role: 'admin', username: 'admin', email: 'admin@files-manage.test' } as any)
  const reader = await createTestUser(org._id, { role: 'member', username: 'reader', email: 'reader@files-manage.test' } as any)
  const settings = await createTestUser(org._id, { role: 'member', username: 'settings', email: 'settings@files-manage.test', permissions: ['admin.settings'] } as any)
  tokens.admin = await sign(admin._id)
  tokens.settings = await sign(settings._id)
  await Org.updateOne({ _id: org._id }, { $set: { 'settings.access.model': 'roles' } }).exec()
  forgetAccessModel(orgId)
  const role: any = await Role.create({ orgId: org._id, name: 'Archivist', caps: ['files.view'], isBuiltin: false, edited: true, version: 1, legacy: { role: 'member', permissions: [] } } as any)
  await User.updateOne({ _id: reader._id }, { $set: { roleId: role._id } }).exec()
  forgetMember(reader._id)
  forgetRole(role._id)
  tokens.reader = await sign(reader._id)
}, 60_000)

afterAll(async () => { await teardownTestDB() }, 60_000)

describe('FR-27.7: files.view reads, files.manage changes', () => {
  it('a role that reads the documents lists them, and is refused a change before it runs', async () => {
    expect((await call('GET', '/files', tokens.reader)).status).toBe(200)
    const del = await call('POST', '/files/delete-batch', tokens.reader, { docFileIds: [String(new mongoose.Types.ObjectId())] })
    expect(del.status).toBe(403)
    expect(del.json.code).toBe('capability_required')
    expect(del.json.capabilities).toEqual(['files.manage'])
    const pack = await call('POST', `/files/archives/${new mongoose.Types.ObjectId()}`, tokens.reader)
    expect(pack.status).toBe(403)
    expect(pack.json.capabilities).toEqual(['files.manage'])
  })

  it('the Administrator, and on the legacy model `admin.settings`, pass the gate as before', async () => {
    // An empty batch is the route's own 400, past the gate.
    expect((await call('POST', '/files/delete-batch', tokens.admin, { docFileIds: [] })).status).toBe(400)
    await Org.updateOne({ _id: orgId }, { $set: { 'settings.access.model': 'legacy' } }).exec()
    forgetAccessModel(orgId)
    expect((await call('POST', '/files/delete-batch', tokens.settings, { docFileIds: [] })).status).toBe(400)
  })
})
