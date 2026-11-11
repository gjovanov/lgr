import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { Elysia } from 'elysia'
import jwt from '@elysiajs/jwt'
import { mongoose } from 'db/connection'
import { initServiceContext } from 'services/context'
import { Org, Role, User } from 'db/models'
import { tokenize } from 'services/biz/auth.service'
import { seedDefaultPermissionSets } from 'services/biz/permission-set.seed'
import { rolesFromSets } from 'migrations/migrations/0015-roles-from-sets'
import { createTestOrg, createTestUser } from '../helpers/factories'
import { startTwoPods, type TwoPods } from './harness'

/**
 * FR-27 acceptance 5 (#529): a role edit reaches a live session within 60 s on every pod, with no sign-out.
 *
 * Two pods of one global on one database. Every change is made through pod A, whose own caches forget at once
 * (`forgetRole`, `forgetMember`); pod B learns it when its entries lapse (`services/biz/access/live.ts`, 60 s).
 * The sessions are signed once and never again: the same token is refused what its role lost, and keeps what it
 * kept, with nobody signed out.
 *
 * - An edit of a role: its people lose the capability on pod A at once, and on pod B within the minute.
 * - A demoted Administrator: the admin-only routes (Roles & access) go on pod B within the minute.
 *
 * Runs with `LGR_TWO_NODE=1` (CI's "Two nodes" step). NOTE: no `.rejects` / `.resolves` (Known Issues).
 */

const enabled = process.env.LGR_TWO_NODE === '1'
/** `live.ts`'s TTL, plus the time a request and a poll take. */
const WITHIN_MS = 60_000 + 10_000

type Pod = 'a' | 'b'

describe.skipIf(!enabled)('FR-27.5 on two pods: a role edit reaches every pod within the minute', () => {
  let pods: TwoPods
  let orgId = ''
  const people: Record<string, any> = {}
  const tokens: Record<string, string> = {}
  let clerkRoleId = ''

  const call = async (pod: Pod, method: string, path: string, token: string, body?: unknown) => {
    const r = await fetch(`${pods[pod].url}/api/org/${orgId}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    })
    return { status: r.status, version: r.headers.get('x-access-version'), json: (await r.json().catch(() => null)) as any }
  }

  /** Ask pod B until it answers `want`; how long it took, or a failure naming the last answer. */
  async function untilAnswers(pod: Pod, path: string, token: string, want: number): Promise<number> {
    const start = Date.now()
    let last = 0
    while (Date.now() - start < WITHIN_MS) {
      last = (await call(pod, 'GET', path, token)).status
      if (last === want) return Date.now() - start
      await new Promise(res => setTimeout(res, 2_000))
    }
    throw new Error(`pod ${pod} still answers ${last} to GET ${path} after ${WITHIN_MS} ms (wanted ${want})`)
  }

  beforeAll(async () => {
    pods = await startTwoPods()
    await mongoose.connect(pods.mongoUri)
    // This process seeds and signs as the API does: the same repositories `setup.ts` gives the flow tests.
    const { createMongoRepositories } = await import('dal-mongo')
    initServiceContext(await createMongoRepositories({ backend: 'mongo' }))
    const org = await createTestOrg({ slug: 'roles-two-pods' } as any)
    orgId = String(org._id)
    await seedDefaultPermissionSets(orgId)
    for (const [key, role] of [['admin1', 'admin'], ['admin2', 'admin'], ['clerk', 'member']] as const) {
      people[key] = await createTestUser(org._id, { role, username: key, email: `${key}@roles-two-pods.test` } as any)
    }
    // Every person gets the role that is exactly their access (FR-27 §4), and the org moves to roles before
    // either pod has read it (`accessModelOf` caches a minute too).
    await rolesFromSets.up({ db: mongoose.connection.db as any, log: () => {}, orgFilter: {} })
    await Org.updateOne({ _id: org._id }, { $set: { 'settings.access.model': 'roles' } }).exec()
    const signer = new Elysia().use(jwt({ name: 'jwt', secret: pods.jwtSecret })) as any
    const sign = async (key: string) => { tokens[key] = await signer.decorator.jwt.sign(await tokenize((await User.findById(people[key]._id).exec())!)) }
    await sign('admin1')
    await sign('admin2')

    // The clerk's role: sales documents and payments, made and given through pod A.
    const made = await call('a', 'POST', '/roles', tokens.admin1, { name: 'Counter clerk', caps: ['sales-docs.view', 'payments.view'] })
    expect(made.status).toBe(200)
    clerkRoleId = String(made.json.role._id ?? made.json.role.id)
    expect((await call('a', 'PUT', `/user/${people.clerk._id}`, tokens.admin1, { roleId: clerkRoleId })).status).toBe(200)
    await sign('clerk')
  }, 180_000)

  afterAll(async () => {
    await mongoose.disconnect().catch(() => undefined)
    await pods?.stop()
  }, 60_000)

  it('both pods answer the clerk by the role, and say its version', async () => {
    for (const pod of ['a', 'b'] as const) {
      const r = await call(pod, 'GET', '/invoicing/payment-order', tokens.clerk)
      expect(r.status).toBe(200)
      expect(r.version).toBe(`${clerkRoleId}:1`)
      expect((await call(pod, 'GET', '/accounting/journal', tokens.clerk)).status).toBe(403)
    }
    // Pod B's caches now hold the role: what follows proves they lapse, not that they were empty.
    expect((await call('b', 'GET', '/roles', tokens.admin2)).status).toBe(200)
  })

  it('an edit of the role: pod A at once, pod B within the minute, and the token keeps what the role kept', async () => {
    const edited = await call('a', 'PUT', `/roles/${clerkRoleId}`, tokens.admin1, { caps: ['sales-docs.view'] })
    expect(edited.status).toBe(200)
    expect((await call('a', 'GET', '/invoicing/payment-order', tokens.clerk)).status).toBe(403)
    const kept = await call('a', 'GET', '/invoices', tokens.clerk)
    expect(kept.status).toBe(200)
    expect(kept.version).toBe(`${clerkRoleId}:2`)

    const took = await untilAnswers('b', '/invoicing/payment-order', tokens.clerk, 403)
    expect(took).toBeLessThan(WITHIN_MS)
    const onB = await call('b', 'GET', '/invoices', tokens.clerk)
    expect(onB.status).toBe(200)
    expect(onB.version).toBe(`${clerkRoleId}:2`)
    const stored = (await Role.findById(clerkRoleId).lean().exec()) as any
    // The role service stores what a capability implies (its lookups) beside it.
    expect(stored.caps).toContain('sales-docs.view')
    expect(stored.caps).not.toContain('payments.view')
  }, 120_000)

  it('a demoted Administrator loses Roles & access on pod B within the minute, signed in all along', async () => {
    expect((await call('a', 'PUT', `/user/${people.admin2._id}`, tokens.admin1, { roleId: clerkRoleId })).status).toBe(200)
    expect((await call('a', 'GET', '/roles', tokens.admin2)).status).toBe(403)

    const took = await untilAnswers('b', '/roles', tokens.admin2, 403)
    expect(took).toBeLessThan(WITHIN_MS)
    // Not signed out: the same token reads what the clerk's role reads.
    expect((await call('b', 'GET', '/invoices', tokens.admin2)).status).toBe(200)
    expect((await call('b', 'GET', '/roles', tokens.admin1)).status).toBe(200)
  }, 120_000)
})
