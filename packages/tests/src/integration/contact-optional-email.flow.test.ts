import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { Elysia } from 'elysia'
import jwt from '@elysiajs/jwt'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { createTestOrg, createTestUser } from '../helpers/factories'
import { contactController } from 'invoicing-api/src/controllers/contact.controller'
import { spaErrorHandler } from '../../../portal-api/src/spa-fallback.js'
import { Contact } from 'db/models'
import { config } from 'config'
import { DEFAULT_ROLE_PERMISSIONS } from 'config/constants'

/**
 * A contact's email is optional — and an empty box is how the form says "none".
 *
 * Found in production: saving a new contact with the email left empty answered 422, because the
 * API checked `format: 'email'` against `''`. Under NODE_ENV=production Elysia's message for it is
 * the whole request echoed back with no field named, which reached users as a wall of JSON, so
 * they concluded the email was required. Mounted the way `unified.ts` mounts it: the app's
 * `onError` first, then the controller.
 *
 * NOTE: no `.rejects` / `.resolves` — the Bun-on-Windows deadlock in the Known Issues table.
 */

let app: Elysia

beforeAll(async () => {
  await setupTestDB()
  app = new Elysia().onError(spaErrorHandler({}) as any).use(contactController)
}, 60_000)

afterAll(async () => {
  await teardownTestDB()
}, 60_000)

afterEach(async () => {
  await clearCollections()
}, 30_000)

const signer = new Elysia().use(jwt({ name: 'jwt', secret: config.jwt.secret }))
async function tokenFor(u: { id: string; orgId: string }) {
  return (signer as any).decorator.jwt.sign({
    id: u.id, orgId: u.orgId, role: 'admin', email: 'admin@test.com', username: 'admin',
    firstName: 'Test', lastName: 'Admin',
    permissions: DEFAULT_ROLE_PERMISSIONS.admin, ownRecordsModules: [],
  })
}

async function send(method: 'POST' | 'PUT', path: string, token: string, body: any) {
  const res = await app.handle(new Request(`http://localhost${path}`, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  }))
  return { status: res.status, json: await res.json().catch(() => null) as any }
}

async function world() {
  const org = await createTestOrg()
  const user = await createTestUser(org._id)
  const token = await tokenFor({ id: String(user._id), orgId: String(org._id) })
  return { orgId: String(org._id), token }
}

describe('contact email is optional', () => {
  it('creates a contact sent without any email', async () => {
    const { orgId, token } = await world()
    const res = await send('POST', `/org/${orgId}/invoicing/contact`, token, { type: 'customer', companyName: 'Без имейл ООД' })
    expect(res.status).toBe(200)
    const stored = await Contact.findById(res.json.contact.id).lean()
    expect(stored?.companyName).toBe('Без имейл ООД')
    expect(stored?.email).toBeUndefined()
  })

  it('creates a contact sent with an empty email, and stores none rather than ""', async () => {
    const { orgId, token } = await world()
    const res = await send('POST', `/org/${orgId}/invoicing/contact`, token, { type: 'supplier', companyName: 'Празен имейл ЕООД', email: '' })
    expect(res.status).toBe(200)
    const stored = await Contact.findById(res.json.contact.id).lean()
    expect(stored?.email).toBeUndefined()
  })

  it('still stores a real email', async () => {
    const { orgId, token } = await world()
    const res = await send('POST', `/org/${orgId}/invoicing/contact`, token, { type: 'customer', companyName: 'С имейл АД', email: 'office@example.bg' })
    expect(res.status).toBe(200)
    expect(res.json.contact.email).toBe('office@example.bg')
  })

  it('clears an email when an edit sends it empty', async () => {
    const { orgId, token } = await world()
    const created = await send('POST', `/org/${orgId}/invoicing/contact`, token, { type: 'customer', companyName: 'Смяна', email: 'old@example.bg' })
    const res = await send('PUT', `/org/${orgId}/invoicing/contact/${created.json.contact.id}`, token, { email: '' })
    expect(res.status).toBe(200)
    expect(res.json.contact.email).toBe('')
  })
})

describe('a rejected field is named in plain words', () => {
  it('says which field is wrong instead of echoing the request', async () => {
    const { orgId, token } = await world()
    const res = await send('POST', `/org/${orgId}/invoicing/contact`, token, { type: 'customer', companyName: 'Грешен имейл', email: 'office' })
    expect(res.status).toBe(422)
    // Plain words about email — not TypeBox's "Expected union value" for the ''-or-email schema.
    expect(res.json.message).toBe('Invalid field "email": Expected a valid email address (or leave it empty)')
    // Never the raw validator payload: no JSON, no echo of the submitted values.
    expect(res.json.message).not.toContain('{')
    expect(res.json.message).not.toContain('Грешен имейл')
  })

  it('names a nested path the way a person reads it', async () => {
    const { orgId, token } = await world()
    const res = await send('POST', `/org/${orgId}/invoicing/contact`, token, {
      type: 'customer',
      companyName: 'Банка',
      bankDetails: [{ bankName: 'ОББ', currency: 'EUR' }],
    })
    expect(res.status).toBe(422)
    expect(res.json.message).toStartWith('Invalid field "bankDetails.0.accountNumber":')
  })
})
