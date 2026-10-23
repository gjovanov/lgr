import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createHash } from 'node:crypto'
import { Elysia } from 'elysia'
import jwt from '@elysiajs/jwt'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { createTestOrg, createTestUser } from '../helpers/factories'
import { config } from 'config'
import { DEFAULT_ROLE_PERMISSIONS } from 'config/constants'
import { mongoose } from 'db/connection'
import { DocFile, File } from 'db/models'
import { assignDateAfterOcr, resolveDownload, storeDocument } from 'services/biz/files/doc-store.service'
import { deleteDocFiles } from 'services/biz/files/doc-delete.service'
import { remapDoc } from 'services/biz/backup/backup-restore.service'
import { runMigrations } from 'migrations/runner'
import { relativeFilePaths } from 'migrations/migrations/0003-relative-file-paths'
import { fileController } from '../../../portal-api/src/controllers/file.controller'

const { Types } = mongoose

/**
 * Relative file paths, release N+1: the writers store the relative form, and migration 0003
 * rewrites the rows that are still absolute (FR-20.24, plan step P0b-8). Also #180: a File row
 * follows its document's bytes when the Files app moves them.
 *
 * NOTE: no `.rejects` / `.resolves` (Bun-on-Windows deadlock, see Known Issues).
 */

let TMP = ''
let app: Elysia
const was = config.upload.dir

beforeAll(async () => {
  await setupTestDB()
  TMP = mkdtempSync(join(tmpdir(), 'lgr-relative-paths-'))
  config.upload.dir = TMP
  app = new Elysia().use(fileController)
}, 60_000)
afterAll(async () => {
  config.upload.dir = was
  await teardownTestDB()
  rmSync(TMP, { recursive: true, force: true })
}, 60_000)
afterEach(async () => { await clearCollections() }, 30_000)

const db = () => mongoose.connection.db!
const sha = (body: string) => createHash('sha256').update(body).digest('hex')
/** The absolute path on this server of a stored path. */
const abs = (stored: string) => join(TMP, ...stored.split('/'))

/** Put `body` at the stored path `rel`; return `rel`. */
function place(rel: string, body: string): string {
  mkdirSync(dirname(abs(rel)), { recursive: true })
  writeFileSync(abs(rel), body)
  return rel
}

function fakeFile(name: string, content: string, type = 'application/pdf') {
  const bytes = new TextEncoder().encode(content)
  return { name, type, size: bytes.byteLength, arrayBuffer: async () => bytes.buffer as ArrayBuffer }
}

async function world() {
  const org = await createTestOrg()
  const user = await createTestUser(org._id as any)
  return { org, orgId: String(org._id), userId: String(user._id) }
}

const fileRow = async (id: unknown) => File.findById(id).lean() as Promise<any>

describe('the Files app stores relative paths', () => {
  it('an upload stores the relative form in the DocFile and File rows, and a download reads it', async () => {
    const { orgId, userId } = await world()
    const r = await storeDocument(orgId, userId, fakeFile('invoicem_3000100855.pdf', 'v1'))

    const stored = `${orgId}/docs/inbox/invoicem_3000100855.pdf`
    expect(r.docFile.currentPath).toBe(stored)
    expect((await fileRow(r.docFile.fileId)).storagePath).toBe(stored)
    const got = await resolveDownload(orgId, String(r.docFile._id))
    expect(readFileSync(got!.path, 'utf8')).toBe('v1')
  })

  it('a re-upload moves the previous File row with its bytes into versions/ (#180)', async () => {
    const { orgId, userId } = await world()
    const first = await storeDocument(orgId, userId, fakeFile('stokrazp_3000016216.pdf', 'v1'))
    const second = await storeDocument(orgId, userId, fakeFile('stokrazp_3000016216.pdf', 'v2'))

    const previous = await fileRow(first.docFile.fileId)
    expect(previous.storagePath).toMatch(new RegExp(`^${orgId}/docs/inbox/versions/stokrazp_3000016216_[^/]+\\.pdf$`))
    expect(readFileSync(abs(previous.storagePath), 'utf8')).toBe('v1')
    expect(previous.sha256).toBe(sha('v1'))

    const current = await fileRow(second.docFile.fileId)
    expect(current.storagePath).toBe(`${orgId}/docs/inbox/stokrazp_3000016216.pdf`)
    expect(readFileSync(abs(current.storagePath), 'utf8')).toBe('v2')
  })
})

describe('assignDateAfterOcr moves the document, and its File row with it (#180)', () => {
  it('both rows name the date folder, where the bytes are', async () => {
    const { orgId, userId } = await world()
    const r = await storeDocument(orgId, userId, fakeFile('invoicem_3000100900.pdf', 'pdf-bytes'))

    const doc: any = await assignDateAfterOcr(orgId, String(r.docFile._id), '2026-09-14', 'invoice')

    const dest = `${orgId}/docs/2026-09-14/invoicem_3000100900.pdf`
    expect(doc.currentPath).toBe(dest)
    expect(doc.docDate).toBe('2026-09-14')
    expect(doc.status).toBe('extracted')
    expect((await fileRow(r.docFile.fileId)).storagePath).toBe(dest)
    expect(readFileSync(abs(dest), 'utf8')).toBe('pdf-bytes')
    expect(existsSync(abs(`${orgId}/docs/inbox/invoicem_3000100900.pdf`))).toBe(false)
  })

  it('a row the previous release wrote, absolute, comes out relative', async () => {
    const { orgId, userId } = await world()
    const r = await storeDocument(orgId, userId, fakeFile('invoicem_3000100904.pdf', 'legacy'))
    const legacy = abs(r.docFile.currentPath)
    await DocFile.updateOne({ _id: r.docFile._id }, { $set: { currentPath: legacy } })
    await File.updateOne({ _id: r.docFile.fileId }, { $set: { storagePath: legacy } })

    const doc: any = await assignDateAfterOcr(orgId, String(r.docFile._id), '2026-09-14')

    const dest = `${orgId}/docs/2026-09-14/invoicem_3000100904.pdf`
    expect(doc.currentPath).toBe(dest)
    expect((await fileRow(r.docFile.fileId)).storagePath).toBe(dest)
    expect(readFileSync(abs(dest), 'utf8')).toBe('legacy')
  })

  it('a move that fails is not swallowed: both rows keep naming the bytes, and the date still lands', async () => {
    const { orgId, userId } = await world()
    const r = await storeDocument(orgId, userId, fakeFile('invoicem_3000100901.pdf', 'still-here'))
    const inbox = r.docFile.currentPath
    // Something already sits where the document would go, so the rename fails.
    mkdirSync(abs(`${orgId}/docs/2026-09-14/invoicem_3000100901.pdf`), { recursive: true })

    const doc: any = await assignDateAfterOcr(orgId, String(r.docFile._id), '2026-09-14')

    expect(doc.currentPath).toBe(inbox)
    expect((await fileRow(r.docFile.fileId)).storagePath).toBe(inbox)
    expect(doc.docDate).toBe('2026-09-14')
    expect(doc.status).toBe('extracted')
    const got = await resolveDownload(orgId, String(r.docFile._id))
    expect(readFileSync(got!.path, 'utf8')).toBe('still-here')
  })

  it('bytes that are gone leave both rows as they were', async () => {
    const { orgId, userId } = await world()
    const r = await storeDocument(orgId, userId, fakeFile('invoicem_3000100905.pdf', 'lost'))
    rmSync(abs(r.docFile.currentPath))

    const doc: any = await assignDateAfterOcr(orgId, String(r.docFile._id), '2026-09-14')

    expect(doc.currentPath).toBe(`${orgId}/docs/inbox/invoicem_3000100905.pdf`)
    expect((await fileRow(r.docFile.fileId)).storagePath).toBe(`${orgId}/docs/inbox/invoicem_3000100905.pdf`)
  })

  it('a retry after the bytes already moved records where they are', async () => {
    const { orgId, userId } = await world()
    const r = await storeDocument(orgId, userId, fakeFile('invoicem_3000100902.pdf', 'moved-once'))
    const dest = `${orgId}/docs/2026-09-14/invoicem_3000100902.pdf`
    mkdirSync(dirname(abs(dest)), { recursive: true })
    renameSync(abs(r.docFile.currentPath), abs(dest))

    const doc: any = await assignDateAfterOcr(orgId, String(r.docFile._id), '2026-09-14')

    expect(doc.currentPath).toBe(dest)
    expect((await fileRow(r.docFile.fileId)).storagePath).toBe(dest)
  })
})

describe('deleting a document', () => {
  it('moves its File row with the bytes into the trash folder', async () => {
    const { orgId, userId } = await world()
    const r = await storeDocument(orgId, userId, fakeFile('invoicem_3000100903.pdf', 'to-trash'))

    const res = await deleteDocFiles(orgId, userId, [String(r.docFile._id)], { execute: true })

    expect(res.deleted).toEqual(['3000100903'])
    const row = await fileRow(r.docFile.fileId)
    expect(row.storagePath).toMatch(new RegExp(`^${orgId}/docs/_deleted/inbox/invoicem_3000100903_[^/]+\\.pdf$`))
    expect(readFileSync(abs(row.storagePath), 'utf8')).toBe('to-trash')
  })
})

describe('POST /org/:orgId/file', () => {
  const signer = new Elysia().use(jwt({ name: 'jwt', secret: config.jwt.secret }))
  async function post(orgId: string, userId: string, body: Record<string, unknown>) {
    const token = await (signer as any).decorator.jwt.sign({
      id: userId, orgId, role: 'admin', email: 'admin@test.com', username: 'admin',
      firstName: 'Test', lastName: 'Admin', permissions: DEFAULT_ROLE_PERMISSIONS.admin,
    })
    const res = await app.handle(new Request(`http://localhost/org/${orgId}/file`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ originalName: 'a.pdf', mimeType: 'application/pdf', size: 1, module: 'files', ...body }),
    }))
    return res.status
  }

  it('stores a local path in the relative form, and only one of the caller\'s org', async () => {
    const { orgId, userId } = await world()
    const other = new Types.ObjectId().toString()

    expect(await post(orgId, userId, { originalName: 'here.pdf', storagePath: join(TMP, orgId, 'misc', 'here.pdf') })).toBe(200)
    expect(await post(orgId, userId, { originalName: 'prod.pdf', storagePath: `/app/uploads/${orgId}/misc/prod.pdf` })).toBe(200)
    expect(await post(orgId, userId, { originalName: 's3.pdf', storageProvider: 's3', storagePath: `bucket/${other}/s3.pdf` })).toBe(200)
    const stored = async (name: string) => (await File.findOne({ orgId, originalName: name }).lean() as any)?.storagePath
    expect(await stored('here.pdf')).toBe(`${orgId}/misc/here.pdf`)
    expect(await stored('prod.pdf')).toBe(`${orgId}/misc/prod.pdf`)
    expect(await stored('s3.pdf')).toBe(`bucket/${other}/s3.pdf`)   // a provider's key, not a path

    for (const storagePath of [`${other}/misc/x.pdf`, `/app/uploads/${other}/x.pdf`, `${orgId}/../${other}/x.pdf`, '/etc/passwd']) {
      expect(await post(orgId, userId, { originalName: 'refused.pdf', storagePath })).toBe(422)
    }
    expect(await File.countDocuments({ originalName: 'refused.pdf' })).toBe(0)
  })
})

describe('a restore writes the relative form', () => {
  it('in the same org and across orgs; another provider\'s key and an unknown root are left alone', () => {
    const a = new Types.ObjectId().toString()
    const b = new Types.ObjectId().toString()

    expect(remapDoc({ orgId: a, currentPath: `/app/uploads/${a}/docs/2026-09-10/x.pdf` }, null, a).currentPath)
      .toBe(`${a}/docs/2026-09-10/x.pdf`)
    expect(remapDoc({ orgId: a, storageProvider: 'local', storagePath: join(TMP, a, 'docs', 'x.pdf') }, b, a).storagePath)
      .toBe(`${b}/docs/x.pdf`)
    expect(remapDoc({ orgId: a, currentPath: `${a}/docs/inbox/y.pdf` }, b, a).currentPath).toBe(`${b}/docs/inbox/y.pdf`)
    expect(remapDoc({ orgId: a, storageProvider: 's3', storagePath: `bucket/${a}/x.pdf` }, b, a).storagePath).toBe(`bucket/${a}/x.pdf`)
    expect(remapDoc({ orgId: a, currentPath: '/srv/elsewhere/x.pdf' }, null, a).currentPath).toBe('/srv/elsewhere/x.pdf')
  })
})

describe('0003-relative-file-paths', () => {
  /** The three collections it writes, as comparable text. */
  async function snapshot(): Promise<string> {
    const out: string[] = []
    for (const c of ['docfiles', 'files', 'archiveunits']) {
      out.push(`${c}:${JSON.stringify(await db().collection(c).find({}).sort({ _id: 1 }).toArray())}`)
    }
    return out.join('\n')
  }

  async function doc(orgId: string, userId: string, docNumber: string, currentPath: string, fileId?: unknown) {
    return DocFile.create({
      orgId, docType: 'invoice', docNumber, docDate: '2026-09-14', originalName: `invoicem_${docNumber}.pdf`,
      currentPath, currentChecksum: 'f'.repeat(64), version: 1, mimeType: 'application/pdf', size: 1,
      status: 'uploaded', uploadedBy: userId, uploadedAt: new Date(), ...(fileId ? { fileId } : {}),
    } as any)
  }
  const fileBase = (orgId: string, userId: string, originalName: string) => ({
    orgId: new Types.ObjectId(orgId), uploadedBy: new Types.ObjectId(userId), originalName,
    storageProvider: 'local', mimeType: 'application/pdf', size: 1, module: 'files',
  })

  it('rewrites paths, repoints the rows the inbox move left behind, lists the rest, and a second run changes nothing', async () => {
    const A = await world()
    const B = await world()
    const a = A.orgId
    const day = `${a}/docs/2026-09-14`

    place(`${day}/1.pdf`, 'ONE')
    place(`${day}/2.pdf`, 'TWO')
    place(`${day}/3.pdf`, 'THREE')
    place(`${a}/docs/2026-09-10/abs.pdf`, 'ABS')
    place(`${a}/docs/2026-09-10/prod.pdf`, 'PROD')
    place(`${a}/docs/2026-09-10/rel.pdf`, 'REL')
    place(`${B.orgId}/docs/2026-09-10/b.pdf`, 'B')

    const files = db().collection('files')
    const ids = Object.fromEntries(['f1', 'f2', 'f3', 'f4', 'f5', 'f6', 'f7', 'f8', 'fb'].map(k => [k, new Types.ObjectId()]))
    await files.insertMany([
      // #180: left in the inbox, as production wrote it (absolute), no checksum
      { _id: ids.f1, ...fileBase(a, A.userId, '1.pdf'), storagePath: `/app/uploads/${a}/docs/inbox/1.pdf` },
      // left in the inbox, checksum of the document's bytes
      { _id: ids.f2, ...fileBase(a, A.userId, '2.pdf'), storagePath: `${a}/docs/inbox/2.pdf`, sha256: sha('TWO') },
      // left in the inbox, checksum of OTHER bytes: not this document's row
      { _id: ids.f3, ...fileBase(a, A.userId, '3.pdf'), storagePath: `${a}/docs/inbox/3.pdf`, sha256: sha('OTHER') },
      // its document has no bytes either
      { _id: ids.f4, ...fileBase(a, A.userId, 'gone.pdf'), storagePath: `${a}/docs/inbox/gone.pdf` },
      // no document at all
      { _id: ids.f5, ...fileBase(a, A.userId, 'deleted.pdf'), storagePath: `${a}/docs/inbox/deleted.pdf` },
      // bytes present, absolute
      { _id: ids.f6, ...fileBase(a, A.userId, 'abs.pdf'), storagePath: abs(`${a}/docs/2026-09-10/abs.pdf`) },
      // another provider: a key, not a path
      { _id: ids.f7, ...fileBase(a, A.userId, 'key.pdf'), storageProvider: 's3', storagePath: `/app/uploads/${a}/key.pdf` },
      // written before storageProvider had a default
      { _id: ids.f8, ...fileBase(a, A.userId, 'rel.pdf'), storageProvider: undefined, storagePath: abs(`${a}/docs/2026-09-10/rel.pdf`) },
      // the other org: out of this node's scope
      { _id: ids.fb, ...fileBase(B.orgId, B.userId, 'nob.pdf'), storagePath: `/app/uploads/${B.orgId}/docs/inbox/nob.pdf` },
    ].map(f => { if (f.storageProvider === undefined) delete (f as any).storageProvider; return f }))

    const d1 = await doc(a, A.userId, '1', abs(`${day}/1.pdf`), ids.f1)
    const d2 = await doc(a, A.userId, '2', `${day}/2.pdf`, ids.f2)
    const d3 = await doc(a, A.userId, '3', `${day}/3.pdf`, ids.f3)
    const d4 = await doc(a, A.userId, '4', `${day}/gone.pdf`, ids.f4)
    const dAbs = await doc(a, A.userId, '5', abs(`${a}/docs/2026-09-10/abs.pdf`))
    const dProd = await doc(a, A.userId, '6', `/app/uploads/${a}/docs/2026-09-10/prod.pdf`)
    const dRel = await doc(a, A.userId, '7', `${a}/docs/2026-09-10/rel.pdf`)
    const dElsewhere = await doc(a, A.userId, '8', `/srv/elsewhere/${a}/x.pdf`)
    const dB = await doc(B.orgId, B.userId, '9', abs(`${B.orgId}/docs/2026-09-10/b.pdf`))
    const units = db().collection('archiveunits')
    await units.insertMany([
      { orgId: new Types.ObjectId(a), fiscalYearId: new Types.ObjectId(), fiscalYearName: '2025', path: `${a}\\archives\\lgr-archive-2025.ndjson.zst.sealed` },
      { orgId: new Types.ObjectId(a), fiscalYearId: new Types.ObjectId(), fiscalYearName: '2024', path: `${a}/archives/lgr-archive-2024.ndjson.zst.sealed` },
    ])

    const orgFilter = { orgId: { $in: [new Types.ObjectId(a)] } }
    const bBefore = JSON.stringify([
      await db().collection('docfiles').find({ orgId: new Types.ObjectId(B.orgId) }).toArray(),
      await files.find({ orgId: new Types.ObjectId(B.orgId) }).toArray(),
    ])
    const logs: string[] = []
    const res = await runMigrations({ db: db(), orgFilter, migrations: [relativeFilePaths], log: m => logs.push(m) })
    expect(res.applied).toEqual(['0003-relative-file-paths'])

    const path = async (d: any) => (await DocFile.findById(d._id).lean() as any).currentPath
    const row = async (k: string) => files.findOne({ _id: ids[k] }) as Promise<any>

    // 1. The stored form; a path under no known root is left as it is.
    expect(await path(d1)).toBe(`${day}/1.pdf`)
    expect(await path(dAbs)).toBe(`${a}/docs/2026-09-10/abs.pdf`)
    expect(await path(dProd)).toBe(`${a}/docs/2026-09-10/prod.pdf`)
    expect(await path(dRel)).toBe(`${a}/docs/2026-09-10/rel.pdf`)
    expect(await path(dElsewhere)).toBe(`/srv/elsewhere/${a}/x.pdf`)
    expect((await row('f6')).storagePath).toBe(`${a}/docs/2026-09-10/abs.pdf`)
    expect((await row('f8')).storagePath).toBe(`${a}/docs/2026-09-10/rel.pdf`)
    expect((await row('f7')).storagePath).toBe(`/app/uploads/${a}/key.pdf`)
    for (const d of [dAbs, dProd, dRel]) {
      const got = await resolveDownload(a, String(d._id))
      expect(readFileSync(got!.path, 'utf8')).toMatch(/^(ABS|PROD|REL)$/)
    }

    // 2. Repointed at the document, with the checksum of its bytes.
    expect(await row('f1')).toMatchObject({ storagePath: `${day}/1.pdf`, sha256: sha('ONE') })
    expect(await row('f2')).toMatchObject({ storagePath: `${day}/2.pdf`, sha256: sha('TWO') })
    // …but not a row that describes other bytes.
    expect(await row('f3')).toMatchObject({ storagePath: `${a}/docs/inbox/3.pdf`, sha256: sha('OTHER') })
    expect(await path(d3)).toBe(`${day}/3.pdf`)

    // 3. Listed, never deleted.
    expect((await row('f4')).storagePath).toBe(`${a}/docs/inbox/gone.pdf`)
    expect((await row('f5')).storagePath).toBe(`${a}/docs/inbox/deleted.pdf`)
    expect(await path(d4)).toBe(`${day}/gone.pdf`)
    const text = logs.join('\n')
    expect(text).toContain('repointed to the document that names them: 2')
    expect(text).toContain(`(listed, not changed): 1\n  ${ids.f3} `)
    expect(text).toContain('(listed, not deleted): 2\n')
    expect(text).toContain(`${ids.f4} ${a}/docs/inbox/gone.pdf`)
    expect(text).toContain(`${ids.f5} ${a}/docs/inbox/deleted.pdf`)
    expect(text).toContain('1 under no known upload root')

    // 4. Archive units.
    expect((await units.findOne({ fiscalYearName: '2025' }) as any).path).toBe(`${a}/archives/lgr-archive-2025.ndjson.zst.sealed`)

    // The other org is not this node's to migrate.
    expect(JSON.stringify([
      await db().collection('docfiles').find({ orgId: new Types.ObjectId(B.orgId) }).toArray(),
      await files.find({ orgId: new Types.ObjectId(B.orgId) }).toArray(),
    ])).toBe(bBefore)
    expect(await path(dB)).toBe(abs(`${B.orgId}/docs/2026-09-10/b.pdf`))

    // Run again: nothing changes, and the same rows are listed.
    const once = await snapshot()
    const again: string[] = []
    await relativeFilePaths.up({ db: db(), orgFilter, log: m => again.push(m) })
    expect(await snapshot()).toBe(once)
    const second = again.join('\n')
    expect(second).toContain('DocFile.currentPath: 0 made relative')
    expect(second).toContain('File.storagePath: 0 made relative')
    expect(second).toContain('repointed to the document that names them: 0')
    expect(second).toContain(`${ids.f3} `)
    expect(second).toContain(`${ids.f4} `)
    expect(second).toContain(`${ids.f5} `)
  })

  it('refuses where the uploads volume is not mounted, unless there is nothing to read', async () => {
    const A = await world()
    config.upload.dir = join(TMP, 'not-mounted')
    try {
      // A new node with no files yet: nothing to read, nothing to refuse.
      await relativeFilePaths.up({ db: db(), orgFilter: {}, log: () => {} })

      await db().collection('files').insertOne({ ...fileBase(A.orgId, A.userId, 'x.pdf'), storagePath: `/app/uploads/${A.orgId}/docs/inbox/x.pdf` })
      const before = await snapshot()
      let refused: unknown
      try { await relativeFilePaths.up({ db: db(), orgFilter: {}, log: () => {} }) } catch (e) { refused = e }
      expect((refused as Error)?.message).toContain('is not on this host')
      expect(await snapshot()).toBe(before)
    } finally {
      config.upload.dir = TMP
    }
  })

  it('never points one org\'s File row at another org\'s document', async () => {
    const A = await world()
    const B = await world()
    place(`${A.orgId}/docs/2026-09-14/a.pdf`, 'A')
    const fb = new Types.ObjectId()
    await db().collection('files').insertOne({ _id: fb, ...fileBase(B.orgId, B.userId, 'b.pdf'), storagePath: `${B.orgId}/docs/inbox/b.pdf` })
    await doc(A.orgId, A.userId, '1', `${A.orgId}/docs/2026-09-14/a.pdf`, fb)

    const logs: string[] = []
    await relativeFilePaths.up({ db: db(), orgFilter: {}, log: m => logs.push(m) })

    expect((await db().collection('files').findOne({ _id: fb }) as any).storagePath).toBe(`${B.orgId}/docs/inbox/b.pdf`)
    expect(logs.join('\n')).toContain(`${fb} ${B.orgId}/docs/inbox/b.pdf`)
  })

  it('counts a row naming another org\'s file, and leaves it unreadable', async () => {
    const A = await world()
    const B = await world()
    place(`${B.orgId}/docs/2026-09-10/b.pdf`, 'B')
    const d = await doc(A.orgId, A.userId, '1', abs(`${B.orgId}/docs/2026-09-10/b.pdf`))

    const logs: string[] = []
    await relativeFilePaths.up({ db: db(), orgFilter: {}, log: m => logs.push(m) })

    expect((await DocFile.findById(d._id).lean() as any).currentPath).toBe(`${B.orgId}/docs/2026-09-10/b.pdf`)
    expect(logs.join('\n')).toContain("1 name another org's file")
    let refused: unknown
    try { await resolveDownload(A.orgId, String(d._id)) } catch (e) { refused = e }
    expect((refused as Error)?.message).toContain('another org')
  })
})
