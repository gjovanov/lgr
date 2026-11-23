import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { Elysia } from 'elysia'
import jwt from '@elysiajs/jwt'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { setupTestDB, teardownTestDB } from '../setup'
import { createTestOrg, createTestUser } from '../helpers/factories'
import { uploadPath, useTempUploadDir } from '../helpers/upload-path'
import { fileController } from '../../../api/src/controllers/file.controller'
import { spaErrorHandler } from '../../../api/src/spa-fallback.js'
import { DocFile, File, NodeState } from 'db/models'
import { config } from 'config'
import { DEFAULT_ROLE_PERMISSIONS } from 'config/constants'
import { toStored } from 'services/biz/files/stored-path'
import { removeStoredFile, retryPendingFileRemovals } from 'services/biz/files/file-removal.service'
import { retentionTick } from 'services/biz/retention/retention.service'

/**
 * FR-32.11 (#797): deleting a file deletes its bytes. `DELETE /org/:orgId/file/:id` removed the row and left the
 * stored object; now the bytes go after the row, bytes another row still names stay, and a removal that fails leaves
 * a marker the retention tick retries.
 *
 * NOTE: no `.rejects` / `.resolves` — the Bun-on-Windows deadlock in the Known Issues table.
 */

const signer = new Elysia().use(jwt({ name: 'jwt', secret: config.jwt.secret }))
let org: any
let user: any
let token: string
let restoreUploads: () => void

async function del(id: unknown) {
  const res = await new Elysia().onError(spaErrorHandler({}) as any).use(fileController).handle(new Request(`http://localhost/org/${org._id}/file/${id}`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${token}` },
  }))
  return { status: res.status, json: await res.json().catch(() => null) }
}

let n = 0
async function storedFile(extra: Record<string, unknown> = {}) {
  const abs = uploadPath(org._id, `delete-me-${++n}.pdf`)
  writeFileSync(abs, 'bytes')
  const row = await File.create({
    orgId: org._id, uploadedBy: user._id, originalName: `delete-me-${n}.pdf`, storagePath: toStored(abs),
    storageProvider: 'local', mimeType: 'application/pdf', size: 5, module: 'files', ...extra,
  })
  return { row, abs }
}

beforeAll(async () => {
  await setupTestDB()
  restoreUploads = useTempUploadDir()
  org = await createTestOrg({ name: 'Delete Test', slug: 'file-delete-test' } as any)
  user = await createTestUser(org._id, { role: 'admin' } as any)
  token = await (signer as any).decorator.jwt.sign({
    id: String(user._id), orgId: String(org._id), role: 'admin', email: 'a@test.com', username: 'admin',
    firstName: 'A', lastName: 'B', permissions: DEFAULT_ROLE_PERMISSIONS.admin, ownRecordsModules: [],
  })
}, 60_000)

afterEach(async () => {
  await NodeState.deleteMany({ _id: { $regex: '^file-removal:' } })
})

afterAll(async () => {
  restoreUploads()
  await teardownTestDB()
}, 60_000)

describe('deleting a file deletes its bytes (FR-32.11)', () => {
  it('DELETE removes the row, then the stored object', async () => {
    const { row, abs } = await storedFile()
    expect(existsSync(abs)).toBe(true)

    const res = await del(row._id)
    expect(res.status).toBe(200)
    expect(await File.exists({ _id: row._id })).toBeNull()
    expect(existsSync(abs)).toBe(false)
  })

  it('bytes another row still names stay: a second File row, or a document of the Files app', async () => {
    const { row, abs } = await storedFile()
    const twin = await File.create({
      orgId: org._id, uploadedBy: user._id, originalName: 'twin.pdf', storagePath: row.storagePath,
      storageProvider: 'local', mimeType: 'application/pdf', size: 5, module: 'files',
    })
    expect((await del(row._id)).status).toBe(200)
    expect(existsSync(abs)).toBe(true)

    expect(await removeStoredFile({ orgId: org._id, storagePath: row.storagePath, storageProvider: 'local' })).toBe('shared')

    // The same bytes named by a DocFile, in the absolute form a row kept before #177.
    await File.deleteOne({ _id: twin._id })
    await DocFile.collection.insertOne({ orgId: org._id, currentPath: abs, docType: 'invoice', docNumber: 'X-1', docDate: '2026-11-17' } as any)
    expect(await removeStoredFile({ orgId: org._id, storagePath: row.storagePath, storageProvider: 'local' })).toBe('shared')
    expect(existsSync(abs)).toBe(true)
    await DocFile.collection.deleteMany({ orgId: org._id })
  })

  it('a file already gone, another provider\'s key, and a path outside the org are left alone', async () => {
    const { row, abs } = await storedFile()
    await File.deleteOne({ _id: row._id })
    rmSync(abs)
    expect(await removeStoredFile(row)).toBe('absent')
    expect(await removeStoredFile({ orgId: org._id, storagePath: 'bucket/key.pdf', storageProvider: 's3' })).toBe('not_local')
    expect(await removeStoredFile({ orgId: org._id, storagePath: '000000000000000000000000/other.pdf', storageProvider: 'local' })).toBe('outside')
    expect(await NodeState.countDocuments({ _id: { $regex: '^file-removal:' } })).toBe(0)
  })

  it('a removal that fails leaves a marker, and the retention tick removes the bytes later', async () => {
    // A directory where the file should be: `rm` without `recursive` refuses it, on every OS.
    const abs = uploadPath(org._id, `stuck-${++n}.pdf`)
    mkdirSync(abs, { recursive: true })
    writeFileSync(`${abs}/inside`, 'x')
    const stored = toStored(abs)

    expect(await removeStoredFile({ orgId: org._id, storagePath: stored, storageProvider: 'local' })).toBe('pending')
    const marker: any = await NodeState.findOne({ _id: { $regex: '^file-removal:' } }).lean()
    expect(marker?.value).toMatchObject({ kind: 'file-removal', orgId: String(org._id), storagePath: stored, attempts: 1 })

    // Still stuck: the marker stays and counts the attempt.
    expect(await retryPendingFileRemovals(10)).toEqual({ removed: 0, stillPending: 1 })
    expect(((await NodeState.findById(marker._id).lean()) as any)?.value?.attempts).toBe(2)

    // Whatever held it is gone, and a plain file is there: the next tick removes it and the marker.
    rmSync(abs, { recursive: true, force: true })
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, 'bytes')
    const out = await retentionTick(new Date())
    expect(out.fileRemovalsRetried).toBe(1)
    expect(existsSync(abs)).toBe(false)
    expect(await NodeState.exists({ _id: marker._id })).toBeNull()
  })
})
