/**
 * FR-13.58 (#24) — object storage as the tier-3 destination Drive cannot be.
 *
 * ⚠ Unit, not integration, and for the same reason as `backup-drive.test.ts`: every behaviour
 * worth protecting is a decision about a REMOTE that must not be reached from a test — what
 * gets signed, what is sent under an Object Lock, that a sealed artifact and never a plaintext
 * one leaves, that a read-back mismatch is a FAILURE rather than a copy, and that retention
 * never runs against locked objects. `fetch` is stubbed; nothing here touches a bucket.
 *
 * ⚠ What these tests deliberately do NOT prove: that the signature is one a real S3 accepts.
 * No offline test can — that is what `scripts/backup-s3-smoke.ts` is for, and it must be run
 * against the real endpoint before the destination is trusted.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { config } from 'config'
import { generateBackupKeyPair, readSealedHeader, unsealBundle } from 'services/biz/backup/backup-crypto'
import { signS3Request, putObject, getObject, listObjects, deleteObject, S3Error } from 'services/biz/backup/s3-client'
import {
  pushBundleToS3, pushToDestinations, pushArchiveToDestinations,
  s3Configured, s3Enabled, s3SkipReason, s3KeyFor, DRIVE_SECTION,
} from 'services/biz/backup/backup-destinations.service'

const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex')

const CFG = {
  endpoint: 'https://s3.eu-central-003.example.com',
  region: 'eu-central-003',
  bucket: 'lgr-backups',
  accessKeyId: 'AKIAEXAMPLE',
  secretAccessKey: 'secret-example',
  forcePathStyle: true,
}

// ── A scriptable fetch, same harness as the Drive suite ─────────────────────
type Handler = (url: string, init: any) => Response | Promise<Response> | undefined
let handlers: Handler[] = []
let calls: { url: string; init: any; method: string }[] = []
const realFetch = globalThis.fetch

function installFetch() {
  calls = []
  globalThis.fetch = (async (input: any, init: any = {}) => {
    const url = typeof input === 'string' ? input : input.url
    calls.push({ url, init, method: init?.method || 'GET' })
    for (const h of handlers) {
      const r = await h(url, init)
      if (r) return r
    }
    throw new Error(`unstubbed fetch: ${init?.method || 'GET'} ${url}`)
  }) as any
}

describe('SigV4 signing (FR-13.58)', () => {
  it('signs host, x-amz-date and the payload hash, and nothing else', () => {
    const body = Buffer.from('payload')
    const { headers } = signS3Request(CFG, 'PUT', 'a/b.zst', {}, body, { 'content-type': 'application/octet-stream' })

    expect(headers.authorization).toContain('AWS4-HMAC-SHA256 Credential=AKIAEXAMPLE/')
    expect(headers.authorization).toContain('/eu-central-003/s3/aws4_request')
    expect(headers.authorization).toContain('SignedHeaders=host;x-amz-content-sha256;x-amz-date')
    // `content-type` is sent but NOT signed: every signed header is one more thing a proxy can
    // rewrite into an opaque SignatureDoesNotMatch, and it cannot change what the request does.
    expect(headers.authorization).not.toContain('content-type')
    expect(headers['x-amz-content-sha256']).toBe(sha256(body))
  })

  it('signs every x-amz-* header it is given — the object lock rides on those', () => {
    const { headers } = signS3Request(CFG, 'PUT', 'k', {}, Buffer.from('x'), {
      'x-amz-object-lock-mode': 'COMPLIANCE',
      'x-amz-object-lock-retain-until-date': '2036-01-01T00:00:00Z',
    })
    const signed = /SignedHeaders=([^,]+)/.exec(headers.authorization)![1]
    expect(signed).toContain('x-amz-object-lock-mode')
    expect(signed).toContain('x-amz-object-lock-retain-until-date')
  })

  it('percent-encodes the characters encodeURIComponent leaves alone', () => {
    // `!'()*` survive encodeURIComponent and would make the canonical path disagree with what
    // the server reconstructs — one opaque SignatureDoesNotMatch per artifact whose org slug
    // happens to contain one.
    const { url } = signS3Request(CFG, 'PUT', "lgr/o'brien (1)!.zst", {}, Buffer.from('x'))
    expect(url).toContain('%27')
    expect(url).toContain('%28')
    expect(url).toContain('%21')
    expect(url).not.toContain("'")
  })

  it('addresses path-style by default and virtual-host on request', () => {
    expect(signS3Request(CFG, 'GET', 'k', {}, undefined).url)
      .toBe('https://s3.eu-central-003.example.com/lgr-backups/k')
    expect(signS3Request({ ...CFG, forcePathStyle: false }, 'GET', 'k', {}, undefined).url)
      .toBe('https://lgr-backups.s3.eu-central-003.example.com/k')
  })

  it('sorts the query string, because the signature is over the sorted form', () => {
    const { url } = signS3Request(CFG, 'GET', '', { prefix: 'a/', 'list-type': '2' }, undefined)
    expect(url.split('?')[1]).toBe('list-type=2&prefix=a%2F')
  })
})

describe('the S3 client', () => {
  beforeEach(() => { handlers = []; installFetch() })
  afterEach(() => { globalThis.fetch = realFetch })

  it('never sends the host header it signed', async () => {
    // `host` is forbidden for fetch — sending it is dropped or rejected depending on runtime.
    handlers = [() => new Response('', { status: 200 })]
    await putObject(CFG, 'k', Buffer.from('x'))
    expect(calls[0].init.headers.host).toBeUndefined()
    expect(calls[0].init.headers.authorization).toContain('host;')
  })

  it('sends object-lock headers only when a mode is configured', async () => {
    handlers = [() => new Response('', { status: 200 })]

    await putObject(CFG, 'k', Buffer.from('x'))
    expect(calls[0].init.headers['x-amz-object-lock-mode']).toBeUndefined()

    const put = await putObject(CFG, 'k', Buffer.from('x'), { lock: { mode: 'COMPLIANCE', years: 10 } })
    expect(calls[1].init.headers['x-amz-object-lock-mode']).toBe('COMPLIANCE')
    // A bucket without Object Lock answers 400 to these headers, so "always send them" would
    // break every deployment that has not turned the feature on.
    const until = new Date(calls[1].init.headers['x-amz-object-lock-retain-until-date'])
    expect(until.getUTCFullYear()).toBe(new Date().getUTCFullYear() + 10)
    expect(put.retainUntil).toBeTruthy()
  })

  it('strips newlines out of metadata values — they become signed headers', async () => {
    handlers = [() => new Response('', { status: 200 })]
    await putObject(CFG, 'k', Buffer.from('x'), { metadata: { note: 'a\nx-amz-evil: 1' } })
    expect(calls[0].init.headers['x-amz-meta-note']).toBe('a x-amz-evil: 1')
  })

  it('reports the service’s own error code and never the request', async () => {
    handlers = [() => new Response(
      '<Error><Code>SignatureDoesNotMatch</Code><Message>bad region</Message></Error>',
      { status: 403 },
    )]
    try {
      await getObject(CFG, 'k')
      throw new Error('expected a throw')
    } catch (e: any) {
      expect(e).toBeInstanceOf(S3Error)
      expect(e.code).toBe('SignatureDoesNotMatch')
      expect(e.message).toContain('bad region')
      expect(e.message).not.toContain('Signature=')
    }
  })

  it('follows continuation tokens and unescapes keys', async () => {
    let page = 0
    handlers = [() => new Response(page++ === 0
      ? '<ListBucketResult><Contents><Key>a&amp;b.zst</Key><Size>10</Size></Contents>' +
        '<IsTruncated>true</IsTruncated><NextContinuationToken>t1</NextContinuationToken></ListBucketResult>'
      : '<ListBucketResult><Contents><Key>c.zst</Key><Size>20</Size></Contents>' +
        '<IsTruncated>false</IsTruncated></ListBucketResult>', { status: 200 })]

    const got = await listObjects(CFG, 'p/')
    // An un-unescaped `&amp;` would produce a delete for an object that does not exist — a
    // retention pass that silently keeps everything.
    expect(got.map(o => o.key)).toEqual(['a&b.zst', 'c.zst'])
    expect(calls[1].url).toContain('continuation-token=t1')
  })
})

describe('the object-storage destination', () => {
  let dir = ''
  let bundlePath = ''
  const plain = Buffer.from('{"format":"lgr-backup-1"}\n{"$collection":"Invoice"}\n{"secret":"tax-id"}\n')
  const saved = JSON.parse(JSON.stringify({ s3: config.backup.s3, key: config.backup.encryptionPublicKey }))
  const keys = generateBackupKeyPair()

  const manifest: any = {
    format: 'lgr-backup-1', orgId: 'org1', orgSlug: 'regal-pz', orgName: 'Regal',
    kind: 'full', date: '2026-09-15', createdAt: new Date().toISOString(),
    schemaVersion: 'lgr-backup-1', appImageTag: 'v1', documentCount: 2, collections: [],
  }
  const opts = () => ({
    orgId: 'org1', manifest, absolutePath: bundlePath,
    filename: 'lgr-regal-pz-full-2026-09-15.ndjson.zst', sha256: sha256(plain),
  })

  beforeEach(() => {
    handlers = []
    installFetch()
    dir = mkdtempSync(join(tmpdir(), 'lgr-s3-'))
    bundlePath = join(dir, 'bundle.ndjson.zst')
    writeFileSync(bundlePath, plain)
    Object.assign(config.backup.s3, {
      ...CFG, prefix: 'lgr', scope: 'archive', keep: 0,
      objectLockMode: '', objectLockYears: 10,
    })
    config.backup.encryptionPublicKey = keys.publicKey
  })
  afterEach(() => {
    globalThis.fetch = realFetch
    rmSync(dir, { recursive: true, force: true })
    Object.assign(config.backup.s3, saved.s3)
    config.backup.encryptionPublicKey = saved.key
  })

  it('is absent, not "skipped", when nothing is configured', async () => {
    Object.assign(config.backup.s3, { endpoint: '', bucket: '' })
    expect(s3Configured()).toBe(false)
    // A permanent "not configured" line in every digest of every Drive-only deployment teaches
    // people to skim the section. The missing copy is already its own banner.
    expect(s3SkipReason()).toBeNull()
    expect(await pushBundleToS3(opts() as any)).toBeNull()
  })

  it('refuses to upload anything unsealed', async () => {
    config.backup.encryptionPublicKey = ''
    expect(s3Enabled()).toBe(false)
    const res = await pushBundleToS3(opts() as any)
    expect(res!.status).toBe('skipped')
    expect(res!.reason).toContain('unsealed')
    expect(calls.length).toBe(0)
  })

  it('uploads the SEALED bytes — the plaintext never reaches the wire', async () => {
    let body: Buffer | undefined
    handlers = [(_u, init) => { body = Buffer.from(init.body); return new Response('', { status: 200, headers: { etag: '"e1"' } }) }]

    const res = await pushBundleToS3(opts() as any)
    expect(res!.status).toBe('reached')
    expect(body!.includes(plain)).toBe(false)
    // …and the operator, holding the private half off-cluster, can still open it.
    expect(readSealedHeader(body!).recipient).toBe(keys.publicKey)
    expect(unsealBundle(body!, keys.privateKey).equals(plain)).toBe(true)
    expect(res!.sha256).toBe(sha256(body!))
  })

  it('mirrors the Drive tree in the key, section above the org', async () => {
    expect(s3KeyFor({ ...opts(), section: DRIVE_SECTION.archive } as any))
      .toBe('lgr/Archive/regal-pz/full/lgr-regal-pz-full-2026-09-15.ndjson.zst.sealed')
    expect(s3KeyFor(opts() as any)).toContain('lgr/Backups/regal-pz/full/')
  })

  it('a read-back mismatch is a FAILURE, never a copy', async () => {
    handlers = [
      (_u, init) => init.method === 'PUT' ? new Response('', { status: 200 }) : undefined,
      (_u, init) => init.method === 'GET' ? new Response(Buffer.from('not what was sent')) : undefined,
    ]
    const res = await pushBundleToS3({ ...opts(), verify: true } as any)
    // "The API returned 200" is not "the bytes are there" — §1.1's whole cautionary tale.
    expect(res!.status).toBe('failed')
    expect(res!.verified).toBe(false)
  })

  it('never prunes an archive, whatever keep the Drive push was given', async () => {
    Object.assign(config.backup.s3, { keep: 1 })
    handlers = [(_u, init) => init.method === 'PUT' ? new Response('', { status: 200 }) : undefined]
    const res = await pushBundleToS3({ ...opts(), section: DRIVE_SECTION.archive, keep: 10 } as any)
    expect(res!.status).toBe('reached')
    // Ten years is not a rotation: a generation count borrowed from the working copy would
    // delete a fiscal year from the legal one.
    expect(calls.every(c => c.method !== 'DELETE')).toBe(true)
  })

  it('never prunes under an object lock — the delete would be refused anyway', async () => {
    Object.assign(config.backup.s3, { keep: 1, objectLockMode: 'COMPLIANCE' })
    handlers = [(_u, init) => init.method === 'PUT' ? new Response('', { status: 200 }) : undefined]
    const res = await pushBundleToS3(opts() as any)
    expect(res!.status).toBe('reached')
    expect(res!.reason).toContain('COMPLIANCE')
    expect(calls.every(c => c.method === 'PUT')).toBe(true)
  })

  it('prunes by counted generations when it is allowed to', async () => {
    Object.assign(config.backup.s3, { keep: 2 })
    const deleted: string[] = []
    handlers = [
      (_u, init) => init.method === 'PUT' ? new Response('', { status: 200 }) : undefined,
      (u, init) => init.method === 'GET' && u.includes('list-type')
        ? new Response('<ListBucketResult>' +
          ['2026-09-13', '2026-09-14', '2026-09-15', '2026-09-12'].map(d =>
            `<Contents><Key>lgr/Backups/regal-pz/full/lgr-regal-pz-full-${d}.ndjson.zst.sealed</Key><Size>1</Size></Contents>`).join('') +
          '<IsTruncated>false</IsTruncated></ListBucketResult>')
        : undefined,
      (u, init) => { if (init.method === 'DELETE') { deleted.push(u); return new Response('', { status: 204 }) } },
    ]

    const res = await pushBundleToS3(opts() as any)
    expect(res!.prunedCount).toBe(2)
    // Counted, never aged, and lexical order IS chronological within one org and kind — so the
    // two OLDEST go and a run of failed nights can never remove the last good copy.
    expect(deleted.join(' ')).toContain('2026-09-12')
    expect(deleted.join(' ')).toContain('2026-09-13')
    expect(deleted.join(' ')).not.toContain('2026-09-15')
  })

  it('an upload failure is a recorded gap, not a thrown error', async () => {
    handlers = [() => new Response('<Error><Code>AccessDenied</Code><Message>no</Message></Error>', { status: 403 })]
    const res = await pushBundleToS3(opts() as any)
    // A run whose bundle is built, verified and on the PV is a completed run.
    expect(res!.status).toBe('failed')
    expect(res!.reason).toContain('AccessDenied')
  })
})

describe('which destinations a run attempts', () => {
  const saved = JSON.parse(JSON.stringify(config.backup.s3))
  let dir = ''

  beforeEach(() => {
    handlers = []
    installFetch()
    dir = mkdtempSync(join(tmpdir(), 'lgr-s3d-'))
    writeFileSync(join(dir, 'b.zst'), 'x')
    Object.assign(config.backup.s3, { ...CFG, prefix: 'lgr', scope: 'archive', keep: 0, objectLockMode: '' })
    config.backup.encryptionPublicKey = ''
    Object.assign(config.backup.googleDrive, { refreshToken: '' })
  })
  afterEach(() => {
    globalThis.fetch = realFetch
    rmSync(dir, { recursive: true, force: true })
    Object.assign(config.backup.s3, saved)
  })

  const opts = () => ({
    orgId: 'org1', absolutePath: join(dir, 'b.zst'), filename: 'b.zst', sha256: 'x',
    manifest: { format: 'lgr-backup-1', orgSlug: 'o', kind: 'full', date: '2026-09-15', documentCount: 0, appImageTag: 'v1' },
  })

  it('leaves the nightly bundle out of object storage unless scope is `all`', async () => {
    // Default `archive`: write-once retention applied to a 14-generation rotation is a bill,
    // not a policy.
    const nightly = await pushToDestinations(opts() as any)
    expect(nightly.map(d => d.name)).toEqual(['google_drive'])

    Object.assign(config.backup.s3, { scope: 'all' })
    expect((await pushToDestinations(opts() as any)).map(d => d.name)).toEqual(['google_drive', 's3'])
  })

  it('an archive attempts BOTH tiers — they are not a fallback chain', async () => {
    const res = await pushArchiveToDestinations({ ...opts(), section: DRIVE_SECTION.archive } as any)
    expect(res.map(d => d.name)).toEqual(['google_drive', 's3'])
    // Drive is unconfigured here and object storage is unsealed: both report why, and neither
    // silently stands in for the other.
    expect(res.every(d => d.status === 'skipped')).toBe(true)
  })
})
