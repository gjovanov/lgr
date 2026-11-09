import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { Elysia } from 'elysia'
import jwt from '@elysiajs/jwt'
import type { Types } from 'mongoose'
import { setupTestDB, teardownTestDB } from '../setup'
import { createTestOrg, createTestUser } from '../helpers/factories'
import { createApiApp } from '../../../portal-api/src/api.js'
import { spaErrorHandler } from '../../../portal-api/src/spa-fallback.js'
import { config } from 'config'
import { DEFAULT_ROLE_PERMISSIONS } from 'config/constants'
import { mongoose } from 'db/connection'
import { Identity } from 'db/models'

/**
 * S-14 — does any route hand out a secret?
 *
 * The review asked for `select: false` on `User.password`, so that "the next handler that forgets
 * a projection" cannot leak the hash. It is not applied there (see `services/dao/user.dao.ts`:
 * backups, org moves and FR-20's replication read `User` through Mongoose and need the hash), so
 * the property is measured instead, over the real route table, the way `anonymous-access` and
 * `tenant-isolation` measure theirs. A controller mounted next year is covered the day it appears.
 *
 * Every model whose schema has a secret-looking field (a password, a verifier, a token or the
 * hash of one) gets a document carrying a marker in that field: the org's own row and the signed-in
 * admin's user row too, and one probe document per collection under an id every by-id route is
 * then asked for. Every route is called as that org's admin, and no answer may carry a marker or
 * anything shaped like a password hash.
 *
 * Found by this file on 2026-11-09: the three `/org/:orgId/user` routes answered with each OAuth
 * link's `accessToken` and `refreshToken`. Latent: nothing stores those tokens (the sign-in keeps
 * the provider and its id) and production had none. They are projected out now.
 *
 * NOTE: no `.rejects` / `.resolves` (Bun-on-Windows deadlock, see Known Issues).
 */

const MARK = `s14secret${Date.now().toString(36)}`
/** Field names that hold a credential, a hash of one, or a token. */
const SECRET_NAME = /^(password|verifier|tokenHash|codeHash|keyHash|refreshToken|accessToken|token|secret|clientSecret|apiKey|privateKey|pin|pinHash|activationToken|resetToken)$/i
/** A password hash as `Bun.password` and bcrypt write it, whatever marker it was not seeded with. */
const HASH = /\$(argon2(id|i|d)|2[aby])\$/

let app: Elysia
let orgId: string
let orgOid: Types.ObjectId
let token: string
let probeId: Types.ObjectId
let seeded: string[] = []

/** Every secret-looking path of a schema, nested ones included (`oauthProviders.refreshToken`). */
function secretPaths(schema: any, prefix = ''): string[] {
  const out: string[] = []
  schema.eachPath((path: string, type: any) => {
    if (type?.schema) out.push(...secretPaths(type.schema, `${prefix}${path}.`))
    else if (SECRET_NAME.test(path.split('.').pop()!)) out.push(prefix + path)
  })
  return out
}

/** The marker one model's one path carries, so a leak names its field. */
const markOf = (model: string, path: string) => `${MARK}-${model}-${path}`

/**
 * A probe document with each secret path filled: nested objects for a nested path, and a one-element
 * array where the path runs through a document array (`oauthProviders.refreshToken`).
 */
function probeDoc(model: string, paths: string[], base: Record<string, unknown>) {
  const schema = mongoose.model(model).schema
  const doc: Record<string, any> = { ...base }
  for (const p of paths) {
    const parts = p.split('.')
    let at: any = doc
    for (let i = 0; i < parts.length - 1; i++) {
      const sub = schema.path(parts.slice(0, i + 1).join('.')) as any
      if (sub?.$isMongooseDocumentArray) {
        at[parts[i]] = at[parts[i]] ?? [{ provider: 'google', providerId: 'probe' }]
        at = at[parts[i]][0]
      } else {
        at[parts[i]] = at[parts[i]] ?? {}
        at = at[parts[i]]
      }
    }
    at[parts[parts.length - 1]] = markOf(model, p)
  }
  return doc
}

async function call(method: string, path: string, body?: unknown): Promise<{ status: number; text: string }> {
  const req = app.handle(new Request(`http://localhost${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: method === 'GET' || method === 'HEAD' || method === 'DELETE' ? undefined : JSON.stringify(body ?? {}),
  }))
  const timeout = new Promise<Response>(r => setTimeout(() => r(new Response('timeout', { status: 599 })), 15_000))
  const res = await Promise.race([req, timeout])
  return { status: res.status, text: await res.text().catch(() => '') }
}

/** What an answer gives away: the marker of a seeded field, or a password hash. */
function secretsIn(text: string): string[] {
  const out: string[] = []
  const marks = text.match(new RegExp(`${MARK}-[A-Za-z]+-[A-Za-z.]+`, 'g'))
  if (marks) out.push(...new Set(marks.map(m => m.slice(MARK.length + 1))))
  if (HASH.test(text)) out.push('a password hash')
  return out
}

beforeAll(async () => {
  await setupTestDB()
  app = new Elysia().onError(spaErrorHandler({}) as any).use(createApiApp())
  const org = await createTestOrg({ slug: 's14-probe' } as any)
  orgOid = org._id as Types.ObjectId
  orgId = String(orgOid)
  probeId = new mongoose.Types.ObjectId()
  const db = mongoose.connection.db!

  // The org itself, with every token slot its schema has.
  const orgSecrets: Record<string, string> = {}
  for (const p of secretPaths(mongoose.model('Org').schema)) orgSecrets[p] = markOf('Org', p)
  await db.collection('orgs').updateOne({ _id: orgOid }, { $set: orgSecrets })

  // The signed-in admin is a linked person, as every account on production is, with a provider link
  // carrying both tokens.
  const identity = await Identity.create({
    email: 'admin@s14.test', firstName: 'S', lastName: 'Fourteen', password: await Bun.password.hash('test123'),
    passwordSetBy: 'self', tokenVersion: 0, isActive: true,
  } as any)
  const admin = await createTestUser(orgOid, {
    role: 'admin', email: 'admin@s14.test', identityId: identity._id,
    oauthProviders: [{ provider: 'google', providerId: 'g-1', accessToken: markOf('User', 'oauthProviders.accessToken'), refreshToken: markOf('User', 'oauthProviders.refreshToken') }],
  } as any)
  await createTestUser(orgOid, { role: 'member', email: 'member@s14.test' } as any)

  const signer = new Elysia().use(jwt({ name: 'jwt', secret: config.jwt.secret }))
  token = await (signer as any).decorator.jwt.sign({
    id: String(admin._id), orgId, role: 'admin', email: 'admin@s14.test', username: admin.username,
    firstName: 'S', lastName: 'Fourteen', permissions: DEFAULT_ROLE_PERMISSIONS.admin, ownRecordsModules: [],
    iid: String(identity._id), tv: 0,
  })

  // One probe document per collection whose model has a secret, under the id the by-id routes get.
  for (const name of mongoose.modelNames()) await mongoose.model(name).createCollection().catch(() => {})
  for (const name of mongoose.modelNames()) {
    const paths = secretPaths(mongoose.model(name).schema)
    if (!paths.length) continue
    const doc = probeDoc(name, paths, {
      _id: probeId, orgId: orgOid, isActive: true, name: 'probe', email: `probe-${name.toLowerCase()}@s14.test`, username: `probe-${name.toLowerCase()}`,
    })
    await mongoose.model(name).collection.insertOne(doc)
    seeded.push(...paths.map(p => `${name}.${p}`))
  }
}, 120_000)

afterAll(async () => { await teardownTestDB() }, 60_000)

describe('S-14: no route hands out a secret', () => {
  it('has secrets to look for: the password, the provider tokens, the credential and code hashes', () => {
    for (const p of ['User.password', 'User.oauthProviders.refreshToken', 'Identity.password', 'LocalCredential.verifier', 'AuthToken.tokenHash', 'Code.token', 'Org.settings.integrations.googleDrive.refreshToken']) {
      expect(seeded).toContain(p)
    }
  })

  it('no route answers with a seeded secret or a password hash', async () => {
    const routes = ((createApiApp() as any).routes as Array<{ method: string; path: string }>)
      .filter(r => ['GET', 'POST', 'PUT', 'PATCH'].includes(r.method))
    expect(routes.length).toBeGreaterThan(300)
    const leaks: string[] = []
    for (const r of routes) {
      const url = r.path.replace(/:orgId/g, orgId).replace(/:\w+/g, String(probeId))
      const res = await call(r.method, url)
      const found = secretsIn(res.text)
      if (found.length) leaks.push(`${r.method} ${r.path} -> ${res.status}: ${found.join(', ')}`)
    }
    expect(leaks).toEqual([])
  }, 900_000)

  it('positive control: the user routes do answer with the users, and their links, without the tokens', async () => {
    const list = await call('GET', `/api/org/${orgId}/user/`)
    expect(list.status).toBe(200)
    const admin = JSON.parse(list.text).users.find((u: any) => u.email === 'admin@s14.test')
    expect(admin.oauthProviders).toEqual([expect.objectContaining({ provider: 'google', providerId: 'g-1' })])
    expect(admin.oauthProviders[0].refreshToken).toBeUndefined()
    expect(admin.password).toBeUndefined()

    const one = await call('GET', `/api/org/${orgId}/user/${admin._id}`)
    expect(one.status).toBe(200)
    expect(JSON.parse(one.text).user.oauthProviders[0]).toEqual(expect.objectContaining({ provider: 'google' }))
    expect(secretsIn(one.text)).toEqual([])
  })

  it('creating a user answers without the hash the admin just set', async () => {
    const res = await call('POST', `/api/org/${orgId}/user/`, {
      email: 'new@s14.test', username: 'new-s14', password: 'a-long-enough-password', firstName: 'New', lastName: 'Person', role: 'member',
    })
    expect(res.status).toBe(200)
    expect(JSON.parse(res.text).user.email).toBe('new@s14.test')
    expect(secretsIn(res.text)).toEqual([])
  })
})
