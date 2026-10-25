/**
 * FR-13.31–13.37 (#24) — restore from a bundle. The most destructive thing this product does.
 *
 * ⚠ SERVER-ONLY. Reads the uploads PV and writes every tenant-scoped collection.
 *
 * The sequence is lifted from the desktop shell, which already solved this problem correctly
 * and is the in-tree precedent (`desktop/src-tauri/src/archive.rs:78-146`): verify the format,
 * verify the integrity, take a safety copy, write, verify again, roll back from the safety
 * copy on any failure. `archive.rs:120-133` renames the live database to `.pre-restore` and
 * renames it BACK if the install fails; everything below is that idea against MongoDB.
 *
 * Four hazards this file exists to prevent, each of which is invisible until it is expensive:
 *
 *  1. **Numbering that moves backwards** (FR-13.35). A bundle three weeks old carries a
 *     `Sequence.lastNumber` three weeks behind. Writing it back reissues invoice numbers that
 *     are already in customers' hands and breaks the per-family continuity the NRA expects
 *     (and that FR-11's digest checks nightly). Every writing path clamps to
 *     `max(live, bundle)` and reports the clamp — never the bundle's value, never silently.
 *  2. **Rows nothing can see** (FR-13.32). A bundle carries its origin `orgId`. Restore it
 *     into another org unchanged and `tenantPlugin` filters every one of those documents out
 *     of every query: data that exists, occupies the PV, rides along in every future backup,
 *     and appears nowhere in the UI. Refused unless remap is asked for explicitly.
 *  3. **Deleting issued fiscal documents** (FR-13.36). Наредба Н-18 / Приложение 29 forbid it
 *     (`docs/supto/COMPLIANCE-CHECKLIST.md` rows 21–24). Replace is blocked outright for an
 *     org with an active `FiscalDevice` or a `locked` fiscal year in range. Merge, which can
 *     only ever insert, stays available — and Merge is what the common real need
 *     ("something was deleted by mistake") actually wants.
 *  4. **A restore that half-happened** (FR-13.34). A mandatory, VERIFIED safety bundle is
 *     taken first; a failure part-way rolls back from it and says so.
 *
 * ⚠ Inspect writes nothing. Not "writes almost nothing" — the mode exists so an operator can
 * see the diff before choosing, and FR-13.33 makes running it a precondition of both writing
 * modes. `applyRestore` will not act on a bundle this process has not inspected.
 */

import { createHash } from 'node:crypto'
import { join, resolve, sep } from 'node:path'
import { stat } from 'node:fs/promises'
import { config } from 'config'
import { mongoose } from 'db/connection'
import { assertHomeIsHere } from 'db/home/home'
import { BackupRun, FiscalDevice, FiscalYear, Identity, Org, RestoreRun } from 'db/models'
import { logger } from '../../logger/logger.js'
import { createAuditEntry } from '../audit-log.service.js'
import {
  PEOPLE_MODEL,
  buildBundle,
  bundleDir,
  iterateBundleLines,
  readBundlePlain,
  tenantCollections,
  bundleExclusion,
  verifyBundle,
} from './backup-bundle.service.js'
import { BUNDLE_FORMAT, type BackupBundleManifest } from './backup-bundle.types.js'
import { orgDocsDir, restoreFilesSidecar } from './backup-files.service.js'
import { normalizeStored, resolveStored } from '../files/stored-path.js'

/** Documents per `insertMany`. Large enough to be worth batching, small enough to stay bounded. */
const INSERT_BATCH = 500

/** How many dangling paths are listed on the report before it stops naming them (FR-13.37). */
const DANGLING_SAMPLE = 50

export interface RestoreSourceRef {
  type: 'run' | 'path' | 'upload'
  /** A `BackupRun._id` — the org's own listed bundle, restored without a browser round trip. */
  runId?: string
  /** A path under the org's backup directory, including `uploads/` and `safety/`. */
  path?: string
}

export interface RestoreActor {
  userId?: string
  email?: string
}

/** `<UPLOAD_DIR>/<orgId>/backups/uploads` — where an operator-supplied artifact lands. */
export function uploadStagingDir(orgId: string): string {
  return join(bundleDir(orgId), 'uploads')
}

/**
 * Turn a source reference into an absolute path, refusing anything outside the org's own
 * backup tree.
 *
 * ⚠ `path` is operator input that becomes a filesystem read whose CONTENT is then written
 * into the database. The same reasoning as `BUNDLE_DATE_RE` on the create side, one step
 * sharper: there, a bad value wrote a file somewhere odd; here, it chooses which file becomes
 * this organisation's data. `resolve` + prefix comparison, and the org's own directory only —
 * a sys admin may restore org B's bundle into org A, but they do it by uploading it, so that
 * the act is explicit and leaves an artifact, rather than by typing a path across tenants.
 */
export async function resolveSource(
  orgId: string,
  src: RestoreSourceRef,
): Promise<{ absolutePath: string; filename: string; expectedSha?: string; run?: any }> {
  const root = resolve(bundleDir(orgId))

  if (src.type === 'run') {
    if (!src.runId || !mongoose.Types.ObjectId.isValid(src.runId)) {
      throw new Error('no such backup run')
    }
    const run: any = await BackupRun.findOne({ _id: src.runId, orgId }).lean().exec()
    if (!run?.filename) throw new Error('no such backup run')
    // `run.path` carries the subdirectory for out-of-band bundles; `filename` alone would
    // resolve a safety bundle to the wrong directory.
    const absolutePath = run.path
      ? join(config.upload.dir, run.path)
      : join(root, run.filename)
    assertUnder(root, absolutePath)
    return { absolutePath, filename: run.filename, expectedSha: run.sha256, run }
  }

  const raw = String(src.path || '')
  if (!raw) throw new Error('no bundle was named')
  // Accept either an absolute path or one relative to the org's backup directory; both are
  // resolved and then checked, so neither form is trusted.
  const absolutePath = resolve(raw.startsWith(config.upload.dir) ? raw : join(root, raw))
  assertUnder(root, absolutePath)
  await stat(absolutePath)   // a missing file must fail here, not halfway through a restore
  return { absolutePath, filename: absolutePath.split(/[\\/]/).pop() || 'bundle' }
}

function assertUnder(root: string, target: string): void {
  const t = resolve(target)
  if (t !== root && !t.startsWith(root + sep)) {
    throw new Error('refusing a bundle path outside this organisation’s backup directory')
  }
}

/**
 * A document's identity, independent of key order.
 *
 * ⚠ `JSON.stringify` of two equal documents can differ if the keys were inserted in a
 * different order — which happens across a schema change, a `$set` that added a field, or
 * simply a different mongoose version. Using raw stringify would report half the org as
 * `differing` and make the Inspect diff worthless. Sorting the keys is what makes "differs"
 * mean differs.
 */
function canonical(value: any): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null)
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  const keys = Object.keys(value).sort()
  return `{${keys.map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`
}

/**
 * Hash a document the way the BUNDLE sees it.
 *
 * ⚠ The `JSON.parse(JSON.stringify(...))` is not defensive copying — it is the only way the
 * two sides are comparable. A bundle line is whatever `JSON.stringify` made of a lean
 * document (`backup-bundle.service.ts`): an `ObjectId` became a hex string, a `Date` became an
 * ISO string. A live lean document still holds the real BSON objects, and `Object.keys()` on
 * an `ObjectId` yields its internal buffer, so hashing the two directly compares a hex string
 * against a byte array and reports every single document as `differing`. Round-tripping the
 * live side through JSON puts both in the bundle's own representation.
 */
const hashDoc = (d: any) =>
  createHash('sha256').update(canonical(JSON.parse(JSON.stringify(d)))).digest('hex').slice(0, 16)

/**
 * Turn a bundle line back into a document with real BSON types.
 *
 * ⚠ Inserting a parsed bundle line directly is the subtlest bug in this whole file, and it is
 * silent: `_id` arrives as the string `"68b1…"` rather than an `ObjectId`, `orgId` likewise,
 * and every `Date` as an ISO string. Mongo accepts all of it happily. What then happens is
 * that `Model.find({ orgId })` — which mongoose CASTS to an ObjectId — matches none of it. The
 * documents exist, occupy the volume, ride along in every future backup, and are invisible to
 * the application: exactly the failure FR-13.32 describes for a wrong `orgId`, arrived at from
 * a completely different direction.
 *
 * `castObject` applies the model's own schema to the plain object, which is the only authority
 * on which paths are ObjectIds and which are Dates — a hand-rolled list would be wrong the
 * first time a model gained a field. `ignoreCastErrors` keeps one unparseable path from
 * costing the whole document: a restore that drops a field is recoverable, a restore that
 * refuses the row is not.
 */
function castForModel(modelName: string, doc: any): any {
  const model: any = mongoose.models[modelName]
  if (!model?.castObject) return doc
  try {
    const cast = model.castObject(doc, { ignoreCastErrors: true })
    // `castObject` honours `strict` and can drop `_id`; preserving identity is the whole
    // basis of both the Merge diff and the reference integrity remap relies on.
    if (doc._id !== undefined && cast._id === undefined) {
      cast._id = mongoose.Types.ObjectId.isValid(doc._id)
        ? new mongoose.Types.ObjectId(String(doc._id))
        : doc._id
    }
    return cast
  } catch {
    return doc
  }
}

interface BundleContents {
  manifest: BackupBundleManifest
  /** Model name → the documents it holds, as parsed objects. */
  byCollection: Map<string, any[]>
}

/**
 * Parse a whole bundle into memory, one line at a time.
 *
 * ⚠ The ROWS are held; the artifact and its plaintext are not kept alongside them. §2.3 caps
 * a ten-year bundle at ~1.76 GB uncompressed, which is the ceiling this design accepts in
 * exchange for a restore that can compute a real diff and insert in `_id` order. The `docs/`
 * bytes — the half that reaches 6.9 GB — deliberately never come through here; they stream
 * (`backup-files.service.ts`).
 */
async function readBundle(absolutePath: string): Promise<BundleContents> {
  const plain = await readBundlePlain(absolutePath)
  const byCollection = new Map<string, any[]>()
  let manifest: BackupBundleManifest | null = null
  let current: any[] | null = null

  for (const line of iterateBundleLines(plain)) {
    if (!manifest) {
      const header = JSON.parse(line)
      if (header?.format !== BUNDLE_FORMAT) throw new Error(`not an ${BUNDLE_FORMAT} bundle`)
      manifest = header.manifest
      continue
    }
    if (line.startsWith('{"$collection":')) {
      const head = JSON.parse(line)
      current = []
      byCollection.set(head.$collection, current)
      continue
    }
    if (!current) continue
    current.push(JSON.parse(line))
  }

  if (!manifest) throw new Error('the bundle has no header')
  return { manifest, byCollection }
}

/** Live documents of one collection for this org, hashed by `_id`, read through a cursor. */
async function liveHashes(modelName: string, orgId: string): Promise<Map<string, string>> {
  const model = mongoose.models[modelName]
  const out = new Map<string, string>()
  if (!model) return out
  const cursor = model.find({ orgId }).lean().cursor()
  for await (const doc of cursor as any) {
    out.set(String((doc as any)._id), hashDoc(doc))
  }
  return out
}

/**
 * The live people a bundle names, hashed by `_id` (see `PEOPLE_MODEL`).
 *
 * ⚠ Not `liveHashes`: an identity has no `orgId`, so `find({ orgId })` matches nothing (or, under
 * a non-strict query, EVERY person in the database). The only live people that matter are the ones
 * this bundle carries. Read through the driver so `select: false` does not hide the password,
 * which would make every person look different from their bundled copy.
 */
async function livePeopleHashes(bundleDocs: any[]): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  const ids = bundleDocs
    .map(d => String(d?._id ?? ''))
    .filter(id => mongoose.Types.ObjectId.isValid(id))
    .map(id => new mongoose.Types.ObjectId(id))
  if (!ids.length) return out
  for await (const doc of Identity.collection.find({ _id: { $in: ids } }) as any) {
    out.set(String(doc._id), hashDoc(doc))
  }
  return out
}

export interface RestoreOptions {
  mode: 'merge' | 'replace'
  /** FR-13.32 — rewrite `orgId` (and the paths that embed it) onto the target org. */
  remap?: boolean
  /** FR-13.33 — the org's own slug, typed by the operator. Required for Replace. */
  confirmSlug?: string
  /** FR-13.33 — the completed Inspect that authorises this apply. */
  inspectionId: string
  actor?: RestoreActor
  /** FR-13.29 — also put the `docs/` bytes back, when the bundle came with a sidecar. */
  restoreFiles?: boolean
}

/**
 * FR-13.33's read-only mode, and the precondition for both writing ones.
 *
 * Writes exactly one document: its own `RestoreRun` row. Every count below is computed from
 * live reads and the bundle, and nothing in a tenant collection is touched — the test for
 * this compares per-collection counts AND the maximum `updatedAt` before and after, because a
 * count is unchanged by an update.
 */
export async function inspectBundle(
  orgId: string,
  src: RestoreSourceRef,
  actor?: RestoreActor,
): Promise<any> {
  const started = Date.now()
  const resolved = await resolveSource(orgId, src)

  const row: any = await RestoreRun.create({
    orgId,
    mode: 'inspect',
    status: 'running',
    source: { type: src.type, runId: src.runId, path: resolved.absolutePath, filename: resolved.filename },
    actorUserId: actor?.userId,
    actorEmail: actor?.email,
    startedAt: new Date(),
  })

  try {
    // FR-13.31 step 1 — integrity BEFORE anything else. A bundle whose own manifest does not
    // reproduce is not evidence of anything, and one flipped byte must stop the process here,
    // not at the first insert.
    const verified = await verifyBundle(resolved.absolutePath, resolved.expectedSha)
    if (!verified.ok) {
      throw new Error(`bundle failed verification: ${verified.problems.slice(0, 3).join('; ')}`)
    }

    const { manifest, byCollection } = await readBundle(resolved.absolutePath)
    const warnings: string[] = []

    // FR-13.31 step 3 — the version gate. A bundle written by NEWER code can carry fields and
    // shapes this deployment does not understand; an older one is a normal, expected thing to
    // restore. So: refuse forward, warn backward, and say which is which.
    const runningTag = process.env.LGR_IMAGE_TAG || process.env.IMAGE_TAG || 'unknown'
    if (manifest.schemaVersion !== BUNDLE_FORMAT) {
      throw new Error(
        `bundle schema ${manifest.schemaVersion} is not ${BUNDLE_FORMAT} — this deployment cannot read it`,
      )
    }
    if (manifest.appImageTag && runningTag !== 'unknown' && manifest.appImageTag !== runningTag) {
      warnings.push(
        `the bundle was written by image ${manifest.appImageTag}; this deployment runs ${runningTag}`,
      )
    }
    if (runningTag === 'unknown') {
      // Worth saying out loud: the comparison FR-13.31 asks for cannot happen at all until
      // `LGR_IMAGE_TAG` is set in the prod configmap.
      warnings.push('LGR_IMAGE_TAG is not set on this deployment, so the version check could not run')
    }

    // FR-13.32 — stated, not enforced, at Inspect time: seeing the mismatch is the whole
    // point of a read-only mode. `applyRestore` is where it becomes a refusal.
    const crossOrg = String(manifest.orgId) !== String(orgId)
    if (crossOrg) {
      warnings.push(
        `this bundle belongs to organisation ${manifest.orgId} (${manifest.orgSlug || 'unknown'}), not this one — ` +
        `restoring it requires an explicit remap`,
      )
    }

    const collections: any[] = []
    for (const name of new Set([...byCollection.keys(), ...tenantCollections()])) {
      // Never restored (see `applyRestore`): an older bundle may still carry them.
      if (bundleExclusion(name)) continue
      const docs = byCollection.get(name) || []
      // For the people section, `inLive` counts only the bundle's own people that exist live:
      // every other person in the database is outside this org's backup by design.
      const live = name === PEOPLE_MODEL ? await livePeopleHashes(docs) : await liveHashes(name, orgId)
      if (!docs.length && !live.size) continue

      let missing = 0
      let differing = 0
      for (const d of docs) {
        // ⚠ Compared on the bundle's OWN ids, even for a cross-org bundle. A remap mints new
        // ids (see `buildIdMap`), so every document in a cross-org bundle is genuinely
        // missing from the target and the diff below says so — which is the honest answer,
        // not a degraded one: a remap inserts everything, and an operator reading "0 missing"
        // before one would be reading a lie.
        const liveHash = live.get(String(d?._id))
        if (liveHash === undefined) missing++
        else if (liveHash !== hashDoc(d)) differing++
      }
      collections.push({
        name,
        inBundle: docs.length,
        inLive: live.size,
        missing,
        differing,
        inserted: 0,
        deleted: 0,
        skipped: 0,
      })
    }
    collections.sort((a, b) => a.name.localeCompare(b.name))

    if (!byCollection.has('DocFile')) {
      // Not a warning about this bundle so much as about the mode: say it before the operator
      // chooses, not in the report afterwards.
      warnings.push('this bundle carries no DocFile rows')
    }

    await RestoreRun.updateOne({ _id: row._id }, {
      $set: {
        status: 'completed',
        manifestOrgId: String(manifest.orgId),
        bundleSha256: verified.bundleShaOk && resolved.expectedSha
          ? resolved.expectedSha
          : await shaOfFile(resolved.absolutePath),
        bundleDate: manifest.date,
        bundleKind: manifest.kind,
        bundleAppImageTag: manifest.appImageTag,
        runningAppImageTag: runningTag,
        collections,
        warnings,
        completedAt: new Date(),
        durationMs: Date.now() - started,
      },
    }).exec()

    // FR-13.37 — even the mode that writes nothing is an operator reaching into live data,
    // and the audit trail is how the people who did not perform it find out.
    if (actor?.userId) {
      createAuditEntry({
        orgId, userId: actor.userId, action: 'view', module: 'admin',
        entityType: 'restore', entityId: String(row._id), entityName: `inspect ${resolved.filename}`,
      })
    }

    return RestoreRun.findById(row._id).lean().exec()
  } catch (e: any) {
    await RestoreRun.updateOne({ _id: row._id }, {
      $set: { status: 'failed', error: e?.message || 'inspect failed', completedAt: new Date() },
    }).exec()
    throw e
  }
}

async function shaOfFile(absolutePath: string): Promise<string> {
  const buf = Buffer.from(await Bun.file(absolutePath).arrayBuffer())
  return createHash('sha256').update(buf).digest('hex')
}

/**
 * FR-13.32 — the `_id` map a remap needs, built across the WHOLE bundle before anything is
 * written.
 *
 * ⚠ Every `_id` is replaced, and it took a failing test to establish that it has to be. The
 * tempting design is to keep the ids — then every cross-collection reference stays correct by
 * construction and no reference graph has to be walked. That reasoning holds only if the
 * bundle's rows are landing in a database that does not already contain them, and in LGR they
 * are not: this is a single-database multi-tenant deployment, so org A's `contacts` and org
 * B's `contacts` are the SAME physical collection. Remapping org B's bundle into org A while
 * keeping `_id` collides with B's own live rows on the `_id` index — silently, as a
 * `writeErrors` entry inside an unordered bulk insert, which reads as "0 documents inserted"
 * and nothing else.
 *
 * So: new ids, and the references rewritten to match. The map is built across every
 * collection FIRST, because a reference in `invoices` points at an `_id` in `contacts` and
 * the two are rewritten in whatever order the bundle happens to list them.
 */
function buildIdMap(byCollection: Map<string, any[]>): Map<string, any> {
  const map = new Map<string, any>()
  for (const [name, docs] of byCollection) {
    // People keep their ids, and so every `User.identityId` that points at them keeps pointing at
    // them: a copied membership stays the membership of the same person. A person is global, not
    // a row of the origin org that needs a copy of its own.
    if (name === PEOPLE_MODEL) continue
    for (const d of docs) {
      const id = String(d?._id ?? '')
      if (id && !map.has(id)) map.set(id, new mongoose.Types.ObjectId())
    }
  }
  return map
}

/**
 * Rewrite one document onto the target org: its `_id`, its `orgId`, every reference to
 * another document in the same bundle, and the paths that embed the origin org's identity.
 *
 * ⚠ The reference rewrite is by VALUE, recursively, rather than by a list of known ref paths.
 * A hand-maintained list of "fields that hold an ObjectId" across 83 models is wrong the
 * first time a model gains a field — the same latent bug `tenantCollections()` exists to
 * avoid on the write side. Matching on the value means only ids that are actually in this
 * bundle are touched; a 24-hex string that is not one is left exactly as it was.
 *
 * `DocFile.currentPath` and `File.storagePath` are handled separately because they are PATHS,
 * not references: they start with the org's id (`<orgId>/docs/…`, or under `<UPLOAD_DIR>` in a
 * bundle an older release wrote), and would otherwise keep pointing into another tenant's
 * directory on the volume. Both come out in the stored form (`storedPaths`).
 */
export function remapDoc(
  doc: any,
  targetOrgId: string | null,
  originOrgId: string,
  idMap?: Map<string, any>,
): any {
  if (!targetOrgId) return storedPaths(doc)

  const rewrite = (value: any): any => {
    if (value === null || value === undefined) return value
    if (Array.isArray(value)) return value.map(rewrite)
    if (typeof value === 'string') {
      const mapped = idMap?.get(value)
      return mapped !== undefined ? mapped : value
    }
    if (typeof value === 'object') {
      const out: any = {}
      for (const [k, v] of Object.entries(value)) out[k] = rewrite(v)
      return out
    }
    return value
  }

  const out = rewrite(doc)
  out.orgId = new mongoose.Types.ObjectId(targetOrgId)
  for (const key of ['currentPath', 'storagePath', 'path', 'filePath']) {
    if (key === 'storagePath' && out.storageProvider && out.storageProvider !== 'local') continue // a provider's key
    if (typeof out[key] === 'string' && out[key].includes(originOrgId)) {
      out[key] = out[key].split(originOrgId).join(targetOrgId)
    }
  }
  return storedPaths(out)
}

/**
 * FR-20.24 (P0b-8): a restored file path is written in the stored form, relative to the upload
 * root, whichever release wrote the bundle. A path under no known root is left as it is: the
 * restore goes on, and the reader names the file when it is opened. Another provider's
 * `storagePath` is a key, not a path, and is never touched.
 */
function storedPaths(doc: any): any {
  let out = doc
  for (const key of ['currentPath', 'storagePath'] as const) {
    const value = doc?.[key]
    if (typeof value !== 'string' || !value) continue
    if (key === 'storagePath' && doc.storageProvider && doc.storageProvider !== 'local') continue
    try {
      const stored = normalizeStored(value)
      if (stored !== value) { if (out === doc) out = { ...doc }; out[key] = stored }
    } catch { /* under no known root: left as it is */ }
  }
  return out
}

/**
 * FR-13.36 — may this org be Replaced at all?
 *
 * Returns the reason it may not, or `null`. Merge never asks: it cannot delete anything, so
 * none of what the ordinance forbids is reachable from it.
 */
export async function replaceBlockedReason(
  orgId: string,
  covers: { from?: Date; to?: Date },
): Promise<string | null> {
  const device: any = await FiscalDevice.findOne({ orgId, isActive: true }, { deviceNumber: 1 }).lean().exec()
  if (device) {
    return `this organisation has an active fiscal device (${device.deviceNumber}); ` +
      `Наредба Н-18 forbids deleting completed sales, so Replace is not available. Merge is.`
  }

  // A locked year INSIDE the bundle's window. With no window recorded — a first-ever run —
  // any locked year at all counts: an unbounded window cannot be proven not to overlap.
  const q: any = { orgId, status: 'locked' }
  if (covers.from) q.endDate = { $gte: covers.from }
  if (covers.to) q.startDate = { $lte: covers.to }
  const year: any = await FiscalYear.findOne(q, { name: 1 }).lean().exec()
  if (year) {
    return `fiscal year ${year.name} is locked and falls inside this bundle's range; ` +
      `Replace would delete documents from a closed period. Merge is available.`
  }
  return null
}

/**
 * FR-13.34 — the mandatory pre-restore safety bundle.
 *
 * ⚠ It is verified before it counts. An unverified safety copy is not a safety copy, and a
 * restore that cannot take one MUST abort (FR-13.34) rather than proceed hopefully — this is
 * the one moment where refusing to act is unambiguously the safe choice.
 *
 * Written to `backups/safety/`, outside the directory `pruneBundles` walks, so nightly
 * retention can never evict the copy taken immediately before an operator changed live data.
 */
async function takeSafetyBundle(orgId: string): Promise<{
  path: string; filename: string; absolutePath: string; bytes: number; sha256: string; documentCount: number
}> {
  const now = new Date()
  const date = now.toISOString().slice(0, 10)
  const built = await buildBundle(orgId, {
    kind: 'full',
    date,
    subdir: 'safety',
    filenameSuffix: `pre-restore-${now.toISOString().replace(/[:.]/g, '-')}`,
  })
  const verified = await verifyBundle(built.absolutePath, built.sha256)
  if (!verified.ok) {
    throw new Error(
      `the pre-restore safety bundle failed its own verification (${verified.problems.slice(0, 2).join('; ')}) — ` +
      `refusing to restore`,
    )
  }
  return {
    path: built.path,
    filename: built.filename,
    absolutePath: built.absolutePath,
    bytes: built.bytes,
    sha256: built.sha256,
    documentCount: built.manifest.documentCount,
  }
}

/** Insert in bounded batches, unordered, counting what the unique indexes refused. */
async function insertDocs(
  modelName: string,
  docs: any[],
): Promise<{ inserted: number; conflicts: number }> {
  const model = mongoose.models[modelName]
  if (!model || !docs.length) return { inserted: 0, conflicts: 0 }
  let inserted = 0
  let conflicts = 0

  for (let i = 0; i < docs.length; i += INSERT_BATCH) {
    const batch = docs.slice(i, i + INSERT_BATCH).map(d => castForModel(modelName, d))
    try {
      // `rawResult: false` + `ordered: false`: one document refused by a unique index must not
      // stop the other 499. Bypassing validation is deliberate — these documents were valid
      // when they were written, and a schema that has tightened since must not silently drop
      // history on the way back in. The bundle's own checksums are the integrity story here.
      const res: any = await model.collection.insertMany(batch, { ordered: false })
      inserted += res?.insertedCount ?? batch.length
    } catch (e: any) {
      // A bulk write error still inserts everything that did not conflict; the count of what
      // landed is on the error, not the exception being an all-or-nothing signal.
      inserted += e?.result?.nInserted ?? e?.insertedCount ?? 0
      const writeErrors = e?.writeErrors || e?.result?.result?.writeErrors || []
      conflicts += Array.isArray(writeErrors) ? writeErrors.length : 1
      if (!writeErrors.length && !e?.result) throw e
    }
  }
  return { inserted, conflicts }
}

/**
 * FR-13.35 — `Sequence` rows are never restored, only raised.
 *
 * ⚠ This is why `Sequence` is handled outside the ordinary insert path in BOTH modes. A merge
 * would skip an existing sequence row and leave live alone, which is accidentally correct; a
 * replace would delete and reinstate the bundle's value, which is the fiscal defect §8
 * forbids. Making it explicit means neither mode can regress into the other's behaviour, and
 * every clamp is recorded with what it kept and what it refused.
 */
async function reconcileSequences(
  orgId: string,
  bundleRows: any[],
  remapTo: string | null,
  originOrgId: string,
  idMap?: Map<string, any>,
): Promise<{ clamps: any[]; inserted: number }> {
  const model = mongoose.models.Sequence
  if (!model || !bundleRows.length) return { clamps: [], inserted: 0 }
  const clamps: any[] = []
  let inserted = 0

  for (const raw of bundleRows) {
    const row = remapDoc(raw, remapTo, originOrgId, idMap)
    const live: any = await model.findOne(
      { orgId: row.orgId, prefix: row.prefix, year: row.year },
      { lastNumber: 1 },
    ).lean().exec()

    if (!live) {
      await model.collection.insertOne(castForModel('Sequence', row))
      inserted++
      continue
    }
    const liveLast = Number(live.lastNumber) || 0
    const bundleLast = Number(row.lastNumber) || 0
    const kept = Math.max(liveLast, bundleLast)
    if (kept !== liveLast || bundleLast !== liveLast) {
      clamps.push({ prefix: row.prefix, year: row.year, live: liveLast, bundle: bundleLast, kept })
    }
    if (kept !== liveLast) {
      await model.updateOne({ _id: live._id }, { $set: { lastNumber: kept } }).exec()
    }
  }
  return { clamps, inserted }
}

/**
 * The people a bundle carries (see `PEOPLE_MODEL`): the missing ones are inserted and the rest are
 * left exactly as they are, in BOTH modes, and none is remapped.
 *
 * ⚠ A person is shared by every org they work in, so the live row is always the authority:
 *  - Replace deleting one would sign them out of orgs this restore is not about;
 *  - updating one would put back an old password (perhaps the very one they changed because it
 *    leaked) and an old `tokenVersion`, which brings back sessions the change had ended.
 * All a restore must guarantee is that every membership it brings back has its person.
 *
 * Returns the ids it inserted, so a rollback removes exactly those and nobody else.
 */
async function restorePeople(bundleDocs: any[]): Promise<{
  inBundle: number
  present: number
  inserted: number
  conflicts: number
  insertedIds: any[]
}> {
  const live = await livePeopleHashes(bundleDocs)
  // A restored person starts with no live sessions: with the bundle's `tokenVersion` unchanged, a
  // token issued before they were lost would validate again the moment they reappear.
  const absent = bundleDocs
    .filter(d => !live.has(String(d?._id)))
    .map(d => ({ ...d, tokenVersion: (Number(d?.tokenVersion) || 0) + 1 }))
  const { inserted, conflicts } = await insertDocs(PEOPLE_MODEL, absent)
  // Which of the absent ones exist NOW. One refused by the unique email index (the person exists
  // under another record) did not land, and must not be rolled back either.
  const landed = await livePeopleHashes(absent)
  return {
    inBundle: bundleDocs.length,
    present: live.size,
    inserted,
    conflicts,
    insertedIds: [...landed.keys()].map(id => new mongoose.Types.ObjectId(id)),
  }
}

/**
 * FR-13.37 — `DocFile` rows whose bytes are not on the PV.
 *
 * A data-only restore reinstates the document index and not one document. Counting this is
 * the difference between an operator who knows the PDFs are still missing and one who finds
 * out when a customer asks for an invoice.
 */
async function countDangling(orgId: string): Promise<{ count: number; sample: string[] }> {
  const model = mongoose.models.DocFile
  if (!model) return { count: 0, sample: [] }
  const root = resolve(orgDocsDir(orgId))
  let count = 0
  const sample: string[] = []

  const cursor = model.find({ orgId }, { currentPath: 1, originalName: 1, docDate: 1 }).lean().cursor()
  for await (const doc of cursor as any) {
    const p = (doc as any).currentPath
    if (!p) continue
    // Only the org's own tree is checked; a path pointing anywhere else is dangling by
    // definition here, and saying so is more useful than following it. Either form of stored
    // path (FR-20.24); one that resolves nowhere is dangling too.
    let abs: string
    try { abs = resolve(resolveStored(String(p), orgId)) } catch { abs = '' }
    const inside = abs === root || abs.startsWith(root + sep)
    let exists = false
    if (inside) {
      try { await stat(abs); exists = true } catch { exists = false }
    }
    if (!exists) {
      count++
      if (sample.length < DANGLING_SAMPLE) {
        sample.push(`${(doc as any).docDate || ''}/${(doc as any).originalName || abs}`)
      }
    }
  }
  return { count, sample }
}

/**
 * Undo a part-way restore from the safety bundle (FR-13.34).
 *
 * Deliberately narrow: only the collections the restore actually touched are reset, and each
 * is reset to exactly what the safety bundle holds. A broader sweep would be a second
 * destructive operation performed by code that has just proven it can fail.
 */
async function rollbackFromSafety(
  orgId: string,
  safetyPath: string,
  touched: string[],
  insertedPeople: any[] = [],
): Promise<string> {
  const { byCollection } = await readBundle(safetyPath)
  const notes: string[] = []
  for (const name of touched) {
    const model = mongoose.models[name]
    if (!model) continue
    const docs = byCollection.get(name) || []
    await model.collection.deleteMany({ orgId: new mongoose.Types.ObjectId(String(orgId)) })
    const { inserted } = await insertDocs(name, docs)
    notes.push(`${name}: ${inserted}`)
  }
  // A restore never deletes or changes a person, so the safety copy has nothing to put back for
  // them. What a rollback owes is removing the people THIS restore added, and nobody else.
  if (insertedPeople.length) {
    const removed: any = await Identity.collection.deleteMany({ _id: { $in: insertedPeople } })
    notes.push(`${PEOPLE_MODEL}: ${removed?.deletedCount ?? 0} added by this restore removed`)
  }
  return `restored from the pre-restore safety bundle — ${notes.join(', ')}`
}

/**
 * FR-13.33/13.34 — a writing restore.
 *
 * Order matters and every step is a gate: authorise → verify → refuse the impossible → take
 * the safety copy → write → report. Nothing after the safety copy is allowed to leave the org
 * in a state the safety copy cannot undo.
 */
export async function applyRestore(
  orgId: string,
  src: RestoreSourceRef,
  opts: RestoreOptions,
): Promise<any> {
  // FR-20.4: a restore rewrites the org's collections with raw driver writes, which the Mongoose
  // write guard cannot see — so it asks first. Restoring an org happens at its home, or nowhere.
  await assertHomeIsHere(orgId)
  const started = Date.now()
  const resolved = await resolveSource(orgId, src)

  // ── FR-13.33: Inspect must have run, on THIS bundle ──────────────────────────
  //
  // ⚠ The inspection is matched on its checksum, not merely on its id. Otherwise "Inspect
  // must have run first" is satisfied by having inspected some other file — which is exactly
  // the mistake a tired operator makes at 2 a.m. with two bundles open.
  if (!opts.inspectionId || !mongoose.Types.ObjectId.isValid(opts.inspectionId)) {
    throw new Error('this restore has not been inspected — run Inspect first')
  }
  const inspection: any = await RestoreRun.findOne({
    _id: opts.inspectionId, orgId, mode: 'inspect', status: 'completed',
  }).lean().exec()
  if (!inspection) throw new Error('this restore has not been inspected — run Inspect first')

  const actualSha = await shaOfFile(resolved.absolutePath)
  if (inspection.bundleSha256 && inspection.bundleSha256 !== actualSha) {
    throw new Error('the inspected bundle is not the bundle being restored — inspect this one first')
  }

  const row: any = await RestoreRun.create({
    orgId,
    mode: opts.mode,
    status: 'running',
    source: { type: src.type, runId: src.runId, path: resolved.absolutePath, filename: resolved.filename },
    bundleSha256: actualSha,
    inspectionId: inspection._id,
    remap: !!opts.remap,
    actorUserId: opts.actor?.userId,
    actorEmail: opts.actor?.email,
    startedAt: new Date(),
  })

  const warnings: string[] = []
  const touched: string[] = []
  /** People this restore inserted: the only ones a rollback may remove. */
  const insertedPeople: any[] = []
  let safety: Awaited<ReturnType<typeof takeSafetyBundle>> | null = null

  try {
    // ── FR-13.31: integrity, again, on the artifact as it is RIGHT NOW ──────────
    const verified = await verifyBundle(resolved.absolutePath, resolved.expectedSha)
    if (!verified.ok) {
      throw new Error(`bundle failed verification: ${verified.problems.slice(0, 3).join('; ')}`)
    }

    const { manifest, byCollection } = await readBundle(resolved.absolutePath)
    if (manifest.schemaVersion !== BUNDLE_FORMAT) {
      throw new Error(`bundle schema ${manifest.schemaVersion} is not ${BUNDLE_FORMAT}`)
    }

    // ── FR-13.32: the cross-tenant refusal ─────────────────────────────────────
    const crossOrg = String(manifest.orgId) !== String(orgId)
    if (crossOrg && !opts.remap) {
      throw new Error(
        `this bundle belongs to organisation ${manifest.orgId}; restoring it here without a remap would write ` +
        `documents that tenantPlugin hides from every query. Ask for a remap explicitly.`,
      )
    }
    const remapTo = crossOrg ? String(orgId) : null

    const org: any = await Org.findById(orgId, { slug: 1, name: 1 }).lean().exec()
    if (!org) throw new Error('no such organisation')

    // ── FR-13.33/13.36: Replace's two gates ────────────────────────────────────
    if (opts.mode === 'replace') {
      if (String(opts.confirmSlug || '') !== String(org.slug || '')) {
        throw new Error('Replace requires the organisation’s slug to be typed to confirm it')
      }
      const blocked = await replaceBlockedReason(orgId, {
        from: manifest.coversFrom ? new Date(manifest.coversFrom) : undefined,
        to: manifest.coversTo ? new Date(manifest.coversTo) : undefined,
      })
      if (blocked) throw new Error(blocked)
    }

    // ── FR-13.34: the safety bundle, before a single write ─────────────────────
    safety = await takeSafetyBundle(orgId)
    await RestoreRun.updateOne({ _id: row._id }, {
      $set: {
        safetyPath: safety.path,
        safetyFilename: safety.filename,
        safetyBytes: safety.bytes,
        safetySha256: safety.sha256,
        safetyDocumentCount: safety.documentCount,
      },
    }).exec()

    // ── Write ──────────────────────────────────────────────────────────────────
    // FR-13.32 — built once, across every collection, before a single document is rewritten.
    const idMap = remapTo ? buildIdMap(byCollection) : undefined

    const results: any[] = []
    let documentsInserted = 0
    let documentsDeleted = 0
    let sequenceClamps: any[] = []

    // People first, so every membership written below has its person (see `restorePeople`).
    const peopleDocs = byCollection.get(PEOPLE_MODEL) || []
    if (peopleDocs.length) {
      const people = await restorePeople(peopleDocs)
      insertedPeople.push(...people.insertedIds)
      documentsInserted += people.inserted
      if (people.conflicts) {
        warnings.push(
          `${PEOPLE_MODEL}: ${people.conflicts} people in this bundle already exist under a different record ` +
          `with the same email, so they were not inserted; restored memberships that point at them need relinking`,
        )
      }
      results.push({
        name: PEOPLE_MODEL,
        inBundle: people.inBundle,
        inLive: people.present,
        missing: people.inBundle - people.present,
        differing: 0,
        inserted: people.inserted,
        deleted: 0,
        skipped: people.inBundle - people.inserted,
      })
    }

    for (const [name, rawDocs] of byCollection) {
      if (name === PEOPLE_MODEL) continue
      // ⚠ A section this deployment no longer bundles, from a bundle made before it stopped: node
      // state (FR-20.3) or the scheduler's bookkeeping. Restoring it would rewrite who the org's
      // home is, or revive a job owned by a process that is not here. Reported, never written.
      const excluded = bundleExclusion(name)
      if (excluded) {
        if (rawDocs.length) warnings.push(`${name}: ${rawDocs.length} documents in the bundle are ${excluded === 'node_state' ? 'node state' : 'operational records'} and were not restored`)
        continue
      }
      const model = mongoose.models[name]
      if (!model) {
        // A collection this deployment no longer has. Reported, never silently dropped: the
        // operator restoring a two-year-old bundle needs to know what did not come back.
        warnings.push(`${name}: ${rawDocs.length} documents in the bundle have no model in this deployment`)
        continue
      }

      // FR-13.35 — sequences never take the ordinary path in either mode.
      if (name === 'Sequence') {
        touched.push(name)
        const seq = await reconcileSequences(orgId, rawDocs, remapTo, String(manifest.orgId), idMap)
        sequenceClamps = seq.clamps
        documentsInserted += seq.inserted
        results.push({
          name, inBundle: rawDocs.length, inLive: await model.countDocuments({ orgId }).exec(),
          missing: 0, differing: seq.clamps.length, inserted: seq.inserted, deleted: 0,
          skipped: rawDocs.length - seq.inserted,
        })
        continue
      }

      const docs = rawDocs.map(d => remapDoc(d, remapTo, String(manifest.orgId), idMap))
      touched.push(name)

      if (opts.mode === 'replace') {
        const del: any = await model.collection.deleteMany({
          orgId: new mongoose.Types.ObjectId(String(orgId)),
        })
        const deleted = del?.deletedCount || 0
        documentsDeleted += deleted
        const { inserted, conflicts } = await insertDocs(name, docs)
        documentsInserted += inserted
        if (conflicts) warnings.push(`${name}: ${conflicts} documents were refused by a unique index`)
        results.push({
          name, inBundle: docs.length, inLive: inserted, missing: 0, differing: 0,
          inserted, deleted, skipped: docs.length - inserted,
        })
        continue
      }

      // Merge: insert ONLY what live does not have. Never update, never delete — that is the
      // whole promise of the mode, and it is what makes it safe enough to be the answer to
      // "something was deleted by mistake".
      const live = await liveHashes(name, orgId)
      const absent = docs.filter(d => !live.has(String(d?._id)))
      const { inserted, conflicts } = await insertDocs(name, absent)
      documentsInserted += inserted
      if (conflicts) warnings.push(`${name}: ${conflicts} documents were refused by a unique index`)
      const differing = docs.length - absent.length
      results.push({
        name,
        inBundle: docs.length,
        inLive: live.size,
        missing: absent.length,
        differing: 0,
        inserted,
        deleted: 0,
        skipped: differing,
      })
    }
    results.sort((a, b) => a.name.localeCompare(b.name))

    // ── FR-13.29/13.37: the files, and the ones that are not there ─────────────
    let filesNote = ''
    if (opts.restoreFiles) {
      const sidecar = resolved.absolutePath.replace(/\.ndjson\.zst$/, '.files.ndjson.zst')
      // A sidecar that is missing and one that is there but will not read back are different
      // problems, and one catch used to report both as "no files sidecar".
      const present = await stat(sidecar).then(() => true, () => false)
      if (!present) {
        warnings.push('this bundle has no files sidecar — the document rows were restored without their files')
      } else {
        try {
          const fr = await restoreFilesSidecar(sidecar, String(orgId))
          filesNote = `${fr.written} files restored`
          if (fr.checksumFailures.length) {
            warnings.push(
              `${fr.checksumFailures.length} restored files failed their checksum: ` +
              fr.checksumFailures.slice(0, 10).join(', '),
            )
          }
          if (fr.refused.length) {
            warnings.push(`${fr.refused.length} entries in the files sidecar named a path outside this org and were refused`)
          }
        } catch (e: any) {
          warnings.push(`the files sidecar did not read back (${e?.message || e}) — some or all of the files were not restored`)
        }
      }
    }

    const dangling = await countDangling(orgId)
    if (dangling.count) {
      warnings.push(
        `${dangling.count} DocFile rows point at bytes that are not on the volume` +
        (filesNote ? ` (${filesNote})` : ' — a data-only restore does not bring the documents themselves back'),
      )
    }

    await RestoreRun.updateOne({ _id: row._id }, {
      $set: {
        status: 'completed',
        manifestOrgId: String(manifest.orgId),
        bundleDate: manifest.date,
        bundleKind: manifest.kind,
        bundleAppImageTag: manifest.appImageTag,
        runningAppImageTag: process.env.LGR_IMAGE_TAG || process.env.IMAGE_TAG || 'unknown',
        collections: results,
        documentsInserted,
        documentsDeleted,
        sequenceClamps,
        danglingFiles: dangling.sample,
        danglingFileCount: dangling.count,
        warnings,
        completedAt: new Date(),
        durationMs: Date.now() - started,
      },
    }).exec()

    logger.warn(
      { orgId, mode: opts.mode, inserted: documentsInserted, deleted: documentsDeleted, actor: opts.actor?.email },
      'Restore applied to live data',
    )

    // FR-13.37 — an operator act against live data, named in full.
    if (opts.actor?.userId) {
      createAuditEntry({
        orgId, userId: opts.actor.userId, action: 'update', module: 'admin',
        entityType: 'restore', entityId: String(row._id),
        entityName: `${opts.mode} ${resolved.filename}`,
        changes: [
          { field: 'documentsInserted', oldValue: 0, newValue: documentsInserted },
          { field: 'documentsDeleted', oldValue: 0, newValue: documentsDeleted },
          { field: 'bundleSha256', oldValue: null, newValue: actualSha },
        ],
      })
    }

    return RestoreRun.findById(row._id).lean().exec()
  } catch (e: any) {
    // ── FR-13.34: undo, then report what the undo did ──────────────────────────
    let rolledBack = false
    let rollbackDetail = ''
    if (safety && (touched.length || insertedPeople.length)) {
      try {
        rollbackDetail = await rollbackFromSafety(orgId, safety.absolutePath, touched, insertedPeople)
        rolledBack = true
      } catch (re: any) {
        // The worst case, and it must be stated in the loudest terms available rather than
        // folded into the original error: live data is now neither the bundle nor what it was.
        rollbackDetail = `THE ROLLBACK ALSO FAILED (${re?.message}). The pre-restore safety bundle is at ` +
          `${safety.path} and must be restored by hand.`
        logger.error({ orgId, safety: safety.path, err: re?.message }, 'Restore rollback FAILED')
      }
    }

    await RestoreRun.updateOne({ _id: row._id }, {
      $set: {
        status: rolledBack ? 'rolled_back' : 'failed',
        error: e?.message || 'restore failed',
        rolledBack,
        rollbackDetail: rollbackDetail || undefined,
        warnings,
        completedAt: new Date(),
        durationMs: Date.now() - started,
      },
    }).exec()

    logger.error({ orgId, mode: opts.mode, err: e?.message, rolledBack }, 'Restore failed')
    throw Object.assign(e, { restoreRunId: String(row._id), rolledBack, rollbackDetail })
  }
}
