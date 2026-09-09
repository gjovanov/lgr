#!/usr/bin/env bun
/**
 * FR-13.48–13.59 (#24) — prove a real Google Drive works, without the app.
 *
 * **The gap this fills.** `unit/backup-drive.test.ts` stubs `fetch`: it proves the LOGIC is
 * right — resumable chunking, the partial-upload throw, quota refusal, retention — and proves
 * nothing about whether *your* Drive works. The full test (test plan Part C) needs a running
 * app, a database, an org and a deployed secret, so when it fails you cannot tell a bad
 * refresh token from an unseeded database.
 *
 * This sits between them. It talks to the real Google with the real credential and touches
 * nothing else, so a failure has exactly one possible cause: the Drive setup.
 *
 *   bun scripts/backup-drive-smoke.ts
 *   bun scripts/backup-drive-smoke.ts --large        # 8 MB, exercises real resumable chunking
 *   bun scripts/backup-drive-smoke.ts --keep         # leave the artifact on Drive to look at
 *   bun scripts/backup-drive-smoke.ts --identity-file ~/lgr-seal.key   # also prove unsealing
 *
 * Environment (a local `.env` is enough — nothing needs deploying):
 *   BACKUP_GOOGLE_DRIVE_REFRESH_TOKEN   required
 *   BACKUP_ENCRYPTION_PUBLIC_KEY        required
 *   GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET  (or the BACKUP_GOOGLE_DRIVE_* overrides)
 *
 * ⚠ It writes into `<folder>/__smoke__/` and deletes what it created on the way out, so it
 * cannot touch a real backup generation even if the folder name is wrong.
 */

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { config } from '../packages/config/src/index.js'
import {
  googleDriveAdapter,
  refreshGoogleAccessToken,
  CloudReconsentRequired,
  GOOGLE_DRIVE_SCOPE,
  type CloudTokens,
} from '../packages/services/src/biz/cloud-storage.service.js'
import { sealBundle, unsealBundle, readSealedHeader } from '../packages/services/src/biz/backup/backup-crypto.js'

const argv = process.argv.slice(2)
const has = (f: string) => argv.includes(`--${f}`)
const opt = (f: string) => { const i = argv.indexOf(`--${f}`); return i === -1 ? undefined : argv[i + 1] }

const LARGE = has('large')
const KEEP = has('keep')
const IDENTITY_FILE = opt('identity-file')

const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex')
const mib = (n: number) => `${(n / 1024 / 1024).toFixed(2)} MiB`

let step = 0
let failed = false
function ok(msg: string) { console.log(`  \x1b[32mPASS\x1b[0m  ${msg}`) }
function info(msg: string) { console.log(`        ${msg}`) }
function head(msg: string) { console.log(`\n${++step}. ${msg}`) }
function die(msg: string, hint?: string): never {
  console.error(`  \x1b[31mFAIL\x1b[0m  ${msg}`)
  if (hint) console.error(`\n  → ${hint}\n`)
  failed = true
  process.exit(1)
}

const gd = config.backup.googleDrive
if (!gd.refreshToken) {
  die('BACKUP_GOOGLE_DRIVE_REFRESH_TOKEN is not set',
    'Get one with: bun scripts/google-drive-consent.ts   (run it where you have a browser)')
}
if (!config.backup.encryptionPublicKey) {
  die('BACKUP_ENCRYPTION_PUBLIC_KEY is not set',
    'Generate a pair with: bun scripts/backup-crypto.ts keygen   (run it OFF the cluster)')
}
if (!gd.clientId || !gd.clientSecret) {
  die('no OAuth client configured',
    'Set GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET (or the BACKUP_GOOGLE_DRIVE_* overrides) in .env')
}

console.log(`\nGoogle Drive smoke test — folder "${gd.folderName}", scope ${GOOGLE_DRIVE_SCOPE}`)

// ── 1. Credentials ──────────────────────────────────────────────────────────
// Every run starts here because every real run does: access tokens last about an hour, so the
// nightly job ALWAYS begins with an expired one. Refreshing is the normal path (FR-13.54).
head('Refresh the access token')
let tokens: CloudTokens
try {
  const { accessToken, expiresAt } = await refreshGoogleAccessToken(gd.refreshToken, {
    clientId: gd.clientId, clientSecret: gd.clientSecret,
  })
  tokens = { accessToken, refreshToken: gd.refreshToken }
  ok(`token refreshed, valid until ${expiresAt.toISOString()}`)
} catch (e: any) {
  if (e instanceof CloudReconsentRequired) {
    die('the refresh token is DEAD — Google says invalid_grant',
      'Revoked, password changed, or ~6 months idle. Re-run scripts/google-drive-consent.ts.\n' +
      '    ⚠ This is exactly what the nightly job reports as `reconsent_required`, and it is the\n' +
      '      one failure that never recovers on its own.')
  }
  die(`token refresh failed: ${e?.message}`,
    'Wrong client id/secret, or the refresh token belongs to a DIFFERENT OAuth client.\n' +
    '    A refresh token is bound to the client that issued it — rclone\'s token will not work here.')
}

// ── 2. Quota ────────────────────────────────────────────────────────────────
// Also the cheapest proof that the Drive API is enabled at all: if it is not, this is where
// the run stops, with Google's own message rather than a confusing failure three steps later.
head('Read the storage quota')
try {
  const q = await googleDriveAdapter.getQuota(tokens)
  if (q.free === undefined) {
    ok('no storage limit reported — an unlimited (Workspace) account')
    info('⚠ The nightly pre-flight will skip its quota check on this account, by design:')
    info('  an absent limit means unlimited, and reading it as zero would refuse every upload.')
  } else {
    ok(`${mib(q.free)} free of ${mib(q.total!)}`)
    if (q.free < gd.minFreeBytes) {
      info(`⚠ Below BACKUP_GOOGLE_DRIVE_MIN_FREE_BYTES (${mib(gd.minFreeBytes)}) — a real run would refuse up front.`)
    }
  }
} catch (e: any) {
  die(`could not read the quota: ${e?.message}`,
    'Usually: the Google Drive API is not enabled on the project.\n' +
    '    APIs & Services → Library → "Google Drive API" → Enable.')
}

// ── 3. Folder ───────────────────────────────────────────────────────────────
// The first WRITE. `drive.readonly` — the scope this adapter replaced — gets exactly this far
// and then fails, which is why it is worth its own step.
head('Find or create the folder tree')
let folderId: string
try {
  folderId = await googleDriveAdapter.ensureFolder(tokens, [gd.folderName, '__smoke__'])
  ok(`"${gd.folderName}/__smoke__" ready (${folderId})`)
} catch (e: any) {
  die(`could not create the folder: ${e?.message}`,
    'A read-only scope reaches step 2 and fails here. Check the consent granted `drive.file`,\n' +
    '    and remember that changing scope invalidates consent already given — re-consent.')
}

// ── 4. Seal ─────────────────────────────────────────────────────────────────
head('Seal a payload')
// Compressible, non-repeating content: a payload of zeros would prove the transfer and hide a
// bug that mangles content.
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

// ── 5. Upload ───────────────────────────────────────────────────────────────
head(`Upload, resumably${LARGE ? ' (over the 5 MB simple-upload ceiling)' : ''}`)
const name = `smoke-${new Date().toISOString().replace(/[:.]/g, '-')}.sealed`
let fileId = ''
const t0 = Date.now()
try {
  const up = await googleDriveAdapter.uploadFile(tokens, folderId, name, sealed, {
    mimeType: 'application/octet-stream',
    properties: { lgrSmoke: 'true', sealedSha256: sealedSha, plainSha256: plainSha },
  })
  fileId = up.id
  ok(`uploaded ${name} in ${((Date.now() - t0) / 1000).toFixed(1)}s (${up.id})`)
  if (LARGE) info('this crossed the 5 MB ceiling, so Google served it as a real chunked session')
} catch (e: any) {
  die(`upload failed: ${e?.message}`,
    'A partial upload throws rather than returning — that is deliberate (FR-13.52). A\n' +
    '    success-shaped return here would be recorded as "an off-site copy exists".')
}

// ── 6. Round trip ───────────────────────────────────────────────────────────
// THE test. Everything above proves an API call returned 200; only this proves the bytes are
// there and readable. An upload that returns 200 and stores nothing is the roomler failure.
head('Download it back and re-hash')
try {
  const back = await googleDriveAdapter.downloadFile(tokens, fileId)
  if (back.length !== sealed.length) {
    die(`length mismatch: uploaded ${sealed.length}, got back ${back.length}`)
  }
  if (sha256(back) !== sealedSha) {
    die('CHECKSUM MISMATCH — what Drive stored is not what was uploaded')
  }
  ok(`round trip verified, sha256 ${sealedSha.slice(0, 16)}…`)

  const header = readSealedHeader(back)
  ok(`header readable without any key: ${header.format}, recipient ${header.recipient.slice(0, 24)}…`)

  if (IDENTITY_FILE) {
    const identity = readFileSync(IDENTITY_FILE, 'utf8').trim()
    const opened = unsealBundle(back, identity)
    if (sha256(opened) !== plainSha) die('the unsealed bytes do not match the original')
    ok('unsealed with the private key — the full chain works end to end')
  } else {
    info('⚠ Not unsealed. Pass --identity-file <path> to prove the private half opens it too.')
    info('  Until you have done that once, you have proven you can WRITE a backup, not read one.')
  }
} catch (e: any) {
  die(`round trip failed: ${e?.message}`)
}

// ── 7. Metadata ─────────────────────────────────────────────────────────────
// FR-13.59: the remote copy must describe itself, so a listing answers "what is this" without
// a download.
head('Check the file describes itself')
const listed = await googleDriveAdapter.listFiles(tokens, folderId)
const mine = listed.find(f => f.id === fileId)
if (!mine) die('the file just uploaded is not in the folder listing')
ok(`listed as ${mine.name}, ${mib(mine.size)}`)
if (mine.properties?.sealedSha256 === sealedSha) ok('appProperties carry the checksum')
else die('appProperties did not survive the upload — the remote copy is not self-describing')

// ── 8. Delete ───────────────────────────────────────────────────────────────
head('Clean up')
if (KEEP) {
  info(`kept: "${gd.folderName}/__smoke__/${name}" — delete it yourself when done`)
} else {
  await googleDriveAdapter.deleteFile(tokens, fileId)
  ok('smoke artifact deleted — nothing left behind')
  info(`⚠ The empty "${gd.folderName}/__smoke__" folder stays. Remove it by hand if you like;`)
  info('  this script will not delete folders, because a folder-deleting backup job is a bad idea.')
}

console.log(`\n\x1b[32mAll checks passed.\x1b[0m Your Drive setup works.`)
console.log('Next: test plan Part C — a real per-org bundle through the app.\n')
if (failed) process.exit(1)
