import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { Elysia } from 'elysia'
import jwt from '@elysiajs/jwt'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { createTestOrg, createTestUser, createTestFiscalYear } from '../helpers/factories'
import { config } from 'config'
import { ArchiveUnit, DocFile } from 'db/models'
import { filesController } from '../../../files-api/src/controllers/file.controller'
import { archiveFiscalYear, orgDocsDir } from 'services/biz/archive/archive.service'
import type { Types } from 'mongoose'

/**
 * FR-13.42 (#24) — who may see an archive, and who may move one.
 *
 * ⚠ The interesting assertion in this file is the `nra_auditor` one. Приложение 29 т. 19
 * names that profile and т. 16 requires archived data to stay reachable „през потребителски
 * интерфейс": an auditor who can see the live documents but not the cold ones has been shown
 * a partial ledger, which is the situation the ordinance exists to prevent. They must also
 * NOT be able to pack or un-pack — seeing what is archived and deciding what gets archived
 * are different powers.
 *
 * NOTE: no `.rejects` / `.resolves` (Bun-on-Windows deadlock, see Known Issues).
 */

let TMP = ''
let app: Elysia

beforeAll(async () => {
  await setupTestDB()
  TMP = mkdtempSync(join(tmpdir(), 'lgr-archive-routes-'))
  config.upload.dir = TMP
  app = new Elysia().use(filesController)
}, 60_000)

afterAll(async () => {
  await teardownTestDB()
  rmSync(TMP, { recursive: true, force: true })
}, 60_000)

afterEach(async () => { await clearCollections() })

const signer = new Elysia().use(jwt({ name: 'jwt', secret: config.jwt.secret }))
async function tokenFor(u: { id: string; orgId: string; role: string; email: string; permissions?: string[] }) {
  const ctx: any = (signer as any).decorator
  return ctx.jwt.sign({ ...u, username: 'u', permissions: u.permissions || [] })
}

async function call(path: string, opts: { method?: string; token?: string; body?: any } = {}) {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (opts.token) headers.authorization = `Bearer ${opts.token}`
  const res = await app.handle(new Request(`http://localhost${path}`, {
    method: opts.method || 'GET',
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  }))
  let json: any = null
  try { json = await res.clone().json() } catch { /* streams */ }
  return { status: res.status, json }
}

async function orgWith(role: string, slug: string) {
  const org = await createTestOrg({ slug } as any)
  const orgId = String(org._id as Types.ObjectId)
  const email = `${slug}-${role}@archive.test`
  const user = await createTestUser(org._id as Types.ObjectId, { email, role } as any)
  const token = await tokenFor({ id: String(user._id), orgId, role, email })
  return { org, orgId, user, token }
}

/** A locked, packed year with one document in it. */
async function packedYear(orgId: string, userId: Types.ObjectId) {
  const fy = await createTestFiscalYear(orgId as any, {
    name: '2022', startDate: new Date('2022-01-01'), endDate: new Date('2022-12-31'), status: 'locked',
  } as any)
  const dir = join(orgDocsDir(orgId), '2022-04-04')
  mkdirSync(dir, { recursive: true })
  const abs = join(dir, 'a.pdf')
  writeFileSync(abs, 'AAA')
  await DocFile.create({
    orgId, docType: 'invoice', docNumber: 'INV-a', docDate: '2022-04-04',
    originalName: 'a.pdf', currentPath: abs,
    currentChecksum: createHash('sha256').update(Buffer.from('AAA')).digest('hex'),
    mimeType: 'application/pdf', size: 3, uploadedBy: userId, status: 'committed',
  } as any)
  return archiveFiscalYear(orgId, String(fy._id))
}

describe('reading the archive index', () => {
  it('lists units for an admin', async () => {
    const a = await orgWith('admin', 'arc-admin')
    await packedYear(a.orgId, a.user._id as Types.ObjectId)

    const res = await call(`/org/${a.orgId}/files/archives`, { token: a.token })
    expect(res.status).toBe(200)
    expect(res.json.units).toHaveLength(1)
    expect(res.json.units[0].fiscalYearName).toBe('2022')
    expect(res.json.units[0].status).toBe('packed')
  })

  it('lists units for an nra_auditor', async () => {
    const org = await createTestOrg({ slug: 'arc-auditor' } as any)
    const orgId = String(org._id as Types.ObjectId)
    const admin = await createTestUser(org._id as Types.ObjectId, { email: 'a@x.test', role: 'admin' } as any)
    await packedYear(orgId, admin._id as Types.ObjectId)

    const auditor = await createTestUser(org._id as Types.ObjectId, { email: 'n@x.test', role: 'nra_auditor' } as any)
    const token = await tokenFor({ id: String(auditor._id), orgId, role: 'nra_auditor', email: 'n@x.test' })

    // ⚠ Приложение 29 т. 19. An auditor who cannot see the cold years has been shown a
    // partial ledger — which is the whole situation the ordinance is about.
    const res = await call(`/org/${orgId}/files/archives`, { token })
    expect(res.status).toBe(200)
    expect(res.json.units).toHaveLength(1)
  })

  it('refuses an anonymous caller', async () => {
    const a = await orgWith('admin', 'arc-anon')
    expect((await call(`/org/${a.orgId}/files/archives`)).status).toBe(401)
  })
})

describe('moving a year in or out of cold storage', () => {
  it('refuses an nra_auditor', async () => {
    const org = await createTestOrg({ slug: 'arc-nowrite' } as any)
    const orgId = String(org._id as Types.ObjectId)
    const auditor = await createTestUser(org._id as Types.ObjectId, { email: 'n2@x.test', role: 'nra_auditor' } as any)
    const token = await tokenFor({ id: String(auditor._id), orgId, role: 'nra_auditor', email: 'n2@x.test' })

    // ⚠ Reading and deciding are different powers. An auditor inspects; they do not choose
    // what the organisation puts beyond easy reach.
    const cands = await call(`/org/${orgId}/files/archives/candidates`, { token })
    expect(cands.status).toBe(403)

    const pack = await call(`/org/${orgId}/files/archives/000000000000000000000000`, { method: 'POST', token })
    expect(pack.status).toBe(403)
    expect(await ArchiveUnit.countDocuments({ orgId })).toBe(0)
  })

  it('offers candidates to an admin', async () => {
    const a = await orgWith('admin', 'arc-cand')
    await createTestFiscalYear(a.org._id as Types.ObjectId, {
      name: '2022', startDate: new Date('2022-01-01'), endDate: new Date('2022-12-31'), status: 'locked',
    } as any)

    const res = await call(`/org/${a.orgId}/files/archives/candidates`, { token: a.token })
    expect(res.status).toBe(200)
    expect(res.json.years).toHaveLength(1)
    expect(res.json.years[0].name).toBe('2022')
  })

  it('un-archives for an admin', async () => {
    const a = await orgWith('admin', 'arc-un')
    const out = await packedYear(a.orgId, a.user._id as Types.ObjectId)
    expect(out.status).toBe('packed')

    const res = await call(`/org/${a.orgId}/files/archives/${out.unitId}/unarchive`, {
      method: 'POST', token: a.token,
    })
    expect(res.status).toBe(200)
    expect(res.json.restored).toBe(1)
    expect(await DocFile.countDocuments({ orgId: a.orgId, archived: true })).toBe(0)
  })
})
