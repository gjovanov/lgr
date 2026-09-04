import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Elysia } from 'elysia'
import jwt from '@elysiajs/jwt'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { createTestOrg, createTestUser } from '../helpers/factories'
import { config } from 'config'
import { BackupRun } from 'db/models'
import { backupController } from '../../../portal-api/src/controllers/backup.controller'
import { runBackupForOrg } from 'services/biz/backup/backup-runner.service'
import type { Types } from 'mongoose'

/**
 * FR-13.15 / FR-13.24 (#24) — the backup routes, driven over real HTTP.
 *
 * ⚠ There was NO controller-level test for backups before this file. The 401/403 guards, the
 * 410-after-prune path and the `date` handling were all unexercised — which is how a
 * cross-tenant export and a path traversal both shipped through a green suite. The service
 * layer being well tested is not the same as the surface being safe.
 *
 * These drive `Elysia.handle(new Request(...))` with a genuinely signed JWT rather than a
 * stubbed user, because the thing under test IS the auth path.
 *
 * NOTE: no `.rejects` / `.resolves` (Bun-on-Windows deadlock) — nothing here rejects anyway.
 */

let TMP = ''
let app: Elysia

beforeAll(async () => {
  await setupTestDB()
  TMP = mkdtempSync(join(tmpdir(), 'lgr-backup-routes-'))
  config.upload.dir = TMP
  app = new Elysia().use(backupController)
}, 60_000)

afterAll(async () => {
  await teardownTestDB()
  rmSync(TMP, { recursive: true, force: true })
}, 60_000)

afterEach(async () => { await clearCollections() }, 30_000)

const DAY = '2026-09-03'

/** A token the real `AuthService` will accept, signed with the same secret it verifies with. */
const signer = new Elysia().use(jwt({ name: 'jwt', secret: config.jwt.secret }))
async function tokenFor(user: { id: string; orgId: string; role: string; email?: string }) {
  const ctx: any = (signer as any).decorator
  return ctx.jwt.sign({
    id: user.id,
    orgId: user.orgId,
    role: user.role,
    email: user.email || 'admin@backup.test',
    username: 'admin',
    permissions: [],
  })
}

async function call(
  path: string,
  opts: { method?: string; token?: string; body?: any } = {},
): Promise<{ status: number; json: any }> {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (opts.token) headers.authorization = `Bearer ${opts.token}`
  const res = await app.handle(new Request(`http://localhost${path}`, {
    method: opts.method || 'GET',
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  }))
  let json: any = null
  try { json = await res.clone().json() } catch { /* streams and empty bodies */ }
  return { status: res.status, json }
}

async function orgWithAdmin(slug: string) {
  const org = await createTestOrg({ slug, settings: { timezone: 'Europe/Sofia' } } as any)
  const orgId = String(org._id as Types.ObjectId)
  const user = await createTestUser(org._id as Types.ObjectId, {
    email: `${slug}@backup.test`, role: 'admin',
  } as any)
  const token = await tokenFor({ id: String(user._id), orgId, role: 'admin', email: `${slug}@backup.test` })
  return { org, orgId, user, token }
}

describe('authentication (FR-13.15)', () => {
  it('rejects an anonymous caller on every route with 401', async () => {
    const { orgId } = await orgWithAdmin('anon-co')
    const id = '6a99000000000000000000ff'

    expect((await call(`/org/${orgId}/backup/run`, { method: 'POST', body: {} })).status).toBe(401)
    expect((await call(`/org/${orgId}/backup/runs`)).status).toBe(401)
    expect((await call(`/org/${orgId}/backup/${id}/verify`)).status).toBe(401)
    expect((await call(`/org/${orgId}/backup/${id}/download`)).status).toBe(401)
    expect((await call(`/org/${orgId}/backup/test-email`, { method: 'POST' })).status).toBe(401)
  })

  it('rejects a signed-in non-admin with 403', async () => {
    const org = await createTestOrg({ slug: 'member-co' } as any)
    const orgId = String(org._id as Types.ObjectId)
    const member = await createTestUser(org._id as Types.ObjectId, {
      email: 'member@backup.test', role: 'member',
    } as any)
    const token = await tokenFor({ id: String(member._id), orgId, role: 'member' })

    const res = await call(`/org/${orgId}/backup/runs`, { token })
    expect(res.status).toBe(403)
  })
})

/**
 * ⚠ The finding this file exists for.
 *
 * Every route is `/org/:orgId/…` and the role check only asks whether the caller is *an*
 * admin — of anywhere. `tenantPlugin`'s pre-hooks are no-ops, and `buildBundle` filters on the
 * orgId in the ROUTE, so without an explicit comparison the admin of org A could take and
 * download org B's entire database, `User.password` hashes included.
 */
describe('tenant isolation (FR-13.15)', () => {
  it('refuses an admin of another org — running, listing and downloading', async () => {
    const a = await orgWithAdmin('org-a')
    const b = await orgWithAdmin('org-b')

    // A's admin, pointed at B's org.
    expect((await call(`/org/${b.orgId}/backup/run`, { method: 'POST', token: a.token, body: {} })).status).toBe(403)
    expect((await call(`/org/${b.orgId}/backup/runs`, { token: a.token })).status).toBe(403)
    expect((await call(`/org/${b.orgId}/backup/test-email`, { method: 'POST', token: a.token })).status).toBe(403)

    // And a real artifact of B's is not reachable with A's token either.
    const built = await runBackupForOrg(b.orgId, DAY)
    expect(built?.status).toBe('completed')
    const run: any = await BackupRun.findOne({ orgId: b.orgId }).lean().exec()

    const denied = await call(`/org/${b.orgId}/backup/${run._id}/download`, { token: a.token })
    expect(denied.status).toBe(403)

    // B's own admin can, so the 403 above is about the tenant and not about the route being
    // broken for everyone.
    const allowed = await call(`/org/${b.orgId}/backup/${run._id}/download`, { token: b.token })
    expect(allowed.status).toBe(200)
  })

  it('does not leak another org’s run through the history endpoint', async () => {
    const a = await orgWithAdmin('hist-a')
    const b = await orgWithAdmin('hist-b')
    await runBackupForOrg(b.orgId, DAY)

    const mine = await call(`/org/${a.orgId}/backup/runs`, { token: a.token })
    expect(mine.status).toBe(200)
    expect(mine.json.runs).toEqual([])
  })
})

describe('the date parameter (FR-13.12)', () => {
  it('refuses a traversal disguised as a date rather than writing outside the org', async () => {
    const { orgId, token } = await orgWithAdmin('trav-co')
    const res = await call(`/org/${orgId}/backup/run`, {
      method: 'POST', token, body: { date: '../../../../evil' },
    })
    // 422 from the handler's own check, or 422 from the body schema's pattern — either is a
    // refusal before anything touches the filesystem. What must NOT happen is a 200.
    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(await BackupRun.countDocuments({ orgId })).toBe(0)
  })

  it('accepts a well-formed date', async () => {
    const { orgId, token } = await orgWithAdmin('date-co')
    const res = await call(`/org/${orgId}/backup/run`, { method: 'POST', token, body: { date: DAY } })
    expect(res.status).toBe(200)
    expect(res.json.filename).toBe(`lgr-date-co-full-${DAY}.ndjson.zst`)
  })
})

describe('run ids and missing artifacts', () => {
  it('answers 404 for an id that is not an ObjectId, never 500', async () => {
    const { orgId, token } = await orgWithAdmin('cast-co')
    // Previously this reached `BackupRun.findOne({_id: 'not-an-id'})` and threw a CastError,
    // surfacing as an opaque 500.
    expect((await call(`/org/${orgId}/backup/not-an-id/verify`, { token })).status).toBe(404)
    expect((await call(`/org/${orgId}/backup/not-an-id/download`, { token })).status).toBe(404)
  })

  it('answers 410, not 404 or a lie, once retention has removed the artifact', async () => {
    const { orgId, token } = await orgWithAdmin('prune-co')
    await runBackupForOrg(orgId, DAY)
    const run: any = await BackupRun.findOne({ orgId }).lean().exec()

    // Simulate what retention does: the row survives as history, the bytes do not.
    rmSync(join(config.upload.dir, orgId, 'backups', run.filename), { force: true })
    await BackupRun.updateOne({ _id: run._id }, { $set: { artifactPruned: true } }).exec()

    const res = await call(`/org/${orgId}/backup/${run._id}/download`, { token })
    expect(res.status).toBe(410)
    expect(res.json.message).toContain('retention')
  })
})

describe('test-email does not build anything (FR-13.25)', () => {
  /**
   * ⚠ `POST /test-email` used to call `runBackupForOrg(..., force: true)`, so a button named
   * "test" silently overwrote the day's real backup row and re-exported the whole
   * organisation. A read-shaped action must not have a write-shaped effect.
   */
  it('refuses with 409 when there is nothing to mail, rather than building one', async () => {
    const { orgId, token } = await orgWithAdmin('mail-co')
    const res = await call(`/org/${orgId}/backup/test-email`, { method: 'POST', token })

    // 503 when this environment has no SendGrid key configured, 409 when it does but there is
    // no completed run. Both are refusals; neither may create a BackupRun.
    expect([409, 503]).toContain(res.status)
    expect(await BackupRun.countDocuments({ orgId })).toBe(0)
  })

  it('does not overwrite an existing completed run', async () => {
    const { orgId, token } = await orgWithAdmin('mail2-co')
    await runBackupForOrg(orgId, DAY)
    const before: any = await BackupRun.findOne({ orgId }).lean().exec()

    await call(`/org/${orgId}/backup/test-email`, { method: 'POST', token })

    const after: any = await BackupRun.findOne({ orgId }).lean().exec()
    expect(await BackupRun.countDocuments({ orgId })).toBe(1)
    expect(String(after._id)).toBe(String(before._id))
    expect(after.startedAt.getTime()).toBe(before.startedAt.getTime())
    expect(after.sha256).toBe(before.sha256)
  })
})
