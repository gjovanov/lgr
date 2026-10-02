import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { Elysia } from 'elysia'
import jwt from '@elysiajs/jwt'
import { setupTestDB, teardownTestDB } from '../setup'
import { createTestOrg, createTestUser } from '../helpers/factories'
import { createApiApp } from '../../../portal-api/src/api.js'
import { config } from 'config'
import { DEFAULT_ROLE_PERMISSIONS } from 'config/constants'
import { User } from 'db/models'
import type { Types } from 'mongoose'

/**
 * S-21 — an org admin could read, rewrite and deactivate ANY organisation's users.
 *
 * `GET/PUT/DELETE /org/:orgId/user/:userId` looked the user up by `_id` alone
 * (`userDao.findByIdSafe`, `User.findById`, `userDao.update` → `findByIdAndUpdate`). The tenant
 * guard (#41) only proves the caller belongs to the `:orgId` in the URL — and here that is the
 * caller's OWN org — so `/org/<mine>/user/<yours>` sailed through it to another org's user.
 *
 * Anyone can register an org and is its admin, so the whole attack was:
 *
 *     PUT /api/org/<my org>/user/<victim id>   {password, role}
 *     → sign in to the victim's org as the victim
 *
 * The probe in `tenant-isolation.flow.test.ts` could not see it: it walks routes whose ONLY
 * parameter is `:orgId`, and its header says why `/:id` routes need a seeded record in the other
 * org to probe honestly. This file is that seeded probe, for the one surface that holds
 * credentials.
 */

let app: Elysia
let orgA: { _id: Types.ObjectId; orgId: string }
let adminOfA: string
let colleagueInA: string
let victimInB: string

const VICTIM_EMAIL = 'victim@idor-b.test'

const signer = new Elysia().use(jwt({ name: 'jwt', secret: config.jwt.secret }))
async function tokenFor(u: { id: string; orgId: string; role: string; email: string }) {
  const ctx: any = (signer as any).decorator
  return ctx.jwt.sign({
    ...u,
    username: 'idor-probe',
    firstName: 'Idor',
    lastName: 'Probe',
    permissions: DEFAULT_ROLE_PERMISSIONS[u.role as keyof typeof DEFAULT_ROLE_PERMISSIONS] || [],
    ownRecordsModules: [],
  })
}

async function call(method: string, path: string, token: string, body?: unknown) {
  const res = await app.handle(
    new Request(`http://localhost${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    }),
  )
  return { status: res.status, body: await res.json().catch(() => null) as any }
}

beforeAll(async () => {
  await setupTestDB()
  app = new Elysia().use(createApiApp())

  const a = await createTestOrg({ slug: 'idor-a' } as any)
  orgA = { _id: a._id as Types.ObjectId, orgId: String(a._id) }
  const admin = await createTestUser(orgA._id, { role: 'admin', email: 'admin@idor-a.test' } as any)
  adminOfA = await tokenFor({ id: String(admin._id), orgId: orgA.orgId, role: 'admin', email: 'admin@idor-a.test' })
  const colleague = await createTestUser(orgA._id, { role: 'member', email: 'colleague@idor-a.test' } as any)
  colleagueInA = String(colleague._id)

  const b = await createTestOrg({ slug: 'idor-b' } as any)
  const victim = await createTestUser(b._id as Types.ObjectId, {
    role: 'member',
    email: VICTIM_EMAIL,
    firstName: 'Victim',
    lastName: 'OfB',
  } as any)
  victimInB = String(victim._id)
}, 120_000)

afterAll(async () => {
  await teardownTestDB()
}, 60_000)

describe('S-21: /org/:orgId/user/:userId stays inside :orgId', () => {
  it('GET does not hand another org\'s user to this org\'s admin', async () => {
    const res = await call('GET', `/api/org/${orgA.orgId}/user/${victimInB}`, adminOfA)

    expect(res.status).toBe(404)
    expect(JSON.stringify(res.body ?? {})).not.toContain(VICTIM_EMAIL)
  })

  it('PUT cannot rewrite another org\'s user — not the password, the role, nor the email', async () => {
    const before = await User.findById(victimInB).lean().exec()

    const res = await call('PUT', `/api/org/${orgA.orgId}/user/${victimInB}`, adminOfA, {
      password: 'taken-over-by-a',
      role: 'admin',
      email: 'attacker@idor-a.test',
    })

    expect(res.status).toBe(404)
    const after = await User.findById(victimInB).lean().exec()
    expect(after!.password).toBe(before!.password!)
    expect(after!.role).toBe('member')
    expect(after!.email).toBe(VICTIM_EMAIL)
    // The victim's own password still works; the attacker's never does.
    expect(await Bun.password.verify('test123', after!.password!)).toBe(true)
    expect(await Bun.password.verify('taken-over-by-a', after!.password!)).toBe(false)
  })

  it('DELETE cannot deactivate another org\'s user', async () => {
    const res = await call('DELETE', `/api/org/${orgA.orgId}/user/${victimInB}`, adminOfA)

    expect(res.status).toBe(404)
    const after = await User.findById(victimInB).lean().exec()
    expect(after!.isActive).toBe(true)
    expect(after!.deactivatedAt).toBeUndefined()
  })

  it('a malformed id is a 404, not a 500', async () => {
    const res = await call('GET', `/api/org/${orgA.orgId}/user/not-an-object-id`, adminOfA)
    expect(res.status).toBe(404)
  })

  // The control. Without it, every 404 above could be the routes being broken for everyone.
  it('the same admin still manages their own org\'s users', async () => {
    const got = await call('GET', `/api/org/${orgA.orgId}/user/${colleagueInA}`, adminOfA)
    expect(got.status).toBe(200)
    expect(got.body.user.email).toBe('colleague@idor-a.test')
    expect(got.body.user.password).toBeUndefined()

    const put = await call('PUT', `/api/org/${orgA.orgId}/user/${colleagueInA}`, adminOfA, { position: 'Cashier' })
    expect(put.status).toBe(200)
    expect(put.body.user.position).toBe('Cashier')
    // The hash never travels back, not even to an admin of the user's own org (S-14's spirit:
    // the list endpoint already strips it, FR-11.3).
    expect(put.body.user.password).toBeUndefined()

    const del = await call('DELETE', `/api/org/${orgA.orgId}/user/${colleagueInA}`, adminOfA)
    expect(del.status).toBe(200)
    const after = await User.findById(colleagueInA).lean().exec()
    expect(after!.isActive).toBe(false)
  })
})
