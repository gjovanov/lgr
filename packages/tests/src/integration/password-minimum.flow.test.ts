import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { Elysia } from 'elysia'
import jwt from '@elysiajs/jwt'
import { setupTestDB, teardownTestDB } from '../setup'
import { createTestOrg, createTestUser } from '../helpers/factories'
import { createApiApp } from '../../../portal-api/src/api.js'
import { spaErrorHandler } from '../../../portal-api/src/spa-fallback.js'
import { config } from 'config'
import { DEFAULT_ROLE_PERMISSIONS } from 'config/constants'

/**
 * S-09: every password a person sets has at least 12 characters.
 *
 * A change and a reset have asked for 12 since the multi-org work, and so has a server's local
 * password. Sign-up, an admin creating a user and an admin changing one still took 6, so a password
 * could go in through one of those that no change would ever accept again.
 *
 * Measured over the real route table, as a property: a body field named like a password either SETS
 * one (and asks for at least 12) or PROVES one, and then it is listed below with why. A route added
 * later that sets a password with a lower minimum fails here the day it is mounted.
 */

const MIN = 12

/** Fields that prove a password rather than set one. Each says why it has no minimum. */
const VERIFIES: Record<string, string> = {
  'POST /api/auth/login password': 'signs in with it',
  'POST /api/auth/password currentPassword': 'proves the old password before a change',
  'PUT /api/auth/local/pin password': 'proves the password before a PIN is set',
  'PUT /api/auth/onprem/:org/:kind currentPassword': 'proves the password before a local one is set',
  'POST /api/org/:orgId/fiscal/device/:id/program-operator password': "a fiscal device's operator password, under the device's own rule",
}

/** Every password-like body field of the real route table, with its minimum. */
function passwordFields(): Array<{ key: string; min: number | undefined }> {
  const out: Array<{ key: string; min: number | undefined }> = []
  for (const r of (createApiApp() as any).routes as any[]) {
    const props = (r.hooks?.body ?? r.hook?.body)?.properties
    if (!props) continue
    for (const [field, schema] of Object.entries<any>(props)) {
      if (/password/i.test(field)) out.push({ key: `${r.method} ${r.path} ${field}`, min: schema?.minLength })
    }
  }
  return out
}

let app: Elysia
let orgId: string
let token: string

async function send(method: string, path: string, body: unknown, auth = true) {
  const res = await app.handle(new Request(`http://localhost${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(auth ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  }))
  return { status: res.status, json: (await res.json().catch(() => null)) as any }
}

beforeAll(async () => {
  await setupTestDB()
  app = new Elysia().onError(spaErrorHandler({}) as any).use(createApiApp())
  const org = await createTestOrg({ slug: 's09-org' } as any)
  orgId = String(org._id)
  const admin = await createTestUser(org._id as any, { role: 'admin', email: 'admin@s09.test' } as any)
  const signer = new Elysia().use(jwt({ name: 'jwt', secret: config.jwt.secret }))
  token = await (signer as any).decorator.jwt.sign({
    id: String(admin._id), orgId, role: 'admin', email: 'admin@s09.test', username: admin.username,
    firstName: 'S', lastName: 'Nine', permissions: DEFAULT_ROLE_PERMISSIONS.admin, ownRecordsModules: [],
  })
}, 120_000)

afterAll(async () => { await teardownTestDB() }, 60_000)

describe('S-09: every password a person sets has at least 12 characters', () => {
  it('every route field that sets a password asks for at least 12', () => {
    const fields = passwordFields()
    expect(fields.length).toBeGreaterThan(5)
    const short = fields.filter(f => !(f.key in VERIFIES) && !((f.min ?? 0) >= MIN)).map(f => `${f.key} (min ${f.min ?? 'none'})`)
    expect(short).toEqual([])
  })

  it('every field listed as proving a password is still a route', () => {
    const real = new Set(passwordFields().map(f => f.key))
    expect(Object.keys(VERIFIES).filter(k => !real.has(k))).toEqual([])
  })

  it('sign-up refuses 11 characters and takes 12', async () => {
    const person = (slug: string, password: string) => ({
      orgName: `S-09 ${slug}`, orgSlug: slug, email: `owner@${slug}.test`, username: 'owner', password, firstName: 'Own', lastName: 'Er',
    })
    const short = await send('POST', '/api/auth/register', person('s09-short', '12345678901'), false)
    expect(short.status).toBe(422)
    expect(short.json.message).toContain('password')
    expect((await send('POST', '/api/auth/register', person('s09-long', '123456789012'), false)).status).toBe(200)
  })

  it('an admin creating a user, and changing one, refuses 11 characters and takes 12', async () => {
    const user = (password: string) => ({ email: `new-${password.length}@s09.test`, username: `new-${password.length}`, password, firstName: 'New', lastName: 'Person', role: 'member' })
    const short = await send('POST', `/api/org/${orgId}/user/`, user('12345678901'))
    expect(short.status).toBe(422)
    expect(short.json.message).toContain('password')
    const created = await send('POST', `/api/org/${orgId}/user/`, user('123456789012'))
    expect(created.status).toBe(200)
    const id = created.json.user._id ?? created.json.user.id

    expect((await send('PUT', `/api/org/${orgId}/user/${id}`, { password: '12345678901' })).status).toBe(422)
    expect((await send('PUT', `/api/org/${orgId}/user/${id}`, { password: 'abcdefghijkl' })).status).toBe(200)
  })
})
