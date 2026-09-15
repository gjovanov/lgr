/**
 * FR-13.38–13.42 (#24) — cold storage for document bytes.
 *
 * ⚠ SERVER-ONLY. Reads and writes the uploads PV.
 *
 * **What moves and what does not.** Bytes move; rows never do (FR-13.40). regal-pz's database
 * grows 169 MB/yr — ten years is 1.76 GB, 68 MB compressed, which is not a problem anyone
 * needs solved. `docs/` grows 0.68 GB/yr against a declared 5 Gi PV and crosses it in YEAR 7.
 * Archiving rows would cost compliance and save nothing measurable.
 *
 * **Why the row has to stay live.** Приложение 29 т. 16 requires archived data to remain
 * reachable „през потребителски интерфейс" and т. 19 requires the `nra_auditor` profile to
 * reach it. So an archived document is still listed, still searchable, still openable — the
 * only difference is that asking for its bytes rehydrates one member out of the unit first.
 * A tarball in a bucket with nothing pointing at it is precisely the design the ordinance
 * forbids, and it is the obvious implementation, which is why this comment exists.
 *
 * **Format** — the NDJSON-under-zstd container `backup-files.service.ts` already writes,
 * deliberately NOT `.tar.zst` as the plan sketched:
 *
 *     {"format":"lgr-archive-1","orgId":"…","fiscalYear":"2023","createdAt":"…"}
 *     {"path":"2023-04-11/фактура-1234.pdf","size":81234,"sha256":"…","b64":"…"}
 *
 * ⚠ Three reasons, and the third is the load-bearing one. (1) No tar library exists in this
 * repo and archiving does not justify a dependency. (2) It is the same container the backup
 * sidecar uses, so there is ONE format to understand and one to debug — `zstd -dc | head`
 * points at either. (3) A line format can be read a MEMBER AT A TIME: rehydrating one invoice
 * out of a year streams until it finds that path and stops, where tar would have to be walked
 * and, compressed, decompressed from the start. Rehydrate-one is the common case by far.
 *
 * ⚠ NOTHING IS DELETED BEFORE IT IS PROVEN READABLE. The unit is written, then re-read from
 * disk and every member's sha256 recomputed and checked against `DocFile.currentChecksum`,
 * and only then are the loose files removed. An archive that has not demonstrated it can give
 * the bytes back is not an archive, it is a deletion with extra steps — and the failure would
 * surface years later, when the auditor asks, with every backup that held the file rotated.
 */

import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, unlink, stat } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { pipeline } from 'node:stream/promises'
import zlib from 'node:zlib'
import { ArchiveUnit, DocFile, FiscalYear } from 'db/models'
import { config } from 'config'
import { logger } from '../../logger/logger.js'

export const ARCHIVE_FORMAT = 'lgr-archive-1'

/** `<UPLOAD_DIR>/<orgId>/archives` — beside `docs/` and `backups/`, never inside them. */
export function orgArchiveDir(orgId: string): string {
  return join(config.upload.dir, String(orgId), 'archives')
}

/** `<UPLOAD_DIR>/<orgId>/docs` — the tree `doc-store.service.ts` writes into. */
export function orgDocsDir(orgId: string): string {
  return join(config.upload.dir, String(orgId), 'docs')
}

function zstdStream(level: number) {
  const z: any = zlib
  if (typeof z.createZstdCompress !== 'function') {
    throw new Error('zlib.createZstdCompress is unavailable in this runtime')
  }
  return z.createZstdCompress({ params: { [z.constants.ZSTD_c_compressionLevel]: level } })
}

function unzstdStream() {
  const z: any = zlib
  if (typeof z.createZstdDecompress !== 'function') {
    throw new Error('zlib.createZstdDecompress is unavailable in this runtime')
  }
  return z.createZstdDecompress()
}

/**
 * Refuse any path that escapes the org's own `docs/` tree.
 *
 * ⚠ A unit's member paths are data, and a unit can arrive from a restore. Without this, a
 * crafted `../../` entry rehydrates over another org's document or over the application
 * itself. The same check guards the backup sidecar for the same reason; neither is the
 * other's backup.
 */
function assertInsideDocs(orgId: string, absolutePath: string): void {
  const root = resolve(orgDocsDir(orgId))
  const target = resolve(absolutePath)
  if (target !== root && !target.startsWith(root + sep)) {
    throw new Error('refusing an archive member path outside the org docs directory')
  }
}

/** A `YYYY-MM-DD` string from a Date, in UTC — `DocFile.docDate` is stored in this shape. */
const isoDay = (d: Date) => new Date(d).toISOString().slice(0, 10)

export interface ArchivableYear {
  fiscalYearId: string
  name: string
  coversFrom: string
  coversTo: string
  fileCount: number
  contentBytes: number
  /** Already has a unit — listed so the UI can show it rather than silently omitting it. */
  archived: boolean
}

/**
 * Which of an org's fiscal years may be packed.
 *
 * ⚠ `status: 'locked'` AND past the horizon, never age alone. Age would pack away a year
 * still being corrected; `locked` is the org saying it is finished with it, and the horizon
 * is the grace on top so a year locked early is not cold-stored while it is still being
 * opened weekly.
 */
export async function archivableYears(orgId: string, now = new Date()): Promise<ArchivableYear[]> {
  const cutoff = new Date(now)
  cutoff.setFullYear(cutoff.getFullYear() - config.archive.horizonYears)

  const years: any[] = await FiscalYear.find(
    { orgId, status: 'locked', endDate: { $lt: cutoff } },
    { name: 1, startDate: 1, endDate: 1 },
  ).sort({ startDate: -1 }).lean().exec()

  const out: ArchivableYear[] = []
  for (const y of years) {
    const coversFrom = isoDay(y.startDate)
    const coversTo = isoDay(y.endDate)
    // ⚠ `packed`, not merely "a unit row exists". Un-archiving leaves the row behind on
    // purpose (the artifact is kept), so testing for existence made an un-archive a ONE-WAY
    // trip: the year showed as archived, offered no button, and the API refused it as a
    // duplicate — the year could never be re-packed.
    const existing = await ArchiveUnit.findOne({ orgId, fiscalYearId: y._id }, { status: 1 }).lean().exec()
    const docs: any[] = await DocFile.find(
      { orgId, docDate: { $gte: coversFrom, $lte: coversTo }, archived: { $ne: true } },
      { size: 1 },
    ).lean().exec()
    out.push({
      fiscalYearId: String(y._id),
      name: y.name,
      coversFrom,
      coversTo,
      fileCount: docs.length,
      contentBytes: docs.reduce((n, d) => n + (d.size || 0), 0),
      archived: (existing as any)?.status === 'packed',
    })
  }
  return out
}

export interface ArchiveOutcome {
  unitId: string
  status: 'packed' | 'failed'
  fileCount: number
  bytes: number
  contentBytes: number
  /** Documents whose bytes could not be read at pack time — recorded, never silently dropped. */
  missing: string[]
  /** Members whose re-read sha256 did not match. Non-empty means NOTHING was deleted. */
  checksumFailures: string[]
  reason?: string
}

/**
 * Pack one locked fiscal year's documents into an archive unit.
 *
 * The sequence is deliberate and is the same one `archive.rs` uses on the desktop: build,
 * verify from disk, and only then remove. Each step is separately observable, and the
 * destructive one is last and conditional.
 */
export async function archiveFiscalYear(
  orgId: string,
  fiscalYearId: string,
  opts: { actorUserId?: string } = {},
): Promise<ArchiveOutcome> {
  const fy: any = await FiscalYear.findOne({ orgId, _id: fiscalYearId }).lean().exec()
  if (!fy) throw new Error('fiscal year not found')
  if (fy.status !== 'locked') {
    throw new Error(`refusing to archive a fiscal year that is ${fy.status}, not locked`)
  }

  const coversFrom = isoDay(fy.startDate)
  const coversTo = isoDay(fy.endDate)

  // The claim, exactly as `BackupRun`'s: the unique index IS the lock. Two packers on one year
  // would each delete the loose files the other is still reading.
  //
  // ⚠ Claimed with `status: { $ne: 'packed' }` rather than a plain insert, so a year that was
  // un-archived — or one whose previous attempt FAILED verification — can be packed again by
  // reusing its row. A plain insert made both of those permanent: the unique index rejected
  // the retry, and the only route back was deleting the row by hand in Mongo.
  //
  // Atomic on purpose. The filter misses a row that is already `packed`, so the upsert tries
  // to insert, hits the unique index and lands in the catch — rather than two reads racing to
  // the same conclusion. (A concurrent second press while one is `building` does take the row
  // over; this is an operator-triggered action, so that is a far smaller risk than a year that
  // can never be re-packed.)
  let unit: any
  try {
    unit = await ArchiveUnit.findOneAndUpdate(
      { orgId, fiscalYearId: fy._id, status: { $ne: 'packed' } },
      {
        $set: {
          orgId, fiscalYearId: fy._id, fiscalYearName: fy.name,
          coversFrom, coversTo, status: 'building', createdBy: opts.actorUserId,
        },
        $unset: { reason: '', completedAt: '', destinations: '' },
      },
      { new: true, upsert: true },
    ).exec()
  } catch (e: any) {
    if (e?.code === 11000 || /E11000/.test(String(e?.message))) {
      throw new Error('this fiscal year is already archived')
    }
    throw e
  }

  const out: ArchiveOutcome = {
    unitId: String(unit._id),
    status: 'failed',
    fileCount: 0,
    bytes: 0,
    contentBytes: 0,
    missing: [],
    checksumFailures: [],
  }

  try {
    const docs: any[] = await DocFile.find(
      { orgId, docDate: { $gte: coversFrom, $lte: coversTo }, archived: { $ne: true } },
      { currentPath: 1, originalName: 1, docDate: 1, currentChecksum: 1, size: 1 },
    ).lean().exec()

    const dir = orgArchiveDir(orgId)
    await mkdir(dir, { recursive: true })
    const filename = `lgr-archive-${fy.name.replace(/[^A-Za-z0-9._-]/g, '-')}.ndjson.zst`
    const absolutePath = join(dir, filename)

    const gz = zstdStream(config.archive.compressionLevel)
    const outStream = createWriteStream(absolutePath)
    const hash = createHash('sha256')
    let bytes = 0
    // Hash the COMPRESSED stream as it goes past, so the artifact is never read a second time
    // just to learn its own checksum.
    gz.on('data', (chunk: Buffer) => { hash.update(chunk); bytes += chunk.length })
    const done = pipeline(gz, outStream)

    const write = (line: string) => new Promise<void>((res, rej) => {
      gz.write(line + '\n', (e: any) => (e ? rej(e) : res()))
    })

    await write(JSON.stringify({
      format: ARCHIVE_FORMAT,
      orgId: String(orgId),
      fiscalYear: fy.name,
      coversFrom,
      coversTo,
      createdAt: new Date().toISOString(),
    }))

    /** What each doc is stored under inside the unit, and where it is rehydrated to. */
    const memberPath = (d: any) => `${d.docDate}/${d.originalName}`

    const packed: Array<{ id: string; path: string; sha256: string; rowChecksum?: string }> = []
    let contentBytes = 0
    for (const d of docs) {
      let content: Buffer
      try {
        content = Buffer.from(await Bun.file(d.currentPath).arrayBuffer())
      } catch (e: any) {
        // A row whose byte is already gone. Recorded and skipped — it must NOT be marked
        // archived, or the row would claim bytes that were never packed, which is worse than
        // the dangling row it already is.
        out.missing.push(memberPath(d))
        logger.warn({ orgId, doc: String(d._id), err: e?.message }, 'Archive: a document file could not be read')
        continue
      }
      const sha = createHash('sha256').update(content).digest('hex')
      await write(JSON.stringify({
        // POSIX separators inside the artifact regardless of the host that wrote it.
        path: memberPath(d).split(sep).join('/'),
        size: content.length,
        sha256: sha,
        docFileId: String(d._id),
        b64: content.toString('base64'),
      }))
      packed.push({ id: String(d._id), path: memberPath(d), sha256: sha, rowChecksum: d.currentChecksum })
      contentBytes += content.length
    }

    gz.end()
    await done

    const sha256 = hash.digest('hex')
    out.fileCount = packed.length
    out.bytes = bytes
    out.contentBytes = contentBytes

    await ArchiveUnit.updateOne({ _id: unit._id }, {
      $set: {
        status: 'verified', path: join(String(orgId), 'archives', filename), filename,
        sha256, bytes, fileCount: packed.length, contentBytes,
      },
    }).exec()

    // ⚠ VERIFY BEFORE DELETING, by re-reading the artifact from disk rather than trusting the
    // buffers still in memory. Those are what was intended to be written; the file is what
    // was written. A truncated write, a full disk, a compression bug — each produces an
    // artifact that looks correct to the process that just made it.
    const seen = new Map<string, string>()
    for await (const line of iterateUnitLines(absolutePath)) {
      let rec: any
      try { rec = JSON.parse(line) } catch { continue }
      if (!rec?.b64 || !rec?.path) continue
      const buf = Buffer.from(rec.b64, 'base64')
      seen.set(rec.path, createHash('sha256').update(buf).digest('hex'))
    }
    for (const p of packed) {
      const got = seen.get(p.path.split(sep).join('/'))
      // Does the artifact reproduce what was put into it? Catches a truncated write, a full
      // disk, a compression bug — anything between "intended to write" and "wrote".
      if (got !== p.sha256) { out.checksumFailures.push(p.path); continue }
      // ⚠ And does it match what the ROW says it should be? `DocFile.currentChecksum` is the
      // recorded identity of the canonical bytes. A mismatch means the file on the PV is not
      // the file the database describes — bit rot, a partial upload, an out-of-band edit —
      // and archiving is exactly the wrong moment to discover that quietly, because the next
      // step deletes the only loose copy. A disagreement between the row and the byte is
      // grounds to keep BOTH and let a human decide.
      if (p.rowChecksum && p.rowChecksum !== p.sha256) out.checksumFailures.push(p.path)
    }

    if (out.checksumFailures.length) {
      await ArchiveUnit.updateOne({ _id: unit._id }, {
        $set: { status: 'failed', reason: `${out.checksumFailures.length} members failed verification` },
      }).exec()
      out.status = 'failed'
      out.reason = 'verification failed; no files were removed'
      logger.error({ orgId, unit: String(unit._id), failures: out.checksumFailures.length },
        'Archive: verification failed — loose files left in place')
      return out
    }

    // Only now. Mark the rows first, then unlink: a crash between the two leaves a row that
    // says archived with the loose file still present, which rehydrate handles as a no-op.
    // The reverse order would leave a row claiming a file that is gone.
    for (const p of packed) {
      await DocFile.updateOne({ orgId, _id: p.id }, {
        $set: { archived: true, archiveRef: unit._id, archivedAt: new Date() },
      }).exec()
    }
    for (const d of docs) {
      if (!packed.find(p => p.id === String(d._id))) continue
      await unlink(d.currentPath).catch(() => { /* already gone is the desired state */ })
    }

    // FR-13.46 — get it off this node. Same destination service the nightly bundle uses, so
    // an archive is sealed with the same key and lands in the same Drive tree.
    //
    // ⚠ Its OWN folder, keyed by fiscal year. `pruneDriveGenerations` keeps the N newest
    // artifacts in a folder and FLOORS `keep` at 1, so archives sharing one folder would
    // evict each other — each new year silently deleting the last, which for a ten-year
    // retention obligation is the worst bug this file could have. A folder per year means
    // the only thing prune can ever see is that year's own artifact.
    //
    // ⚠ Never throws, and a failure does not fail the archive. The unit is packed, verified
    // and on the PV; an unreachable destination is a recorded gap, not a reason to undo
    // work that succeeded.
    const destinations = await pushArchiveOffsite(orgId, {
      fiscalYearName: fy.name, absolutePath, filename, sha256, coversFrom, coversTo,
      fileCount: packed.length,
    })

    await ArchiveUnit.updateOne({ _id: unit._id }, {
      $set: { status: 'packed', completedAt: new Date(), destinations },
    }).exec()
    out.status = 'packed'

    logger.info({ orgId, unit: String(unit._id), year: fy.name, files: packed.length, bytes, contentBytes },
      'Archive unit packed')
    return out
  } catch (e: any) {
    await ArchiveUnit.updateOne({ _id: unit._id }, {
      $set: { status: 'failed', reason: e?.message || 'archive failed' },
    }).exec()
    out.status = 'failed'
    out.reason = e?.message
    logger.error({ orgId, unit: String(unit._id), err: e?.message }, 'Archive failed')
    return out
  }
}

/**
 * Seal an archive unit and push it off the cluster, reusing the backup destination service.
 *
 * ⚠ Never throws. Mirrors `pushToDestinations`: the unit is packed, verified and on the PV,
 * and a destination that is unreachable today is a recorded gap the digest can report — not
 * a reason to undo an archive that succeeded.
 */
async function pushArchiveOffsite(orgId: string, a: {
  fiscalYearName: string
  absolutePath: string
  filename: string
  sha256: string
  coversFrom: string
  coversTo: string
  fileCount: number
}): Promise<any[]> {
  try {
    const { driveEnabled, s3Configured, pushArchiveToDestinations, DRIVE_SECTION } =
      await import('../backup/backup-destinations.service.js')
    if (!driveEnabled() && !s3Configured()) {
      return [{ name: 'google_drive', status: 'skipped', at: new Date(), reason: 'no off-site destination is configured' }]
    }
    const { Org } = await import('db/models')
    const org: any = await Org.findById(orgId, { slug: 1 }).lean().exec()
    // ⚠ BOTH tiers, not one with the other as a fallback (FR-13.58). Drive is where a human
    // can find a fiscal year; object storage under Object Lock is where it cannot be deleted
    // by the credential that wrote it. A ten-year retention obligation met only by a
    // destination whose writing key can also delete is met on paper.
    return await pushArchiveToDestinations({
      orgId,
      absolutePath: a.absolutePath,
      filename: a.filename,
      sha256: a.sha256,
      verify: true,
      // ⚠ Its own subtree: `<root>/Archive/<org>/<fiscal year>`, never inside `Backups/`.
      // The two rotate on completely different rules — 14 kept generations against a ten-year
      // legal retention — and a prune that could reach across them would delete a fiscal
      // year's only cold copy as though it were an old backup.
      section: DRIVE_SECTION.archive,
      // A folder per fiscal year. 10 is generous headroom for a year that gets re-packed
      // after an un-archive; the point is that prune can never reach ACROSS years, not that
      // ten copies are wanted.
      keep: 10,
      manifest: {
        format: ARCHIVE_FORMAT,
        orgSlug: org?.slug || String(orgId),
        kind: a.fiscalYearName,
        date: a.coversTo,
        documentCount: a.fileCount,
        coversFrom: a.coversFrom,
        coversTo: a.coversTo,
        appImageTag: process.env.LGR_IMAGE_TAG || process.env.IMAGE_TAG || 'unknown',
      } as any,
    })
  } catch (e: any) {
    logger.error({ orgId, err: e?.message }, 'Archive: the off-site push failed')
    return [{ name: 'google_drive', status: 'failed', at: new Date(), reason: e?.message || 'push failed' }]
  }
}

/** Yield one NDJSON line at a time from a unit, without holding the whole thing in memory. */
async function* iterateUnitLines(absolutePath: string): AsyncGenerator<string> {
  const source = createReadStream(absolutePath).pipe(unzstdStream())
  let carry = ''
  for await (const chunk of source as any) {
    carry += (chunk as Buffer).toString('utf8')
    let nl = carry.indexOf('\n')
    while (nl !== -1) {
      const line = carry.slice(0, nl)
      carry = carry.slice(nl + 1)
      if (line) yield line
      nl = carry.indexOf('\n')
    }
  }
  if (carry.trim()) yield carry
}

/**
 * Put ONE document's bytes back on the PV, on demand.
 *
 * ⚠ This is the common case and the reason the container is a line format. It streams until
 * it finds the member and stops — it does not unpack the year. At the projected volumes a
 * year is hundreds of MB and the caller is a browser waiting on a download.
 *
 * Idempotent: a file already present is left alone and reported as a hit, so a crash between
 * "mark archived" and "unlink" costs nothing.
 */
export async function rehydrateDocFile(orgId: string, docFileId: string): Promise<{
  path: string
  rehydrated: boolean
} | null> {
  const doc: any = await DocFile.findOne({ orgId, _id: docFileId }).lean().exec()
  if (!doc) return null
  if (!doc.archived || !doc.archiveRef) return { path: doc.currentPath, rehydrated: false }

  // Already on disk — the archive said so but the byte never left, or a previous rehydrate
  // put it back. Either way there is nothing to do.
  try {
    await stat(doc.currentPath)
    return { path: doc.currentPath, rehydrated: false }
  } catch { /* not there, which is the expected case */ }

  const unit: any = await ArchiveUnit.findOne({ orgId, _id: doc.archiveRef }).lean().exec()
  if (!unit?.filename) throw new Error('the archive unit for this document is missing')
  const absolutePath = join(orgArchiveDir(orgId), unit.filename)
  const wanted = `${doc.docDate}/${doc.originalName}`.split(sep).join('/')

  for await (const line of iterateUnitLines(absolutePath)) {
    let rec: any
    try { rec = JSON.parse(line) } catch { continue }
    if (rec?.path !== wanted) continue

    const buf = Buffer.from(rec.b64, 'base64')
    // ⚠ Checked on the way OUT as well as on the way in. The artifact has been sitting on a
    // PV for years; bit rot and a truncated restore are both real, and handing back silently
    // wrong bytes for a fiscal document is the worst outcome this feature can produce.
    const got = createHash('sha256').update(buf).digest('hex')
    if (rec.sha256 && got !== rec.sha256) {
      throw new Error('the archived bytes do not match their recorded checksum')
    }
    assertInsideDocs(orgId, doc.currentPath)
    await mkdir(join(orgDocsDir(orgId), doc.docDate), { recursive: true })
    await Bun.write(doc.currentPath, buf)
    logger.info({ orgId, doc: docFileId, unit: String(unit._id) }, 'Document rehydrated from archive')
    return { path: doc.currentPath, rehydrated: true }
  }

  throw new Error('this document is not present in its archive unit')
}

/**
 * Put a whole unit back and clear the flags.
 *
 * ⚠ The artifact is deliberately NOT deleted afterwards. It is verified, it is off-site, and
 * keeping it costs a file; removing it turns an un-archive into the only copy of an operation
 * that has just rewritten hundreds of files, with no way back if the PV write was wrong.
 */
export async function unarchiveUnit(orgId: string, unitId: string): Promise<{ restored: number; failures: string[] }> {
  const unit: any = await ArchiveUnit.findOne({ orgId, _id: unitId }).lean().exec()
  if (!unit?.filename) throw new Error('archive unit not found')
  const absolutePath = join(orgArchiveDir(orgId), unit.filename)

  let restored = 0
  const failures: string[] = []
  for await (const line of iterateUnitLines(absolutePath)) {
    let rec: any
    try { rec = JSON.parse(line) } catch { continue }
    if (!rec?.b64 || !rec?.path) continue

    const buf = Buffer.from(rec.b64, 'base64')
    if (rec.sha256 && createHash('sha256').update(buf).digest('hex') !== rec.sha256) {
      failures.push(rec.path)
      continue
    }
    const dest = join(orgDocsDir(orgId), ...String(rec.path).split('/'))
    try {
      assertInsideDocs(orgId, dest)
    } catch {
      failures.push(rec.path)
      continue
    }
    await mkdir(join(dest, '..'), { recursive: true })
    await Bun.write(dest, buf)
    restored++
  }

  // Flags come off only for what actually landed. A partial un-archive leaves the rest
  // correctly marked as still archived rather than claiming bytes that are not there.
  if (!failures.length) {
    await DocFile.updateMany({ orgId, archiveRef: unit._id }, {
      $unset: { archived: '', archiveRef: '', archivedAt: '' },
    }).exec()
    await ArchiveUnit.updateOne({ _id: unit._id }, { $set: { status: 'verified' } }).exec()
  }

  logger.info({ orgId, unit: unitId, restored, failures: failures.length }, 'Archive unit un-archived')
  return { restored, failures }
}
