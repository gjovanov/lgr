import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { createTestOrg, createTestUser } from '../helpers/factories'
import { config } from 'config'
import { mongoose } from 'db/connection'
import { DocFile, File } from 'db/models'
import { resolveDownload } from 'services/biz/files/doc-store.service'
import { runMigrations } from 'migrations/runner'
import { fileSha256 } from 'migrations/migrations/0002-file-sha256'

/**
 * Relative file paths, release N: every reader takes either form (FR-20.24, plan step P0b-8; AC 9
 * for the reading half). The writers and the rewrite of existing rows come one release later.
 *
 * NOTE: no `.rejects` / `.resolves` (Bun-on-Windows deadlock, see Known Issues).
 */

let TMP = ''
const was = config.upload.dir

beforeAll(async () => {
  await setupTestDB()
  TMP = mkdtempSync(join(tmpdir(), 'lgr-stored-paths-'))
  config.upload.dir = TMP
}, 60_000)
afterAll(async () => {
  config.upload.dir = was
  await teardownTestDB()
  rmSync(TMP, { recursive: true, force: true })
}, 60_000)
afterEach(async () => { await clearCollections() }, 30_000)

/** Put `body` at `<root>/<orgId>/docs/2026-09-10/<name>`; return the stored form. */
function place(orgId: string, name: string, body: string): string {
  const dir = join(TMP, orgId, 'docs', '2026-09-10')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, name), body)
  return `${orgId}/docs/2026-09-10/${name}`
}

async function docFile(orgId: string, userId: unknown, currentPath: string, name: string) {
  return DocFile.create({
    orgId, docType: 'invoice', docNumber: name, docDate: '2026-09-10', originalName: name,
    currentPath, currentChecksum: 'f'.repeat(64), version: 1, mimeType: 'application/pdf', size: 1,
    status: 'uploaded', uploadedBy: userId, uploadedAt: new Date(),
  } as any)
}

describe('a download reads either form of path', () => {
  it('the relative form, a legacy absolute one, and one a server with another root wrote (AC 9)', async () => {
    const org = await createTestOrg()
    const orgId = String(org._id)
    const user = await createTestUser(org._id as any)
    const rel = place(orgId, 'a.pdf', 'A')
    place(orgId, 'b.pdf', 'B')
    place(orgId, 'c.pdf', 'C')

    const asStored = await docFile(orgId, user._id, rel, 'a.pdf')
    const legacyHere = await docFile(orgId, user._id, join(TMP, orgId, 'docs', '2026-09-10', 'b.pdf'), 'b.pdf')
    // Written by production (`/app/uploads`), read on this server with its own root.
    const fromProd = await docFile(orgId, user._id, `/app/uploads/${orgId}/docs/2026-09-10/c.pdf`, 'c.pdf')

    for (const [d, body] of [[asStored, 'A'], [legacyHere, 'B'], [fromProd, 'C']] as const) {
      const got = await resolveDownload(orgId, String(d._id))
      expect(await Bun.file(got!.path).text()).toBe(body)
    }
  })
})

describe('0002-file-sha256', () => {
  it('records the checksum of the bytes, leaves a missing file alone, and changes nothing on a second run', async () => {
    const org = await createTestOrg()
    const orgId = String(org._id)
    const user = await createTestUser(org._id as any)
    const rel = place(orgId, 'x.pdf', 'hello')
    const base = { orgId: org._id, uploadedBy: user._id, storageProvider: 'local', mimeType: 'application/pdf', size: 5, module: 'files' }
    const [present, gone, kept] = await File.insertMany([
      { ...base, originalName: 'x.pdf', storagePath: join(TMP, ...rel.split('/')) },
      { ...base, originalName: 'gone.pdf', storagePath: `${orgId}/docs/2026-09-10/gone.pdf` },
      { ...base, originalName: 'kept.pdf', storagePath: rel, sha256: 'a'.repeat(64) },
    ])

    const db = mongoose.connection.db!
    await runMigrations({ db, orgFilter: {}, migrations: [fileSha256] })

    const sha = async (id: unknown) => (await File.findById(id).lean() as any).sha256
    expect(await sha(present._id)).toBe(createHash('sha256').update('hello').digest('hex'))
    expect(await sha(gone._id)).toBeUndefined()
    expect(await sha(kept._id)).toBe('a'.repeat(64))

    const before = await File.find({}).sort({ _id: 1 }).lean()
    await fileSha256.up({ db, orgFilter: {}, log: () => {} })
    expect(await File.find({}).sort({ _id: 1 }).lean()).toEqual(before)
  })
})
