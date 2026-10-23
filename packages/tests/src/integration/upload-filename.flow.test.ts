import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { Elysia } from 'elysia'
import jwt from '@elysiajs/jwt'
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { setupTestDB, teardownTestDB } from '../setup'
import { createTestOrg, createTestUser } from '../helpers/factories'
import { createApiApp } from '../../../portal-api/src/api.js'
import { File as FileModel } from 'db/models'
import { config } from 'config'
import { DEFAULT_ROLE_PERMISSIONS } from 'config/constants'

/**
 * An uploaded file's NAME never takes it out of its directory (the two import endpoints).
 *
 * `/bills/import/extract` and `/doc-import/extract` wrote each part to
 * `join(dir, `${Date.now()}-${name}`.replace(/[^\w.\-\/\\]/g, '_'))`. The filter KEPT `/` and
 * `\`, so a part named `x/../../../../anything` passed it and `join` resolved the result out of
 * the org's upload directory: into another org's tree, or anywhere the process can write. A
 * browser never puts a path in a filename; curl does. Same class as S-03 (#49), which fixed the
 * Files app's writer and not these two.
 *
 * Over HTTP, through the real route table, with the multipart body written by hand so the
 * filename on the wire is exactly the hostile one. The response echoes the name the server
 * parsed, and the first assertion is that it still carries its path: a parser that stripped it
 * would make every later assertion pass for the wrong reason.
 *
 * NOTE: no `.rejects` / `.resolves` (Bun-on-Windows deadlock, see Known Issues).
 */

let app: Elysia
let orgId: string
let token: string
let root: string
const was = { dir: config.upload.dir, ocr: config.ocr.serverUrl }

const signer = new Elysia().use(jwt({ name: 'jwt', secret: config.jwt.secret }))

/** `/` works on every platform. `\` is a separator only to Windows, where the old code ran on the desktop. */
const HOSTILE = [
  'x/../../../../escaped-posix.txt',
  '../../../../escaped-into-uploads.txt',
  'x\\..\\..\\..\\..\\escaped-win.txt',
]

beforeAll(async () => {
  await setupTestDB()
  // Deep enough that, before the fix, every payload lands INSIDE `root`, where this file sees it
  // and cleans it up, rather than in the OS temp directory.
  root = mkdtempSync(join(tmpdir(), 'lgr-upload-names-'))
  config.upload.dir = join(root, 'a', 'b', 'uploads')
  mkdirSync(config.upload.dir, { recursive: true })
  // Nothing listens there: the bill path's OCR call fails at once, and the upload is still stored.
  ;(config.ocr as any).serverUrl = 'http://127.0.0.1:9'
  app = new Elysia().use(createApiApp())
  const org = await createTestOrg({ slug: 'upload-names' } as any)
  orgId = String(org._id)
  const user = await createTestUser(org._id, { role: 'admin' } as any)
  token = await (signer as any).decorator.jwt.sign({
    id: String(user._id), orgId, role: 'admin', email: 'a@upload-names.test', username: 'a', firstName: 'A', lastName: 'A',
    permissions: DEFAULT_ROLE_PERMISSIONS.admin, ownRecordsModules: [],
  })
}, 120_000)

afterAll(async () => {
  config.upload.dir = was.dir
  ;(config.ocr as any).serverUrl = was.ocr
  rmSync(root, { recursive: true, force: true })
  await teardownTestDB()
})

/** One part per name, written by hand: `FormData` is not trusted to keep the path. */
function multipart(names: string[]): { body: string; type: string } {
  const boundary = 'lgr-upload-names-boundary'
  const parts = names.map(n =>
    `--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="${n}"\r\n`
    + `Content-Type: text/plain\r\n\r\nnot a document\r\n`)
  return { body: parts.join('') + `--${boundary}--\r\n`, type: `multipart/form-data; boundary=${boundary}` }
}

function filesUnder(dir: string): string[] {
  const out: string[] = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) out.push(...filesUnder(p))
    else out.push(resolve(p))
  }
  return out
}

const ENDPOINTS: Array<[module: string, path: () => string]> = [
  ['bill-ocr', () => `/api/org/${orgId}/bills/import/extract`],
  ['doc-import', () => `/api/org/${orgId}/doc-import/extract`],
]

describe('an upload is written inside its own directory, whatever it is called', () => {
  for (const [module, path] of ENDPOINTS) {
    it(`${module}: no part is written outside <org>/${module}`, async () => {
      const { body, type } = multipart(HOSTILE)
      const res = await app.handle(new Request(`http://localhost${path()}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': type },
        body,
      }))
      expect(res.status).toBe(200)
      const out = await res.json() as { files: Array<{ fileId: string; filename: string }> }

      // The control: the server parsed every name WITH its path.
      expect(out.files.map(f => f.filename)).toEqual(HOSTILE)

      const allowed = new Set(ENDPOINTS.map(([m]) => resolve(config.upload.dir, orgId, m)))
      expect(filesUnder(root).filter(f => !allowed.has(dirname(f)))).toEqual([])

      const own = resolve(config.upload.dir, orgId, module)
      const rows = await FileModel.find({ orgId, module }).lean()
      expect(rows.length).toBe(HOSTILE.length)
      for (const r of rows) expect(dirname(resolve(String(r.storagePath)))).toBe(own)
      // Each part is its own file: none overwrote another.
      expect(new Set(rows.map(r => String(r.storagePath))).size).toBe(HOSTILE.length)
    }, 60_000)
  }
})
