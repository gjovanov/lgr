import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createHash } from 'node:crypto'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { createTestOrg, createTestUser } from '../helpers/factories'
import { config } from 'config'
import { mongoose } from 'db/connection'
import { fileRowsFollowTheirBytes } from 'migrations/migrations/0004-file-rows-follow-their-bytes'

const { Types } = mongoose

/**
 * Migration 0004 (#180): a File row left naming the path a re-upload or a delete moved its bytes
 * from is pointed at those bytes again, in its own org's `versions/` or `_deleted/` folder.
 *
 * Production on 2026-10-23 had 91 rows whose path held nothing and 25 whose path held the NEXT
 * version of their document. Both kinds are here, with every refusal the migration owes: two
 * candidates, none, another org's folder, a file another row names, a row a document claims.
 *
 * NOTE: no `.rejects` / `.resolves` (Bun-on-Windows deadlock, see Known Issues).
 */

let TMP = ''
const was = config.upload.dir

beforeAll(async () => {
  await setupTestDB()
  TMP = mkdtempSync(join(tmpdir(), 'lgr-0004-'))
  config.upload.dir = TMP
}, 60_000)
afterAll(async () => {
  config.upload.dir = was
  await teardownTestDB()
  rmSync(TMP, { recursive: true, force: true })
}, 60_000)
afterEach(async () => { await clearCollections() }, 30_000)

const db = () => mongoose.connection.db!
const sha = (body: string) => createHash('sha256').update(body).digest('hex')
const abs = (stored: string) => join(TMP, ...stored.split('/'))
function place(rel: string, body: string): string {
  mkdirSync(dirname(abs(rel)), { recursive: true })
  writeFileSync(abs(rel), body)
  return rel
}
const STAMP = '2026-08-28T23-19-23-010Z'

async function world() {
  const org = await createTestOrg()
  const user = await createTestUser(org._id as any)
  return { orgId: String(org._id), userId: String(user._id) }
}
const row = (orgId: string, userId: string, name: string, storagePath: string, body: string) => ({
  _id: new Types.ObjectId(), orgId: new Types.ObjectId(orgId), uploadedBy: new Types.ObjectId(userId),
  originalName: name, storagePath, storageProvider: 'local', mimeType: 'application/pdf',
  size: Buffer.byteLength(body), module: 'files',
})

describe('0004-file-rows-follow-their-bytes', () => {
  it('points each row at its own bytes, refuses every doubtful case, and a second run changes nothing', async () => {
    const A = await world()
    const B = await world()
    const a = A.orgId
    const day = `${a}/docs/2026-08-28`

    // 1. Re-uploaded: the canonical path now holds v2, v1 went to versions/. The old row still opens a file, not its own.
    place(`${day}/reup.pdf`, 'VERSION-TWO-LONGER')
    place(`${day}/versions/reup_${STAMP}.pdf`, 'VERSION-ONE')
    // 2. Left in the inbox, bytes since archived.
    place(`${day}/versions/inbox_${STAMP}.pdf`, 'INBOX-V1')
    // 3. Deleted: the document went to the trash.
    place(`${a}/docs/_deleted/2026-09-02/gone_2026-10-01T10-00-00-000Z.pdf`, 'TRASHED')
    // 4. Two candidates of its size: not guessed at.
    place(`${day}/versions/twice_${STAMP}.pdf`, 'SAME-SIZE-1')
    place(`${a}/docs/2026-08-29/versions/twice_2026-08-29T10-00-00-000Z.pdf`, 'SAME-SIZE-2')
    // 6. A document claims this row: 0003's business, never 0004's.
    place(`${day}/versions/claimed_${STAMP}.pdf`, 'CLAIMED')
    // 7. Only the OTHER org has a file of this name and size.
    place(`${B.orgId}/docs/2026-08-28/versions/foreign_${STAMP}.pdf`, 'FOREIGN')
    // 8. The candidate is already another row's.
    place(`${day}/versions/taken_${STAMP}.pdf`, 'TAKEN')
    // 9. A prefix of a longer name must not match it.
    place(`${day}/versions/pre_fix_${STAMP}.pdf`, 'PREFIX')

    const r = {
      reup: row(a, A.userId, 'reup.pdf', `${day}/reup.pdf`, 'VERSION-ONE'),
      inbox: row(a, A.userId, 'inbox.pdf', `${a}/docs/inbox/inbox.pdf`, 'INBOX-V1'),
      gone: row(a, A.userId, 'gone.pdf', `${a}/docs/2026-09-02/gone.pdf`, 'TRASHED'),
      twice: row(a, A.userId, 'twice.pdf', `${a}/docs/inbox/twice.pdf`, 'SAME-SIZE-1'),
      nowhere: row(a, A.userId, 'nowhere.pdf', `${a}/docs/inbox/nowhere.pdf`, 'NOWHERE'),
      claimed: row(a, A.userId, 'claimed.pdf', `${a}/docs/inbox/claimed.pdf`, 'CLAIMED'),
      foreign: row(a, A.userId, 'foreign.pdf', `${a}/docs/inbox/foreign.pdf`, 'FOREIGN'),
      taken: row(a, A.userId, 'taken.pdf', `${a}/docs/inbox/taken.pdf`, 'TAKEN'),
      holder: row(a, A.userId, 'taken.pdf', `${day}/versions/taken_${STAMP}.pdf`, 'TAKEN'),
      pre: row(a, A.userId, 'pre.pdf', `${a}/docs/inbox/pre.pdf`, 'PREFIX'),
    }
    await db().collection('files').insertMany(Object.values(r))
    await db().collection('docfiles').insertOne({
      orgId: new Types.ObjectId(a), docType: 'invoice', docNumber: 'claimed', docDate: '2026-08-28', originalName: 'claimed.pdf',
      currentPath: `${a}/docs/inbox/claimed.pdf`, currentChecksum: 'f'.repeat(64), version: 1, size: 7, status: 'uploaded',
      fileId: r.claimed._id, uploadedBy: new Types.ObjectId(A.userId), uploadedAt: new Date(),
    })

    const logs: string[] = []
    await fileRowsFollowTheirBytes.up({ db: db(), orgFilter: {}, log: m => logs.push(m) })
    const after = async (k: keyof typeof r) => db().collection('files').findOne({ _id: r[k]._id }) as Promise<any>

    expect((await after('reup')).storagePath).toBe(`${day}/versions/reup_${STAMP}.pdf`)
    expect((await after('reup')).sha256).toBe(sha('VERSION-ONE'))
    expect((await after('inbox')).storagePath).toBe(`${day}/versions/inbox_${STAMP}.pdf`)
    expect((await after('gone')).storagePath).toBe(`${a}/docs/_deleted/2026-09-02/gone_2026-10-01T10-00-00-000Z.pdf`)
    expect((await after('gone')).sha256).toBe(sha('TRASHED'))
    for (const k of ['twice', 'nowhere', 'claimed', 'foreign', 'taken', 'pre'] as const) {
      expect({ k, path: (await after(k)).storagePath }).toEqual({ k, path: r[k].storagePath })
    }
    expect(logs.join('\n')).toContain('pointed back at their own bytes in versions/ or _deleted/: 3')
    expect(logs.join('\n')).toContain(`${r.twice._id} ${r.twice.storagePath} (2 candidates)`)
    expect(logs.join('\n')).toContain(`${r.nowhere._id} ${r.nowhere.storagePath}`)

    // Idempotent: the same database, run again, is the same database.
    const before = JSON.stringify(await db().collection('files').find({}).sort({ _id: 1 }).toArray())
    await fileRowsFollowTheirBytes.up({ db: db(), orgFilter: {}, log: () => {} })
    expect(JSON.stringify(await db().collection('files').find({}).sort({ _id: 1 }).toArray())).toBe(before)
  })

  it('leaves a row alone whose path holds bytes of its size', async () => {
    const A = await world()
    const rel = place(`${A.orgId}/docs/2026-08-28/fine.pdf`, 'FINE')
    place(`${A.orgId}/docs/2026-08-28/versions/fine_${STAMP}.pdf`, 'FINE')
    const fine = row(A.orgId, A.userId, 'fine.pdf', rel, 'FINE')
    await db().collection('files').insertOne(fine)
    await fileRowsFollowTheirBytes.up({ db: db(), orgFilter: {}, log: () => {} })
    expect((await db().collection('files').findOne({ _id: fine._id }) as any).storagePath).toBe(rel)
  })

  it('refuses where the uploads volume is not mounted', async () => {
    const A = await world()
    await db().collection('files').insertOne(row(A.orgId, A.userId, 'x.pdf', `${A.orgId}/docs/inbox/x.pdf`, 'X'))
    config.upload.dir = join(TMP, 'not-mounted')
    let refused: unknown
    try { await fileRowsFollowTheirBytes.up({ db: db(), orgFilter: {}, log: () => {} }) } catch (e) { refused = e }
    config.upload.dir = TMP
    expect(String(refused)).toContain('is not on this host')
  })
})
