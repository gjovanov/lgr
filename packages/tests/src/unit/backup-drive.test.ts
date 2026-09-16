/**
 * FR-13.48–13.59 (#24) — the Google Drive destination.
 *
 * ⚠ Unit, not integration, and that is on purpose: every behaviour worth protecting here is a
 * decision about a REMOTE that must not be reached from a test — the resumable chunking, the
 * distinction between a dead refresh token and a network blip, the quota refusal, and above
 * all the rule that a partial upload is never recorded as a destination reached. `fetch` is
 * stubbed; nothing here touches Google, Mongo or the network.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { captureRejection, expectRejection } from '../helpers/capture-rejection'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { config } from 'config'
import {
  generateBackupKeyPair, sealBundle, unsealBundle, readSealedHeader,
  SEALED_FORMAT, PUBLIC_KEY_PREFIX,
} from 'services/biz/backup/backup-crypto'
import {
  googleDriveAdapter, refreshGoogleAccessToken, CloudReconsentRequired,
  dropboxAdapter, onedriveAdapter, GOOGLE_DRIVE_SCOPE,
} from 'services/biz/cloud-storage.service'
import {
  pushBundleToDrive, pruneDriveGenerations, remoteArtifactName, driveEnabled, driveRootFolder,
} from 'services/biz/backup/backup-destinations.service'

const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex')

// ── A scriptable fetch ──────────────────────────────────────────────────────
// Each handler matches on the URL and returns a Response. Unmatched calls fail loudly rather
// than returning something plausible — a test that silently talks to a default is worse than
// one that fails.
type Handler = (url: string, init: any) => Response | Promise<Response> | undefined
let handlers: Handler[] = []
let calls: { url: string; init: any }[] = []
const realFetch = globalThis.fetch

function installFetch() {
  calls = []
  globalThis.fetch = (async (input: any, init: any = {}) => {
    const url = typeof input === 'string' ? input : input.url
    calls.push({ url, init })
    for (const h of handlers) {
      const r = await h(url, init)
      if (r) return r
    }
    throw new Error(`unstubbed fetch: ${url}`)
  }) as any
}

const json = (body: any, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

function tokenOk(): Handler {
  return url => url.includes('oauth2.googleapis.com/token')
    ? json({ access_token: 'at-1', expires_in: 3600 })
    : undefined
}

describe('backup sealing (FR-13.23/13.56)', () => {
  it('round-trips a bundle through the recipient key', () => {
    const { publicKey, privateKey } = generateBackupKeyPair()
    const plain = Buffer.from('{"format":"lgr-backup-1"}\n{"$collection":"Invoice"}\n')
    const sealed = sealBundle(plain, publicKey)

    expect(sealed.equals(plain)).toBe(false)
    expect(unsealBundle(sealed, privateKey).equals(plain)).toBe(true)
  })

  it('never produces the same bytes twice for the same input', () => {
    // A fresh ephemeral key per artifact is what makes the fixed IV safe. If this ever fails,
    // two artifacts share a content-encryption key and the IV reuse is a real break.
    const { publicKey } = generateBackupKeyPair()
    const plain = Buffer.from('same input')
    expect(sealBundle(plain, publicKey).equals(sealBundle(plain, publicKey))).toBe(false)
  })

  it('the header is readable WITHOUT the private key, and says what it is', () => {
    // An operator holding a sealed artifact has to be able to tell which key opens it and
    // what it contains, without holding that key.
    const { publicKey } = generateBackupKeyPair()
    const plain = Buffer.from('x'.repeat(500))
    const header = readSealedHeader(sealBundle(plain, publicKey))

    expect(header.format).toBe(SEALED_FORMAT)
    expect(header.recipient).toBe(publicKey)
    expect(header.plainBytes).toBe(500)
    expect(header.plainSha256).toBe(sha256(plain))
  })

  it('refuses the wrong identity', () => {
    const a = generateBackupKeyPair()
    const b = generateBackupKeyPair()
    const sealed = sealBundle(Buffer.from('secret'), a.publicKey)
    expect(() => unsealBundle(sealed, b.privateKey)).toThrow(/wrong identity|altered/)
  })

  it('refuses a PUBLIC key pasted where the identity belongs', () => {
    // The likely operator mistake, and it otherwise surfaces as an opaque DER parse error.
    const { publicKey } = generateBackupKeyPair()
    const sealed = sealBundle(Buffer.from('x'), publicKey)
    expect(() => unsealBundle(sealed, publicKey)).toThrow(/PUBLIC key/)
  })

  it('detects a flipped ciphertext byte', () => {
    const { publicKey, privateKey } = generateBackupKeyPair()
    const sealed = sealBundle(Buffer.from('x'.repeat(200)), publicKey)
    sealed[sealed.length - 5] ^= 0x01
    expect(() => unsealBundle(sealed, privateKey)).toThrow()
  })

  it('detects a REWRITTEN HEADER — the header is authenticated, not merely descriptive', () => {
    // Without the header as AAD, an attacker could swap `plainSha256` so a tampered artifact
    // presented itself as a different, valid one.
    const { publicKey, privateKey } = generateBackupKeyPair()
    const sealed = sealBundle(Buffer.from('payload'), publicKey)
    const nl = sealed.indexOf(0x0a)
    const header = JSON.parse(sealed.subarray(0, nl).toString('utf8'))
    header.plainSha256 = 'deadbeef'
    const forged = Buffer.concat([Buffer.from(JSON.stringify(header) + '\n'), sealed.subarray(nl + 1)])
    expect(() => unsealBundle(forged, privateKey)).toThrow()
  })

  it('rejects a recipient that is not one of ours', () => {
    expect(() => sealBundle(Buffer.from('x'), 'age1abcdef')).toThrow(new RegExp(PUBLIC_KEY_PREFIX))
  })
})

describe('google drive adapter (FR-13.51–13.54)', () => {
  beforeEach(() => { handlers = []; installFetch() })
  afterEach(() => { globalThis.fetch = realFetch })

  it('asks for drive.file — the scope that can write without reading everything else', () => {
    // `drive.readonly` (the previous value) cannot write at all; full `drive` would let a
    // leaked token read the account's other documents.
    expect(GOOGLE_DRIVE_SCOPE).toBe('https://www.googleapis.com/auth/drive.file')
    config.integrations.google.clientId = 'cid'
    config.integrations.google.redirectUri = 'https://lgrai.app/api/org/{orgId}/integration/google-drive/callback'
    const url = googleDriveAdapter.getAuthUrl('org-1')
    expect(url).toContain(encodeURIComponent(GOOGLE_DRIVE_SCOPE))
    expect(url).toContain('access_type=offline')
    // Without `prompt=consent` a second consent returns no refresh token at all.
    expect(url).toContain('prompt=consent')
    // The orgId rides in the redirect URI — `handleCallback` has no other way to know it.
    expect(decodeURIComponent(url)).toContain('/org/org-1/integration/google-drive/callback')
  })

  it('turns invalid_grant into a re-consent signal, not a generic failure', async () => {
    // ⚠ The distinction the whole destination hangs on: a transport error is worth retrying
    // tonight, `invalid_grant` fails identically every night until a human acts (FR-13.54).
    handlers = [url => url.includes('/token')
      ? new Response('{"error":"invalid_grant"}', { status: 400 })
      : undefined]
    config.integrations.google.clientId = 'cid'
    config.integrations.google.clientSecret = 'sec'
    expectRejection(await captureRejection(refreshGoogleAccessToken('dead-token')), CloudReconsentRequired)
  })

  it('a transport failure is NOT a re-consent signal', async () => {
    handlers = [url => url.includes('/token')
      ? new Response('upstream exploded', { status: 503 })
      : undefined]
    config.integrations.google.clientId = 'cid'
    config.integrations.google.clientSecret = 'sec'
    let caught: any
    try { await refreshGoogleAccessToken('t') } catch (e) { caught = e }
    expect(caught).toBeDefined()
    expect(caught instanceof CloudReconsentRequired).toBe(false)
  })

  it('uploads resumably, and resumes from the Range the server reports', async () => {
    // ⚠ Resumable at EVERY size. Google's simple/multipart uploads cap at 5 MB; today's
    // bundle is 3.2 MiB, so a multipart implementation works right up until it silently
    // stops working inside year 1 (FR-13.52).
    const content = Buffer.alloc(1000, 7)
    let put = 0
    handlers = [
      tokenOk(),
      (url, init) => {
        if (url.includes('uploadType=resumable') && init.method === 'POST') {
          return new Response('', { status: 200, headers: { location: 'https://upload/session-1' } })
        }
        if (url === 'https://upload/session-1') {
          put++
          if (put === 1) {
            // Google accepted only the first 400 bytes.
            return new Response('', { status: 308, headers: { range: 'bytes=0-399' } })
          }
          return json({ id: 'file-1', name: 'b.sealed', size: String(content.length), modifiedTime: new Date().toISOString() })
        }
        return undefined
      },
    ]

    const out = await googleDriveAdapter.uploadFile(
      { accessToken: 'at', refreshToken: 'rt' }, 'folder-1', 'b.sealed', content,
    )
    expect(out.id).toBe('file-1')
    expect(put).toBe(2)
    // The second PUT must start where the server said it stopped, not where we thought.
    const second = calls.filter(c => c.url === 'https://upload/session-1')[1]
    expect(second.init.headers['Content-Range']).toBe('bytes 400-999/1000')
  })

  it('THROWS on a partial upload rather than returning what it managed to write', async () => {
    // ⚠ The single most important assertion in this file. A success-shaped return here is
    // recorded as `status: 'reached'`, i.e. "an off-site copy exists" — and the place that
    // gets discovered is a restore.
    handlers = [
      tokenOk(),
      (url, init) => {
        if (url.includes('uploadType=resumable') && init.method === 'POST') {
          return new Response('', { status: 200, headers: { location: 'https://upload/s2' } })
        }
        if (url === 'https://upload/s2') return new Response('quota', { status: 403 })
        return undefined
      },
    ]
    expectRejection(await captureRejection(googleDriveAdapter.uploadFile(
      { accessToken: 'at', refreshToken: 'rt' }, 'f', 'b.sealed', Buffer.alloc(10),
    )), /failed at byte 0 with 403/)
  })

  it('gives up rather than looping when the server stops making progress', async () => {
    handlers = [
      tokenOk(),
      (url, init) => {
        if (url.includes('uploadType=resumable') && init.method === 'POST') {
          return new Response('', { status: 200, headers: { location: 'https://upload/s3' } })
        }
        // A 308 with no Range at byte 0 means "still nothing" — retrying forever is not a
        // recovery strategy, it is a hung nightly job.
        if (url === 'https://upload/s3') return new Response('', { status: 308 })
        return undefined
      },
    ]
    expectRejection(await captureRejection(googleDriveAdapter.uploadFile(
      { accessToken: 'at', refreshToken: 'rt' }, 'f', 'b.sealed', Buffer.alloc(10),
    )), /stopped making progress/)
  })

  it('finds a folder before creating one, and creates only what is missing', async () => {
    const created: string[] = []
    handlers = [
      tokenOk(),
      (url, init) => {
        if (url.includes('/files?') && (!init.method || init.method === 'GET')) {
          // The "LGR" root exists; the org folder does not. ⚠ `URLSearchParams` encodes the
          // spaces in the `q=` expression as `+`, so matching on a decoded literal with real
          // spaces never fires — which is exactly what this stub got wrong first.
          return json({ files: /name\+%3D\+%27LGR%27/.test(url) ? [{ id: 'root-folder' }] : [] })
        }
        if (url.includes('/files?fields=id') && init.method === 'POST') {
          const name = JSON.parse(init.body).name
          created.push(name)
          return json({ id: `new-${name}` })
        }
        return undefined
      },
    ]
    const id = await googleDriveAdapter.ensureFolder(
      { accessToken: 'at', refreshToken: 'rt' }, ['LGR', 'regal-pz', 'full'],
    )
    expect(created).toEqual(['regal-pz', 'full'])
    expect(id).toBe('new-full')
  })

  it('refuses a folder path that would resolve to My Drive root', async () => {
    // ⚠ An empty path returns `'root'`, and the caller would then upload beside everything
    // else in the account — outside the one folder this application owns. The upload never
    // gets a chance to be contained if the folder resolution is not (FR-13.56).
    handlers = [tokenOk()]
    const tokens = { accessToken: 'at', refreshToken: 'rt' }
    expectRejection(await captureRejection(googleDriveAdapter.ensureFolder(tokens, [])), /refusing to resolve/)
    expectRejection(await captureRejection(googleDriveAdapter.ensureFolder(tokens, [''])), /refusing to resolve/)
    expectRejection(await captureRejection(googleDriveAdapter.ensureFolder(tokens, ['LGR/regal-pz'])), /single segment/)
  })

  it('treats an absent storage limit as UNLIMITED, not as zero', async () => {
    // ⚠ Workspace accounts report no `limit`. Reading that as 0 would make the pre-flight
    // refuse every upload against a Drive with room for all of them.
    handlers = [tokenOk(), url => url.includes('storageQuota') ? json({ storageQuota: { usage: '5' } }) : undefined]
    const q = await googleDriveAdapter.getQuota({ accessToken: 'at', refreshToken: 'rt' })
    expect(q.total).toBeUndefined()
    expect(q.free).toBeUndefined()
  })

  it('tolerates deleting a file that is already gone', async () => {
    handlers = [tokenOk(), () => new Response('not found', { status: 404 })]
    await googleDriveAdapter.deleteFile({ accessToken: 'at', refreshToken: 'rt' }, 'gone')
  })

  it('the Dropbox and OneDrive stubs THROW on writes instead of faking success', async () => {
    // They gained these signatures because the interface is shared. Returning an empty
    // success value would let a caller record a destination that stored nothing.
    //
    // ⚠ This test asserted NOTHING until 2026-09-15: the callback was not `async` and neither
    // `expect(...).rejects` was awaited, so both promises floated and the body could not fail.
    // It would have passed just as green if the stubs had quietly returned success — which is
    // the exact scenario it exists to rule out.
    for (const a of [dropboxAdapter, onedriveAdapter]) {
      expectRejection(
        await captureRejection(a.uploadFile({ accessToken: '', refreshToken: '' }, 'f', 'n', Buffer.alloc(0))),
        /not implemented/,
      )
      expectRejection(await captureRejection(a.getQuota({ accessToken: '', refreshToken: '' })), /not implemented/)
    }
  })
})

describe('the drive destination (FR-13.57/13.59)', () => {
  let dir: string
  let bundlePath: string
  const manifest: any = {
    format: 'lgr-backup-1', orgId: 'o1', orgSlug: 'regal-pz', orgName: 'Regal',
    kind: 'full', date: '2026-09-09', createdAt: new Date().toISOString(),
    schemaVersion: 'lgr-backup-1', appImageTag: 'v1', documentCount: 42, collections: [],
  }
  const saved = JSON.parse(JSON.stringify({
    gd: config.backup.googleDrive, key: config.backup.encryptionPublicKey,
  }))

  beforeEach(() => {
    handlers = []; installFetch()
    dir = mkdtempSync(join(tmpdir(), 'lgr-drive-'))
    bundlePath = join(dir, 'lgr-regal-pz-full-2026-09-09.ndjson.zst')
    writeFileSync(bundlePath, Buffer.alloc(2048, 3))
    config.backup.googleDrive.refreshToken = 'rt'
    config.backup.googleDrive.clientId = 'cid'
    config.backup.googleDrive.clientSecret = 'sec'
    config.backup.googleDrive.folderName = 'LGR'
    config.backup.encryptionPublicKey = generateBackupKeyPair().publicKey
  })
  afterEach(() => {
    globalThis.fetch = realFetch
    rmSync(dir, { recursive: true, force: true })
    Object.assign(config.backup.googleDrive, saved.gd)
    config.backup.encryptionPublicKey = saved.key
  })

  const push = (verify = false) => pushBundleToDrive({
    orgId: 'o1', manifest, absolutePath: bundlePath,
    filename: 'lgr-regal-pz-full-2026-09-09.ndjson.zst',
    sha256: 'abc', verify, keep: 2,
  })

  function driveHappyPath(uploaded: Buffer[] = [], existing: any[] = []) {
    handlers = [
      tokenOk(),
      (url, init) => {
        if (url.includes('storageQuota')) return json({ storageQuota: { limit: String(15e9), usage: '0' } })
        if (url.includes('/files?') && (!init.method || init.method === 'GET')) {
          return json({ files: url.includes('mimeType') ? [{ id: 'folder-1' }] : existing })
        }
        if (url.includes('uploadType=resumable') && init.method === 'POST') {
          return new Response('', { status: 200, headers: { location: 'https://upload/s' } })
        }
        if (url === 'https://upload/s') {
          uploaded.push(Buffer.from(init.body))
          return json({ id: 'file-1', name: 'x', size: String(init.body.length) })
        }
        if (url.includes('alt=media')) return new Response(uploaded[0] as any, { status: 200 })
        if (init.method === 'DELETE') return new Response('', { status: 204 })
        return undefined
      },
    ]
  }

  it('uploads a SEALED artifact — never the plaintext bundle', async () => {
    // FR-13.23/13.56: the bundle holds bcrypt hashes, tax IDs and the orgs collection.
    const uploaded: Buffer[] = []
    driveHappyPath(uploaded)
    const r = await push()

    expect(r.status).toBe('reached')
    expect(r.filename).toBe('lgr-regal-pz-full-2026-09-09.ndjson.zst.sealed')
    expect(uploaded).toHaveLength(1)
    expect(readSealedHeader(uploaded[0]).format).toBe(SEALED_FORMAT)
    // The plaintext must not appear anywhere in what went over the wire.
    expect(uploaded[0].includes(Buffer.alloc(2048, 3))).toBe(false)
    expect(r.sha256).toBe(sha256(uploaded[0]))
  })

  it('carries appProperties so the remote copy describes itself', async () => {
    // FR-13.59 — a listing has to answer "what is this and how old is it" without a download.
    driveHappyPath()
    await push()
    const start = calls.find(c => c.url.includes('uploadType=resumable') && c.init.method === 'POST')!
    const props = JSON.parse(start.init.body).appProperties
    expect(props.kind).toBe('full')
    expect(props.date).toBe('2026-09-09')
    expect(props.bundleSha256).toBe('abc')
    expect(props.documentCount).toBe('42')
  })

  it('refuses BEFORE transferring when the quota cannot hold it', async () => {
    handlers = [
      tokenOk(),
      url => url.includes('storageQuota') ? json({ storageQuota: { limit: '1000', usage: '900' } }) : undefined,
    ]
    const r = await push()
    expect(r.status).toBe('failed')
    expect(r.reason).toMatch(/free/)
    // Nothing was even attempted — that is the requirement, not an optimisation.
    expect(calls.some(c => c.url.includes('uploadType=resumable'))).toBe(false)
  })

  it('proceeds when the quota merely cannot be READ', async () => {
    // ⚠ Refusing to back up because a figure was unavailable would turn a missing number into
    // a missing backup.
    const uploaded: Buffer[] = []
    handlers = [
      tokenOk(),
      (url, init) => {
        if (url.includes('storageQuota')) return new Response('nope', { status: 500 })
        if (url.includes('/files?') && (!init.method || init.method === 'GET')) return json({ files: [{ id: 'f1' }] })
        if (url.includes('uploadType=resumable')) return new Response('', { status: 200, headers: { location: 'https://upload/s' } })
        if (url === 'https://upload/s') { uploaded.push(Buffer.from(init.body)); return json({ id: 'f' }) }
        return undefined
      },
    ]
    const r = await push()
    expect(r.status).toBe('reached')
    expect(r.reason).toMatch(/quota could not be read/)
  })

  it('reports reconsent_required, and does NOT count the destination as reached', async () => {
    handlers = [url => url.includes('/token') ? new Response('{"error":"invalid_grant"}', { status: 400 }) : undefined]
    const r = await push()
    expect(r.status).toBe('reconsent_required')
    expect(r.status).not.toBe('reached')
  })

  it('fails the destination when the artifact read back does not match', async () => {
    handlers = [
      tokenOk(),
      (url, init) => {
        if (url.includes('storageQuota')) return json({ storageQuota: { limit: String(15e9), usage: '0' } })
        if (url.includes('/files?') && (!init.method || init.method === 'GET')) return json({ files: [{ id: 'f1' }] })
        if (url.includes('uploadType=resumable')) return new Response('', { status: 200, headers: { location: 'https://upload/s' } })
        if (url === 'https://upload/s') return json({ id: 'file-1' })
        // What comes back is not what went up. An upload that returns 200 and stores nothing
        // readable is the roomler failure mode; listing the remote would never catch it.
        if (url.includes('alt=media')) return new Response(Buffer.from('corrupted') as any, { status: 200 })
        return undefined
      },
    ]
    const r = await push(true)
    expect(r.status).toBe('failed')
    expect(r.verified).toBe(false)
    expect(r.reason).toMatch(/read back/)
  })

  it('skips with a REASON when nothing is configured', async () => {
    config.backup.googleDrive.refreshToken = ''
    const r = await push()
    expect(r.status).toBe('skipped')
    expect(r.reason).toMatch(/not connected/)
    expect(driveEnabled()).toBe(false)
  })

  it('refuses to upload at all when there is no encryption recipient', async () => {
    // ⚠ Fatal to the upload, not a warning that ships plaintext anyway (FR-13.23).
    config.backup.encryptionPublicKey = ''
    const r = await push()
    expect(r.status).toBe('skipped')
    expect(r.reason).toMatch(/unsealed/)
    expect(calls).toHaveLength(0)
  })

  it('keeps N generations by name and deletes the OLDEST', async () => {
    const deleted: string[] = []
    handlers = [
      tokenOk(),
      (url, init) => {
        if (url.includes('/files?') && (!init.method || init.method === 'GET')) {
          return json({
            files: [
              { id: 'a', name: 'lgr-x-full-2026-09-01.ndjson.zst.sealed', mimeType: 'application/octet-stream' },
              { id: 'b', name: 'lgr-x-full-2026-09-02.ndjson.zst.sealed', mimeType: 'application/octet-stream' },
              { id: 'c', name: 'lgr-x-full-2026-09-03.ndjson.zst.sealed', mimeType: 'application/octet-stream' },
            ],
          })
        }
        if (init.method === 'DELETE') { deleted.push(url.split('/').pop()!); return new Response('', { status: 204 }) }
        return undefined
      },
    ]
    const removed = await pruneDriveGenerations({ accessToken: 'at', refreshToken: 'rt' }, 'folder', 2)
    expect(removed).toBe(1)
    expect(deleted).toEqual(['a'])
  })

  it('never empties the folder, whatever `keep` says', async () => {
    // ⚠ The scenario the counting rule exists for. A misconfigured 0 must not be able to
    // delete the last good copy — nor may a run of failed nights, which is why this is a
    // count and not an age.
    const deleted: string[] = []
    handlers = [
      tokenOk(),
      (url, init) => {
        if (url.includes('/files?') && (!init.method || init.method === 'GET')) {
          return json({ files: [{ id: 'only', name: 'lgr-x-full-2020-01-01.ndjson.zst.sealed', mimeType: 'application/octet-stream' }] })
        }
        if (init.method === 'DELETE') { deleted.push(url); return new Response('', { status: 204 }) }
        return undefined
      },
    ]
    expect(await pruneDriveGenerations({ accessToken: 'at', refreshToken: 'rt' }, 'folder', 0)).toBe(0)
    expect(deleted).toHaveLength(0)
  })

  it('puts the bundle under ONE owned root — LGR/Backups/<org>/<kind>, never Drive root', async () => {
    // ⚠ The assertion is on the folder CHAIN, not just the leaf. `LGR` is looked up in
    // `'root' in parents`, and every folder after it is looked up inside the previous one, so
    // a regression that dropped the root would still create `regal-pz` — in My Drive itself,
    // beside whatever else the connected account keeps there.
    const parents: string[] = []
    const names: string[] = []
    handlers = [
      tokenOk(),
      (url, init) => {
        if (url.includes('storageQuota')) return json({ storageQuota: { limit: String(15e9), usage: '0' } })
        if (url.includes('/files?') && (!init.method || init.method === 'GET') && url.includes('mimeType')) {
          return json({ files: [] })
        }
        if (url.includes('/files?fields=id') && init.method === 'POST') {
          const body = JSON.parse(init.body)
          names.push(body.name)
          parents.push(body.parents[0])
          return json({ id: `id-${body.name}` })
        }
        if (url.includes('uploadType=resumable')) {
          return new Response('', { status: 200, headers: { location: 'https://upload.test/session' } })
        }
        if (url === 'https://upload.test/session') {
          return json({ id: 'f1', name: 'x', size: '10', modifiedTime: new Date().toISOString() })
        }
        if (url.includes('/files?') && (!init.method || init.method === 'GET')) return json({ files: [] })
        return undefined
      },
    ]

    const out = await push()
    expect(out.status).toBe('reached')
    // ⚠ The SECTION sits above the org: `Backups/` and `Archive/` rotate on completely
    // different rules (14 kept generations against a ten-year legal retention), and the split
    // is what stops a prune — or a human tidying up — treating a fiscal year's only cold copy
    // as an old backup.
    expect(names).toEqual(['LGR', 'Backups', 'regal-pz', 'full'])
    expect(parents[0]).toBe('root')         // LGR hangs off My Drive root …
    expect(parents[1]).toBe('id-LGR')       // … and everything else hangs off LGR.
    expect(parents[2]).toBe('id-Backups')
    expect(parents[3]).toBe('id-regal-pz')
  })

  it('FAILS the destination rather than writing to Drive root when the folder is misconfigured', async () => {
    // An empty or slash-bearing folder name used to resolve to `'root'`. A backup that lands
    // in the wrong place while reporting success is worse than one that does not run.
    for (const bad of ['', '   ', '/', 'LGR/regal-pz']) {
      config.backup.googleDrive.folderName = bad
      expect(() => driveRootFolder()).toThrow(/My Drive root|single folder name/)
      handlers = [tokenOk(), () => json({ storageQuota: { limit: String(15e9), usage: '0' } })]
      const out = await push()
      expect(out.status).toBe('failed')
      expect(out.remoteId).toBeUndefined()
    }
  })

  it('names the remote artifact after the local one, plus the seal', () => {
    // FR-13.59: type and timestamp stay in the name, so `lsl` alone is a readable inventory.
    expect(remoteArtifactName('lgr-regal-pz-delta-2026-09-09.ndjson.zst'))
      .toBe('lgr-regal-pz-delta-2026-09-09.ndjson.zst.sealed')
  })
})
