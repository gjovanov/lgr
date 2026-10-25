import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { Elysia } from 'elysia'
import jwt from '@elysiajs/jwt'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { createTestOrg, createTestUser } from '../helpers/factories'
import { digestController } from '../../../portal-api/src/controllers/digest.controller'
import { DigestRun } from 'db/models'
import { config } from 'config'
import { DEFAULT_ROLE_PERMISSIONS } from 'config/constants'
import type { Types } from 'mongoose'

/**
 * FR-11.15 (#21) — the digest's three operator routes, over real HTTP (gjovanov/lgr#31 P2).
 *
 * The digest SERVICE is thoroughly covered by `daily-digest.flow.test.ts` — content, claiming,
 * rendering, recipients. The three routes that expose it to a human had no test at any level,
 * which is how `GET /last-run` shipped with no role check and `GET /preview` with a role check
 * but no org check.
 *
 * Same shape as `backup-routes.flow.test.ts`: `Elysia.handle(new Request(...))` with a
 * genuinely signed JWT, because the thing under test IS the guard.
 *
 * ⚠ Email is unconfigured under `.env.test` and must stay that way. That is not a limitation
 * here — `POST /test` answering 503 rather than pretending to have sent is FR-10 doctrine and
 * one of the behaviours worth pinning.
 *
 * NOTE: no `.rejects` / `.resolves` — the Bun-on-Windows deadlock in the Known Issues table.
 */

let app: Elysia

beforeAll(async () => {
  await setupTestDB()
  app = new Elysia().use(digestController)
}, 60_000)

afterAll(async () => {
  await teardownTestDB()
}, 60_000)

afterEach(async () => {
  await clearCollections()
}, 30_000)

const signer = new Elysia().use(jwt({ name: 'jwt', secret: config.jwt.secret }))
async function tokenFor(u: { id: string; orgId: string; role: string; email?: string }) {
  const ctx: any = (signer as any).decorator
  return ctx.jwt.sign({
    id: u.id,
    orgId: u.orgId,
    role: u.role,
    email: u.email,
    username: 'digest-user',
    firstName: 'Di',
    lastName: 'Gest',
    permissions: DEFAULT_ROLE_PERMISSIONS[u.role as keyof typeof DEFAULT_ROLE_PERMISSIONS] || [],
    ownRecordsModules: [],
  })
}

async function call(
  path: string,
  opts: { method?: string; token?: string; body?: any } = {},
): Promise<{ status: number; json: any }> {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (opts.token) headers.authorization = `Bearer ${opts.token}`
  const res = await app.handle(
    new Request(`http://localhost${path}`, {
      method: opts.method || 'GET',
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    }),
  )
  let json: any = null
  try {
    json = await res.clone().json()
  } catch {
    /* empty bodies */
  }
  return { status: res.status, json }
}

async function orgWith(role: string, opts: { email?: string | null; slug?: string } = {}) {
  const slug = opts.slug || `digest-${role}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
  const org = await createTestOrg({ slug, settings: { timezone: 'Europe/Sofia', locale: 'bg' } } as any)
  const orgId = String(org._id as Types.ObjectId)
  const email = opts.email === null ? undefined : opts.email || `${role}@${slug}.test`
  const user = await createTestUser(org._id as Types.ObjectId, {
    role,
    ...(email ? { email } : {}),
  } as any)
  return { orgId, userId: String(user._id), token: await tokenFor({ id: String(user._id), orgId, role, email }) }
}

// ── Authentication ────────────────────────────────────────────────────────────────────────

describe('authentication', () => {
  it('rejects an anonymous caller on every route', async () => {
    const { orgId } = await orgWith('admin')

    const preview = await call(`/org/${orgId}/digest/preview`)
    const lastRun = await call(`/org/${orgId}/digest/last-run`)
    const test = await call(`/org/${orgId}/digest/test`, { method: 'POST', body: {} })

    expect(preview.status).toBe(401)
    expect(lastRun.status).toBe(401)
    expect(test.status).toBe(401)
  })
})

// ── Roles ─────────────────────────────────────────────────────────────────────────────────

describe('who may operate the digest', () => {
  it('lets an admin preview it', async () => {
    const { orgId, token } = await orgWith('admin')

    const res = await call(`/org/${orgId}/digest/preview`, { token })

    expect(res.status).toBe(200)
    expect(res.json.html).toContain('<')
    expect(res.json.subject).toBeTruthy()
    expect(res.json.date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('refuses a non-admin the preview and the test send', async () => {
    const { orgId, token } = await orgWith('accountant')

    const preview = await call(`/org/${orgId}/digest/preview`, { token })
    const test = await call(`/org/${orgId}/digest/test`, { method: 'POST', token, body: {} })

    // A mail button and a report of every counterparty and price are settings-grade, not
    // report-grade — `admin.settings` deliberately does not substitute for the role here.
    expect(preview.status).toBe(403)
    expect(test.status).toBe(403)
  })

  it('refuses `last-run` to a non-admin, like its two siblings', async () => {
    const { orgId, token } = await orgWith('sales')

    const res = await call(`/org/${orgId}/digest/last-run`, { token })

    // The row carries recipient addresses and an error string. This pinned a 200 until S-29
    // (gjovanov/lgr#31).
    expect(res.status).toBe(403)

    const admin = await orgWith('admin')
    expect((await call(`/org/${admin.orgId}/digest/last-run`, { token: admin.token })).status).toBe(200)
  })
})

// ── The report date ───────────────────────────────────────────────────────────────────────

describe('the day a preview reports on', () => {
  it('defaults to yesterday in the ORG\'s zone, not the server\'s', async () => {
    const org = await createTestOrg({
      // +13 from UTC: for part of every UTC day this org's "yesterday" is a different date
      // than the server's, which is the whole reason `reportDateFor` exists.
      slug: `digest-tz-${Date.now()}`,
      settings: { timezone: 'Pacific/Auckland' },
    } as any)
    const orgId = String(org._id as Types.ObjectId)
    const user = await createTestUser(org._id as Types.ObjectId, { role: 'admin' } as any)
    const token = await tokenFor({ id: String(user._id), orgId, role: 'admin', email: 'tz@digest.test' })

    const res = await call(`/org/${orgId}/digest/preview`, { token })

    expect(res.status).toBe(200)
    const auckland = new Date().toLocaleDateString('en-CA', { timeZone: 'Pacific/Auckland' })
    const expected = new Date(`${auckland}T00:00:00Z`)
    expected.setUTCDate(expected.getUTCDate() - 1)
    expect(res.json.date).toBe(expected.toISOString().slice(0, 10))
  })

  it('honours an explicit `date`', async () => {
    const { orgId, token } = await orgWith('admin')

    const res = await call(`/org/${orgId}/digest/preview?date=2026-03-04`, { token })

    expect(res.status).toBe(200)
    expect(res.json.date).toBe('2026-03-04')
  })
})

// ── The test send ─────────────────────────────────────────────────────────────────────────

describe('POST /test', () => {
  it('refuses an admin with no email address', async () => {
    const { orgId, token } = await orgWith('admin', { email: null })

    const res = await call(`/org/${orgId}/digest/test`, { method: 'POST', token, body: {} })

    expect(res.status).toBe(422)
  })

  it('answers 503 when email is unconfigured — never a fake success', async () => {
    const { orgId, token } = await orgWith('admin')

    const res = await call(`/org/${orgId}/digest/test`, { method: 'POST', token, body: {} })

    // FR-10 doctrine: an unconfigured provider is an ops problem the operator must see. A 200
    // here would tell an admin their digest works on a server that cannot send mail at all.
    expect(res.status).toBe(503)
  })

  it('claims no day — a test send must never consume the scheduler\'s slot', async () => {
    const { orgId, token } = await orgWith('admin')

    await call(`/org/${orgId}/digest/test`, { method: 'POST', token, body: { date: '2026-03-04' } })

    // The unique {orgId, date} index on DigestRun IS the scheduler's lock. If a test send wrote
    // a row, pressing the button would silently cancel that morning's real digest.
    expect(await DigestRun.countDocuments({ orgId })).toBe(0)
  })
})

// ── last-run ──────────────────────────────────────────────────────────────────────────────

describe('GET /last-run', () => {
  it('returns null before anything has run, rather than 404', async () => {
    const { orgId, token } = await orgWith('admin')

    const res = await call(`/org/${orgId}/digest/last-run`, { token })

    // The settings card's status line reads this on every load; "never run" is a normal state.
    expect(res.status).toBe(200)
    expect(res.json.run).toBeNull()
  })

  it('returns the most recent run, not the first', async () => {
    const { orgId, token } = await orgWith('admin')
    await DigestRun.create({
      orgId, date: '2026-03-03', status: 'sent', startedAt: new Date('2026-03-03T05:00:00Z'),
      completedAt: new Date('2026-03-03T05:00:10Z'), recipients: [],
    } as any)
    await DigestRun.create({
      orgId, date: '2026-03-04', status: 'failed', startedAt: new Date('2026-03-04T05:00:00Z'),
      completedAt: new Date('2026-03-04T05:00:10Z'), recipients: [],
    } as any)

    const res = await call(`/org/${orgId}/digest/last-run`, { token })

    expect(res.json.run.date).toBe('2026-03-04')
    expect(res.json.run.status).toBe('failed')
  })
})
