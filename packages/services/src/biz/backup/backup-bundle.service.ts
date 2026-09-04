/**
 * FR-13.12/13.13/13.14 (#24) — the per-org bundle, its manifest, and the verifier.
 *
 * ⚠ SERVER-ONLY (enumerates mongoose models and reads them). The wire shapes live in
 * `backup-bundle.types.ts`, which is import-pure — the same split as
 * `daily-digest.types.ts` vs its service, for the same reason.
 *
 * **Format.** One artifact, zstd-compressed, whose plaintext is line-oriented:
 *
 *     {"format":"lgr-backup-1","manifest":{…}}      ← header line
 *     {"$collection":"invoices","count":548,"sha256":"…"}
 *     {…document…}                                   ← NDJSON, one document per line
 *     …
 *     {"$collection":"products","count":23246,…}
 *     …
 *
 * NDJSON rather than length-prefixed BSON (FR-13.12 allows either): it survives inspection
 * with `zstd -dc | head`, which matters for a format whose only job is to be readable years
 * from now, possibly by someone without this codebase.
 *
 * **The manifest is reproducible from the bundle** — that is a requirement, not a nicety
 * (FR-13.12). `verifyBundle` re-reads the artifact, re-hashes every section and re-counts
 * every document, and compares against what the header claims. A restore can therefore prove
 * completeness instead of assuming it.
 *
 * **Compression** is zstd via `zlib.zstdCompressSync`, verified present in the deployed Bun
 * (§1.3) — level 19 for a full, 3 for a delta (FR-13.13). ⚠ If brotli is ever preferred here
 * it MUST pin quality 5: the library default of 11 costs 2,734 s to save 8 % over zstd-19's
 * 37.5 s on this data, and reads as a hung job.
 */

import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import zlib from 'node:zlib'
import { config } from 'config'
import { mongoose } from 'db/connection'
import { Org } from 'db/models'
import { logger } from '../../logger/logger.js'
import {
  BUNDLE_FORMAT,
  type BackupBundleManifest,
  type BackupCollectionSection,
  type BackupVerifyResult,
} from './backup-bundle.types.js'

const sha256 = (s: string | Buffer) => createHash('sha256').update(s).digest('hex')

/**
 * The scheduler's own bookkeeping, which is org-scoped but is NOT the org's data.
 *
 * ⚠ Excluding these is a correctness requirement, not tidiness. A `BackupRun` row with
 * `status: 'running'` and a recent `startedAt` is a live CLAIM: restore one and the scheduler
 * reads it as "tonight is already being handled" and skips the org until the claim goes
 * stale. A backup that can suppress the next backup is precisely the class of silent failure
 * this FR exists to eliminate. `BackupRun` inside a backup is also self-referential — every
 * night's bundle would carry the record of every previous night's.
 */
const OPERATIONAL_COLLECTIONS = new Set(['BackupRun', 'DigestRun'])

/**
 * Collections that belong to an org, discovered rather than listed.
 *
 * A hardcoded list is a latent data-loss bug: this repo has 83 models and gains them
 * regularly, and a backup that silently omits a collection added last month is worse than no
 * backup. `tenantPlugin` adds an `orgId` path to every tenant-scoped schema, so that path IS
 * the definition of "belongs to an org".
 */
export function tenantCollections(): string[] {
  return Object.keys(mongoose.models)
    .filter(name => !!mongoose.models[name].schema.path('orgId'))
    .filter(name => !OPERATIONAL_COLLECTIONS.has(name))
    .sort()
}

/** zstd, with the level the FR pins per kind. */
function compress(plain: Buffer, kind: 'full' | 'delta'): Buffer {
  const level = kind === 'full' ? 19 : 3
  const z: any = zlib
  if (typeof z.zstdCompressSync !== 'function') {
    // Verified present in the deployed Bun 1.3.10 and in 1.3.9 locally; if a runtime ever
    // lacks it, fail loudly rather than silently writing a different format.
    throw new Error('zlib.zstdCompressSync is unavailable in this runtime')
  }
  return z.zstdCompressSync(plain, { params: { [z.constants.ZSTD_c_compressionLevel]: level } })
}

function decompress(buf: Buffer): Buffer {
  const z: any = zlib
  if (typeof z.zstdDecompressSync !== 'function') {
    throw new Error('zlib.zstdDecompressSync is unavailable in this runtime')
  }
  return z.zstdDecompressSync(buf)
}

/** `<UPLOAD_DIR>/<orgId>/backups` — inherits the PV, the per-org isolation and the Layer-1 rotation. */
export function bundleDir(orgId: string): string {
  return join(config.upload.dir, String(orgId), 'backups')
}

export interface BuildBundleOptions {
  kind?: 'full' | 'delta'
  /** Org-local day the run is claimed under; only recorded, never used to filter. */
  date: string
  coversFrom?: Date
  coversTo?: Date
}

export interface BuiltBundle {
  filename: string
  path: string
  absolutePath: string
  bytes: number
  /** Over the COMPRESSED artifact. The manifest cannot contain its own hash. */
  sha256: string
  manifest: BackupBundleManifest
}

/**
 * Build one org's bundle and write it under `<UPLOAD_DIR>/<orgId>/backups/`.
 *
 * ⚠ `kind: 'delta'` deliberately still writes a FULL document set. An `updatedAt`-based delta
 * was measured on this data at 46,288 docs = 81 % of the org over 7 days — because
 * `assign-din-tags` / `backfill-*` / `seed-products --no-clean` rewrite the whole catalogue by
 * design — and it cannot see deletes at all, so replaying a chain of them resurrects deleted
 * rows (§3.4). The real delta tier is the Layer-1 oplog slice, which lives in `lgr-deploy`.
 * The `delta` kind exists here because FR-13.11 keys the claim on it; it is not an invitation
 * to build a query-delta.
 */
export async function buildBundle(orgId: string, opts: BuildBundleOptions): Promise<BuiltBundle> {
  const kind = opts.kind || 'full'
  const org: any = await Org.findById(orgId, { slug: 1, name: 1 }).lean().exec()
  if (!org) throw new Error(`org ${orgId} not found`)

  const sections: BackupCollectionSection[] = []
  const lines: string[] = []
  const headerIndex = lines.push('') - 1   // reserved; filled once the manifest is complete
  let documentCount = 0

  for (const modelName of tenantCollections()) {
    const model = mongoose.models[modelName]
    // `.lean()` keeps this out of Mongoose's document machinery — at 95k documents the
    // hydration cost dwarfs the query.
    const docs: any[] = await model.find({ orgId }).lean().exec()
    if (!docs.length) continue

    const body = docs.map(d => JSON.stringify(d)).join('\n') + '\n'
    const section: BackupCollectionSection = {
      name: modelName,
      collection: model.collection.name,
      count: docs.length,
      bytes: Buffer.byteLength(body),
      sha256: sha256(body),
    }
    sections.push(section)
    documentCount += docs.length

    lines.push(JSON.stringify({ $collection: modelName, count: section.count, sha256: section.sha256 }))
    lines.push(body.slice(0, -1))   // the join already ends each document line
  }

  const manifest: BackupBundleManifest = {
    format: BUNDLE_FORMAT,
    orgId: String(orgId),
    orgSlug: org.slug || '',
    orgName: org.name || '',
    kind,
    date: opts.date,
    createdAt: new Date().toISOString(),
    coversFrom: opts.coversFrom?.toISOString(),
    coversTo: opts.coversTo?.toISOString(),
    schemaVersion: BUNDLE_FORMAT,
    // What produced it. A bundle newer than the running code must be refused on restore
    // (FR-13.31), and that comparison needs this recorded at write time.
    appImageTag: process.env.LGR_IMAGE_TAG || process.env.IMAGE_TAG || 'unknown',
    documentCount,
    collections: sections,
  }
  lines[headerIndex] = JSON.stringify({ format: BUNDLE_FORMAT, manifest })

  const plain = Buffer.from(lines.join('\n') + '\n', 'utf8')
  const artifact = compress(plain, kind)

  const dir = bundleDir(orgId)
  await mkdir(dir, { recursive: true })
  const filename = `lgr-${org.slug || orgId}-${kind}-${opts.date}.ndjson.zst`
  const absolutePath = join(dir, filename)
  await writeFile(absolutePath, artifact)

  logger.info(
    { orgId: String(orgId), kind, collections: sections.length, documentCount, bytes: artifact.length },
    'Backup bundle written',
  )

  return {
    filename,
    path: join(String(orgId), 'backups', filename),
    absolutePath,
    bytes: artifact.length,
    sha256: sha256(artifact),
    manifest,
  }
}

/**
 * FR-13.8's rule, applied to Layer 2: keep N GENERATIONS, never delete by age.
 *
 * ⚠ `find -mtime +N -delete` — or its JavaScript equivalent — can delete the last good copy
 * after a run of failed nights, which is exactly the scenario a backup exists for. Counting
 * generations cannot: if only one bundle exists, it survives whatever its date.
 *
 * Artifacts are named `lgr-<slug>-<kind>-<YYYY-MM-DD>.ndjson.zst`, so within one org and kind
 * lexical order IS chronological. Pruning is per kind, so a run of deltas cannot evict fulls.
 *
 * Returns the filenames removed, so the caller can mark their runs and the operator can see
 * it happened.
 */
export async function pruneBundles(
  orgId: string,
  kind: 'full' | 'delta',
  keep = config.backup.keepPerOrg,
): Promise<string[]> {
  const dir = bundleDir(orgId)
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch {
    return []   // nothing written yet
  }

  const mine = entries
    .filter(f => f.endsWith('.ndjson.zst') && f.includes(`-${kind}-`))
    .sort()
    .reverse()

  const victims = mine.slice(Math.max(keep, 1))
  const removed: string[] = []
  for (const f of victims) {
    try {
      await unlink(join(dir, f))
      removed.push(f)
    } catch (e: any) {
      logger.warn({ orgId, file: f, err: e?.message }, 'Backup prune failed for one artifact')
    }
  }
  if (removed.length) {
    logger.info({ orgId, kind, kept: keep, removed: removed.length }, 'Pruned old backup bundles')
  }
  return removed
}

/** Read a bundle's manifest without materialising its documents. */
export async function readBundleManifest(absolutePath: string): Promise<BackupBundleManifest> {
  const plain = decompress(await readFile(absolutePath)).toString('utf8')
  const nl = plain.indexOf('\n')
  const header = JSON.parse(plain.slice(0, nl === -1 ? undefined : nl))
  if (header?.format !== BUNDLE_FORMAT) throw new Error(`not an ${BUNDLE_FORMAT} bundle`)
  return header.manifest
}

/**
 * FR-13.12 — prove the manifest against the bundle rather than trusting it.
 *
 * Re-hashes every section and re-counts every document line. Any mismatch is reported per
 * collection; the caller decides. A restore MUST run this before writing anything
 * (FR-13.31), and `verify-backups.sh`'s Layer-1 equivalent is the same idea one layer down.
 */
export async function verifyBundle(absolutePath: string, expectedBundleSha?: string): Promise<BackupVerifyResult> {
  const raw = await readFile(absolutePath)
  const problems: string[] = []

  if (expectedBundleSha && sha256(raw) !== expectedBundleSha) {
    // Checked FIRST and reported alone: if the artifact changed, nothing inside it is evidence
    // of anything.
    return {
      ok: false,
      bundleShaOk: false,
      collections: [],
      documentCount: 0,
      problems: ['bundle sha256 does not match the recorded value'],
    }
  }

  const plain = decompress(raw).toString('utf8')
  const lines = plain.split('\n')
  const header = JSON.parse(lines[0] || '{}')
  if (header?.format !== BUNDLE_FORMAT) {
    return { ok: false, bundleShaOk: true, collections: [], documentCount: 0, problems: [`unknown format: ${header?.format}`] }
  }
  const manifest: BackupBundleManifest = header.manifest

  const seen = new Map<string, { count: number; body: string[] }>()
  let current: { count: number; body: string[] } | null = null
  let currentName = ''

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]
    if (!line) continue
    if (line.startsWith('{"$collection":')) {
      const head = JSON.parse(line)
      currentName = head.$collection
      current = { count: 0, body: [] }
      seen.set(currentName, current)
      continue
    }
    if (!current) {
      problems.push(`document line ${i} precedes any collection marker`)
      continue
    }
    current.count++
    current.body.push(line)
  }

  const collections = manifest.collections.map(c => {
    const got = seen.get(c.name)
    if (!got) {
      problems.push(`${c.name}: declared in the manifest but absent from the bundle`)
      return { name: c.name, expected: c.count, found: 0, shaOk: false }
    }
    const shaOk = sha256(got.body.join('\n') + '\n') === c.sha256
    if (got.count !== c.count) problems.push(`${c.name}: manifest says ${c.count}, bundle holds ${got.count}`)
    if (!shaOk) problems.push(`${c.name}: section sha256 mismatch`)
    return { name: c.name, expected: c.count, found: got.count, shaOk }
  })

  for (const name of seen.keys()) {
    if (!manifest.collections.some(c => c.name === name)) {
      problems.push(`${name}: present in the bundle but absent from the manifest`)
    }
  }

  const documentCount = [...seen.values()].reduce((n, s) => n + s.count, 0)
  return { ok: problems.length === 0, bundleShaOk: true, collections, documentCount, problems, manifest }
}
