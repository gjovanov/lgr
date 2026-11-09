import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { Elysia } from 'elysia'
import { setupTestDB, teardownTestDB } from '../setup'
import { createTestOrg, createTestUser } from '../helpers/factories'
import { createApiApp } from '../../../portal-api/src/api.js'
import { Identity, Org, User } from 'db/models'
import type { Types } from 'mongoose'

/**
 * The PROD / DEV badge: `Org.settings.environment`, read by the org menu.
 *
 * What the UI needs from the server is small and exact. Every way of entering an org names the
 * marker beside the name (so the top bar can badge the selected org before `/auth/me` answers),
 * the org list carries it for every row, an org with no marker says nothing (no key at all: the
 * menu shows no badge), and an org admin cannot write it: the marker is what keeps a mislabelled
 * production org out of a clone's reach, so it is not theirs to set.
 */

let app: Elysia
const PW = crypto.randomUUID()
let seq = 0

beforeAll(async () => {
  await setupTestDB()
  await Identity.init()
  await User.init()
  app = new Elysia().use(createApiApp())
}, 120_000)

afterAll(async () => {
  await teardownTestDB()
}, 60_000)

async function call(method: string, path: string, opts: { token?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (opts.token) headers.authorization = `Bearer ${opts.token}`
  const res = await app.handle(
    new Request(`http://localhost/api${path}`, {
      method,
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    }),
  )
  return { status: res.status, body: (await res.json().catch(() => null)) as any }
}

async function org(prefix: string, environment?: 'prod' | 'dev') {
  const o = await createTestOrg({ slug: `${prefix}-${Date.now()}-${++seq}`, name: `${prefix} ${seq}` } as any)
  if (environment) await Org.updateOne({ _id: o._id }, { $set: { 'settings.environment': environment } })
  return { id: String(o._id), slug: o.slug as string, _id: o._id as Types.ObjectId }
}

/** One person with an admin membership in each org, one username. */
async function personIn(orgs: { _id: Types.ObjectId }[]) {
  const email = `env-${Date.now()}-${++seq}@x.test`
  const identity = await Identity.create({
    email,
    firstName: 'En',
    lastName: 'Vironment',
    password: await Bun.password.hash(PW),
    passwordSetBy: 'self',
  })
  for (const o of orgs) {
    await createTestUser(o._id, { email, username: email.split('@')[0], identityId: identity._id } as any)
  }
  return { username: email.split('@')[0] }
}

describe('the org marker in every answer the org menu reads', () => {
  it('names it on a sign-in, the org list, a switch and /auth/me, and omits it where there is none', async () => {
    const prod = await org('envprod', 'prod')
    const dev = await org('envdev', 'dev')
    const plain = await org('envplain')
    const { username } = await personIn([prod, dev, plain])

    // The legacy org path lands in one named org: its answer carries that org's marker.
    const signIn = await call('POST', '/auth/login', { body: { username, password: PW, orgSlug: prod.slug } })
    expect(signIn.status).toBe(200)
    expect(signIn.body.org).toMatchObject({ id: prod.id, slug: prod.slug, environment: 'prod' })

    // The list the menu fills from: a marker on the marked rows, no key at all on the plain one.
    const list = await call('GET', '/auth/orgs', { token: signIn.body.token })
    expect(list.status).toBe(200)
    const by = Object.fromEntries(list.body.orgs.map((o: any) => [o.slug, o]))
    expect(by[prod.slug].environment).toBe('prod')
    expect(by[dev.slug].environment).toBe('dev')
    expect('environment' in by[plain.slug]).toBe(false)

    // Switching into the test copy answers with ITS marker, not the one the tab came from.
    const switched = await call('POST', '/auth/switch', { token: signIn.body.token, body: { orgId: dev.id } })
    expect(switched.status).toBe(200)
    expect(switched.body.org).toMatchObject({ id: dev.id, environment: 'dev' })

    // /auth/me: flat for the top bar, and inside settings for whoever reads the whole record.
    const me = await call('GET', '/auth/me', { token: switched.body.token })
    expect(me.status).toBe(200)
    expect(me.body.org.environment).toBe('dev')
    expect(me.body.org.settings.environment).toBe('dev')

    // An org with no marker says nothing.
    const plainSession = await call('POST', '/auth/switch', { token: signIn.body.token, body: { orgId: plain.id } })
    expect('environment' in plainSession.body.org).toBe(false)
  })

  it('is not an org admin\'s to set: the settings update ignores it, or refuses it', async () => {
    const plain = await org('envadmin')
    const { username } = await personIn([plain])
    const signIn = await call('POST', '/auth/login', { body: { username, password: PW, orgSlug: plain.slug } })
    expect(signIn.status).toBe(200)

    // Alongside a real setting, so the update itself is valid and only the marker is in question.
    const res = await call('PUT', `/org/${plain.id}`, {
      token: signIn.body.token,
      body: { settings: { timezone: 'Europe/Sofia', environment: 'prod' } },
    })
    expect([200, 400, 422]).toContain(res.status)

    const stored: any = await Org.findById(plain._id).lean().exec()
    expect(stored.settings.environment).toBeUndefined()
    if (res.status === 200) expect(stored.settings.timezone).toBe('Europe/Sofia')
  })

  it('only takes the two values the badge knows', async () => {
    const o = await org('envenum')
    const bad = Org.updateOne({ _id: o._id }, { $set: { 'settings.environment': 'staging' } }, { runValidators: true }).exec()
    let failed = false
    try { await bad } catch { failed = true }
    expect(failed).toBe(true)
  })
})
