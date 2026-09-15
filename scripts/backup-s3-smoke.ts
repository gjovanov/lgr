#!/usr/bin/env bun
/**
 * FR-13.58 (#24) — prove a real object-storage bucket works, without the app.
 *
 * The sibling of `backup-drive-smoke.ts`, and it exists for the same reason: the unit tests
 * stub `fetch` and prove the LOGIC (signing, sealing, read-back, retention), which says nothing
 * about whether *your* bucket, *your* keys and *your* endpoint work together. This talks to the
 * real endpoint and touches nothing else, so a failure has exactly one possible cause.
 *
 *   bun --env-file=.env scripts/backup-s3-smoke.ts
 *   bun --env-file=.env scripts/backup-s3-smoke.ts --large        # 8 MB
 *   bun --env-file=.env scripts/backup-s3-smoke.ts --keep         # leave the object behind
 *   bun --env-file=.env scripts/backup-s3-smoke.ts --prove-lock   # ⚠ writes an UNDELETABLE object
 *   bun --env-file=.env scripts/backup-s3-smoke.ts --identity-file ./lgr-seal.key
 *
 * ⚠ Everything is written under `<prefix>/__smoke__/` and removed on the way out, so it cannot
 * touch a real generation even if the prefix is wrong.
 */

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { config } from '../packages/config/src/index.js'
import { putObject, getObject, listObjects, deleteObject, S3Error } from '../packages/services/src/biz/backup/s3-client.js'
import { sealBundle, unsealBundle, readSealedHeader } from '../packages/services/src/biz/backup/backup-crypto.js'

const argv = process.argv.slice(2)
const has = (f: string) => argv.includes(`--${f}`)
const opt = (f: string) => { const i = argv.indexOf(`--${f}`); return i === -1 ? undefined : argv[i + 1] }

const LARGE = has('large')
const KEEP = has('keep')
const PROVE_LOCK = has('prove-lock')
const IDENTITY_FILE = opt('identity-file')

const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex')
const mib = (n: number) => `${(n / 1024 / 1024).toFixed(2)} MiB`

let step = 0
function ok(msg: string) { console.log(`  \x1b[32mPASS\x1b[0m  ${msg}`) }
function info(msg: string) { console.log(`        ${msg}`) }
function head(msg: string) { console.log(`\n${++step}. ${msg}`) }
function die(msg: string, hint?: string): never {
  console.error(`  \x1b[31mFAIL\x1b[0m  ${msg}`)
  if (hint) console.error(`\n  → ${hint}\n`)
  process.exit(1)
}

const s = config.backup.s3
if (!s.endpoint || !s.bucket) die('BACKUP_S3_ENDPOINT / BACKUP_S3_BUCKET are not set', 'See the FR-13.58 block in .env.example.')
if (!s.accessKeyId || !s.secretAccessKey) die('BACKUP_S3_ACCESS_KEY_ID / BACKUP_S3_SECRET_ACCESS_KEY are not set')
if (!config.backup.encryptionPublicKey) {
  die('BACKUP_ENCRYPTION_PUBLIC_KEY is not set',
    'Nothing leaves the cluster unsealed (FR-13.23). Generate a pair OFF the cluster:\n' +
    '    bun scripts/backup-crypto.ts keygen')
}

const cfg = {
  endpoint: s.endpoint, region: s.region, bucket: s.bucket,
  accessKeyId: s.accessKeyId, secretAccessKey: s.secretAccessKey,
  forcePathStyle: s.forcePathStyle,
}
const base = `${s.prefix.replace(/^\/+|\/+$/g, '')}/__smoke__`

console.log(`\nObject-storage smoke test — ${s.bucket} at ${new URL(s.endpoint).host} (${s.region})`)
console.log(`scope=${s.scope} · lock=${s.objectLockMode || 'none'}${s.objectLockMode ? ` ${s.objectLockYears}y` : ''} · path-style=${s.forcePathStyle}`)

// ── 1. Seal ─────────────────────────────────────────────────────────────────
head('Seal a payload')
const size = LARGE ? 8 * 1024 * 1024 : 64 * 1024
const plain = Buffer.alloc(size)
for (let i = 0; i < size; i++) plain[i] = (i * 31 + (i >> 8)) & 0xff
const plainSha = sha256(plain)
const sealed = sealBundle(plain, config.backup.encryptionPublicKey)
const sealedSha = sha256(sealed)
ok(`${mib(plain.length)} plaintext → ${mib(sealed.length)} sealed`)
if (sealed.includes(plain.subarray(0, 512))) {
  die('the sealed artifact CONTAINS THE PLAINTEXT — do not upload anything until this is fixed')
}
ok('the plaintext does not appear in the sealed bytes')

// ── 2. Upload ───────────────────────────────────────────────────────────────
// The first signed write, and where a wrong region, a wrong endpoint or a key without write
// permission stops — each with the service's own error code rather than a generic failure.
head('Upload (SigV4, no SDK)')
const key = `${base}/smoke-${new Date().toISOString().replace(/[:.]/g, '-')}.sealed`
const t0 = Date.now()
try {
  const put = await putObject(cfg, key, sealed, {
    metadata: { 'lgr-smoke': 'true', 'sealed-sha256': sealedSha, 'plain-sha256': plainSha },
  })
  ok(`uploaded ${key} in ${((Date.now() - t0) / 1000).toFixed(1)}s${put.etag ? ` (etag ${put.etag})` : ''}`)
} catch (e: any) {
  const code = e instanceof S3Error ? e.code : ''
  die(`upload failed: ${e?.message}`,
    code === 'SignatureDoesNotMatch'
      ? 'Almost always the REGION. B2 and R2 embed it in the credential scope; copy it from the\n' +
        '    endpoint host (s3.<region>.backblazeb2.com) rather than guessing.'
      : code === 'NoSuchBucket'
        ? 'The bucket does not exist at this endpoint — check for a typo, or a bucket in another region.'
        : 'Check the key has write permission on this bucket, and that the endpoint has no path in it.')
}

// ── 3. Round trip ───────────────────────────────────────────────────────────
// THE test. Everything above proves a request returned 200; only this proves the bytes are
// there and readable — which is precisely the check roomler's backup job never did.
head('Download it back and re-hash')
try {
  const back = await getObject(cfg, key)
  if (back.length !== sealed.length) die(`length mismatch: uploaded ${sealed.length}, got back ${back.length}`)
  if (sha256(back) !== sealedSha) die('CHECKSUM MISMATCH — what the bucket stored is not what was uploaded')
  ok(`round trip verified, sha256 ${sealedSha.slice(0, 16)}…`)

  const header = readSealedHeader(back)
  ok(`header readable without any key: ${header.format}, recipient ${header.recipient.slice(0, 24)}…`)

  const identity = IDENTITY_FILE
    ? readFileSync(IDENTITY_FILE, 'utf8').trim()
    : (process.env.BACKUP_ENCRYPTION_PRIVATE_KEY || '').trim()
  if (identity) {
    if (sha256(unsealBundle(back, identity)) !== plainSha) die('the unsealed bytes do not match the original')
    ok('unsealed with the private key — the full chain works end to end')
  } else {
    info('⚠ Not unsealed. Pass --identity-file <path> or set BACKUP_ENCRYPTION_PRIVATE_KEY.')
    info('  Until you have done that once, you have proven you can WRITE a backup, not read one.')
  }
} catch (e: any) {
  die(`round trip failed: ${e?.message}`)
}

// ── 4. Listing ──────────────────────────────────────────────────────────────
head('List the prefix')
const listed = await listObjects(cfg, `${base}/`)
const mine = listed.find(o => o.key === key)
if (!mine) die('the object just uploaded is not in the listing — retention would never see it either')
ok(`listed as ${mine.key}, ${mib(mine.size)}`)

// ── 5. Object Lock ──────────────────────────────────────────────────────────
// The entire reason this destination exists. A bucket without Object Lock is a second copy;
// a bucket WITH it is a copy that a stolen key cannot remove (FR-13.58).
head('Object Lock')
if (!s.objectLockMode) {
  info('No lock configured (BACKUP_S3_OBJECT_LOCK_MODE is empty).')
  info('⚠ Then this destination has the same weakness as Drive: the credential that writes can')
  info('  also delete. Enable Object Lock ON BUCKET CREATION — most providers cannot add it later.')
} else if (!PROVE_LOCK) {
  info(`Configured: ${s.objectLockMode} for ${s.objectLockYears} years. NOT proven by this run.`)
  info('Re-run with --prove-lock to write a one-byte object under the lock and watch the delete')
  info(`be refused. ⚠ That object then cannot be removed for ${s.objectLockYears} years, by anyone.`)
} else {
  const lockKey = `${base}/lock-proof-${Date.now()}.bin`
  console.log(`  ⚠ writing ${lockKey} under a ${s.objectLockMode} lock — it will NOT be deletable`)
  await putObject(cfg, lockKey, Buffer.from('x'), {
    lock: { mode: s.objectLockMode, years: s.objectLockYears },
  })
  try {
    await deleteObject(cfg, lockKey)
    die('THE DELETE SUCCEEDED — this bucket does not enforce Object Lock',
      'The bucket was created without Object Lock, or the provider ignores the header. Either\n' +
      '    way the retention you think you have does not exist.')
  } catch (e: any) {
    if (e instanceof S3Error && e.status === 0) die(`could not reach the endpoint: ${e.message}`)
    ok(`the delete was REFUSED (${e instanceof S3Error ? e.code : 'error'}) — retention is real`)
  }
}

// ── 6. Clean up ─────────────────────────────────────────────────────────────
head('Clean up')
if (KEEP) {
  info(`kept: ${key} — delete it yourself when done`)
} else {
  try {
    await deleteObject(cfg, key)
    ok('smoke object deleted — nothing left behind')
  } catch (e: any) {
    info(`⚠ could not delete the smoke object (${e?.message}).`)
    info('  If a lock is configured bucket-wide, this is expected — remove it when it expires.')
  }
}

console.log('\n\x1b[32mAll checks passed.\x1b[0m Your object-storage setup works.')
console.log('Next: archive a locked fiscal year and confirm the unit records an `s3` destination.\n')
