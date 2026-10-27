/**
 * FR-13.29/13.37 (#24) â€” the `full` variant's second half: the org's `docs/` bytes.
 *
 * âš  SERVER-ONLY. Reads and writes the uploads PV.
 *
 * A `data` bundle is Mongo rows. It restores the document INDEX and not one document: every
 * `DocFile` row comes back pointing at a PDF that is not there. FR-13.37 requires that to be
 * counted and stated rather than discovered, and FR-13.29 requires a variant that actually
 * carries the files â€” 3.2 MiB of rows against ~80 MB of PDFs today, ~68 MB against ~6.9 GB at
 * year 10 (Â§2.3), which is also why the two are separate artifacts and separate decisions.
 *
 * **Format** â€” the same NDJSON-under-zstd shape as the row bundle, one line per file:
 *
 *     {"format":"lgr-backup-files-1","orgId":"â€¦","createdAt":"â€¦"}   â† header
 *     {"path":"2026-09-03/Ñ„Ð°ÐºÑ‚ÑƒÑ€Ð°-1234.pdf","size":81234,"sha256":"â€¦","b64":"â€¦"}
 *     â€¦
 *
 * âš  Written and read as a STREAM, never as one buffer. The row bundle can be decompressed
 * whole because Â§2.3 caps it at ~68 MB after ten years; this one is projected at 6.9 GB, so
 * `readFile`-then-`split` is not a slower implementation of the same thing, it is an OOM with
 * a schedule. Base64 costs 33 % on the wire and is what keeps the container a line format
 * that `zstd -dc | head` can still be pointed at â€” the property Â§5.7 leans on when the
 * restoring party may not have this codebase.
 *
 * âš  Paths inside are RELATIVE to `<UPLOAD_DIR>/<orgId>/docs/`. `DocFile.currentPath` is
 * absolute (`doc-store.service.ts:28`), which is fine while the row and the byte live on the
 * same PV and is exactly wrong across a remap â€” see `restoreFilesSidecar`.
 */

import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, readdir, stat, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { StringDecoder } from 'node:string_decoder'
import zlib from 'node:zlib'
import { config } from 'config'
import { logger } from '../../logger/logger.js'

export const FILES_SIDECAR_FORMAT = 'lgr-backup-files-1'

/** `<UPLOAD_DIR>/<orgId>/docs` â€” the tree `doc-store.service.ts` writes into. */
export function orgDocsDir(orgId: string): string {
  return join(config.upload.dir, String(orgId), 'docs')
}

/**
 * FR-20.21 (P1-9): a sidecar of the org's WHOLE upload tree (`<UPLOAD_DIR>/<orgId>/`, `backups/`
 * aside). A master's backup has to carry every file, because nothing like mars's Layer-1 rsync of
 * the uploads PV exists for it. Its paths are relative to the org's directory, which is why it is a
 * format of its own: a reader that only knows `-1` refuses it rather than putting files under
 * `docs/` that never lived there.
 */
export const FILES_SIDECAR_FORMAT_ORG = 'lgr-backup-files-2'

/** `<UPLOAD_DIR>/<orgId>`: everything the org has uploaded, its own backups beside it. */
export function orgUploadDir(orgId: string): string {
  return join(config.upload.dir, String(orgId))
}

/** Never inside an org-rooted sidecar: the backups, which are what holds it. */
const NOT_UPLOADS = new Set(['backups'])

const WINDOWS = process.platform === 'win32'
/** Where `Backups` and `backups` are one directory. */
const CASE_FOLDS = WINDOWS || process.platform === 'darwin'

function plainSegment(s: string): boolean {
  if (!s || s === '.' || s === '..' || s.includes('\0')) return false
  // Windows reads `\` as a separator, `:` as a stream, and strips a trailing dot or space:
  // `backups./x` opens `backups\x` there.
  if (WINDOWS && (/[\\:<>"|?*]/.test(s) || /[. ]$/.test(s))) return false
  return true
}

/**
 * Where a sidecar entry restores to, or null when a restore refuses it.
 *
 * A sidecar is an operator-supplied file on the restore path, so its paths are judged, not trusted:
 * every segment must be a plain name, the result must resolve inside `root` (already resolved),
 * and nothing is ever restored INTO the backups, which could otherwise overwrite the very bundles a
 * later restore would need. ⚠ That last rule is judged on the RESOLVED path: read off the raw
 * string, `./backups/x` and (on Windows) `Backups/x` passed it.
 */
export function restoreTarget(root: string, path: string, wholeTree: boolean): string | null {
  const segments = path.split('/')
  if (!segments.every(plainSegment)) return null
  const target = resolve(root, ...segments)
  if (!target.startsWith(root + sep)) return null
  const top = relative(root, target).split(sep)[0]
  if (wholeTree && NOT_UPLOADS.has(CASE_FOLDS ? top.toLowerCase() : top)) return null
  return target
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

/** Every file under `docs/`, as paths relative to it, depth-first and sorted for determinism. */
async function walk(root: string, prefix = '', skipTop: Set<string> = new Set()): Promise<string[]> {
  let entries: any[]
  try {
    entries = await readdir(join(root, prefix), { withFileTypes: true })
  } catch {
    return []   // no docs/ tree at all is a legitimate state, not an error
  }
  const out: string[] = []
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!prefix && skipTop.has(e.name)) continue
    const rel = prefix ? join(prefix, e.name) : e.name
    if (e.isDirectory()) out.push(...await walk(root, rel))
    else if (e.isFile()) out.push(rel)
  }
  return out
}

export interface BuiltFilesSidecar {
  filename: string
  path: string
  absolutePath: string
  bytes: number
  /** SHA-256 over the COMPRESSED sidecar, matching how `BuiltBundle.sha256` is defined. */
  sha256: string
  count: number
  /** Total uncompressed bytes of the files inside â€” what a restore will put back on the PV. */
  contentBytes: number
}

/**
 * Pack `<UPLOAD_DIR>/<orgId>/docs/` into one compressed sidecar next to the row bundle.
 *
 * `baseName` is the row bundle's filename without its extension, so the pair is obviously a
 * pair on an `ls` â€” an artifact whose partner is not identifiable is an artifact somebody
 * will eventually restore alone.
 */
export async function buildFilesSidecar(
  orgId: string,
  baseName: string,
  /**
   * `root: 'org'` packs the whole upload tree (FR-20.21, a master); `docs` is FR-13.29's scope.
   * `entries` packs exactly those files instead, each at its path under the org's tree, read from
   * wherever it lies (FR-20.71: a mirror's content store, by hash, for a re-seed).
   */
  opts: { subdir?: string; root?: 'docs' | 'org'; entries?: ReadonlyArray<{ path: string; abs: string }> } = {},
): Promise<BuiltFilesSidecar> {
  const wholeTree = opts.root === 'org' || !!opts.entries
  const docsRoot = wholeTree ? orgUploadDir(orgId) : orgDocsDir(orgId)
  const files = opts.entries ?? (await walk(docsRoot, '', wholeTree ? NOT_UPLOADS : new Set())).map(rel => ({ path: rel, abs: join(docsRoot, rel) }))

  const dir = join(config.upload.dir, String(orgId), 'backups', opts.subdir || '')
  await mkdir(dir, { recursive: true })
  const filename = `${baseName}.files.ndjson.zst`
  const absolutePath = join(dir, filename)

  const gz = zstdStream(19)
  const out = createWriteStream(absolutePath)
  const hash = createHash('sha256')
  let bytes = 0
  // Hash the COMPRESSED stream as it goes past, so the artifact never has to be read a second
  // time to learn its own checksum.
  gz.on('data', (chunk: Buffer) => { hash.update(chunk); bytes += chunk.length })
  const done = pipeline(gz, out)

  const write = (line: string) => new Promise<void>((res, rej) => {
    gz.write(line + '\n', (e: any) => (e ? rej(e) : res()))
  })

  await write(JSON.stringify({
    format: wholeTree ? FILES_SIDECAR_FORMAT_ORG : FILES_SIDECAR_FORMAT,
    orgId: String(orgId),
    createdAt: new Date().toISOString(),
  }))

  let count = 0
  let contentBytes = 0
  for (const { path: rel, abs } of files) {
    let content: Buffer
    try {
      content = Buffer.from(await Bun.file(abs).arrayBuffer())
    } catch (e: any) {
      // A file that vanished between the walk and the read is a real event on a live PV
      // (retention, a concurrent delete). Recording it and continuing beats failing the whole
      // backup over one document.
      logger.warn({ orgId, file: rel, err: e?.message }, 'Backup: a docs file could not be read; skipping it')
      continue
    }
    await write(JSON.stringify({
      // POSIX separators inside the artifact regardless of the host that wrote it â€” a bundle
      // taken on one platform must restore on another.
      path: rel.split(sep).join('/'),
      size: content.length,
      sha256: createHash('sha256').update(content).digest('hex'),
      b64: content.toString('base64'),
    }))
    count++
    contentBytes += content.length
  }

  gz.end()
  await done

  logger.info({ orgId, count, bytes, contentBytes }, 'Backup files sidecar written')
  return {
    filename,
    path: join(String(orgId), 'backups', opts.subdir || '', filename),
    absolutePath,
    bytes,
    sha256: hash.digest('hex'),
    count,
    contentBytes,
  }
}

/**
 * Split a byte stream into its lines, decoded as UTF-8.
 *
 * ⚠ One decoder for the whole stream. A chunk boundary can fall inside a multi-byte character,
 * and a path such as `фактура.pdf` is where it does: each chunk decoded on its own turned that
 * character into U+FFFD, and the restore wrote the file under a name nothing points at. Its
 * checksum covers the content, not the name, so nothing said so.
 */
export async function* splitLines(source: AsyncIterable<Buffer>): AsyncGenerator<string> {
  const decoder = new StringDecoder('utf8')
  let pending: string[] = []
  for await (const chunk of source) {
    const text = decoder.write(chunk)
    let start = 0
    let nl = text.indexOf('\n')
    while (nl !== -1) {
      pending.push(text.slice(start, nl))
      const line = pending.join('')
      pending = []
      if (line) yield line
      start = nl + 1
      nl = text.indexOf('\n', start)
    }
    // Only the new text is searched for a newline: a 50 MB document is one 67 MB line, and
    // re-scanning everything carried so far, chunk after chunk, made it quadratic.
    if (start < text.length) pending.push(text.slice(start))
  }
  const rest = pending.join('') + decoder.end()
  if (rest.trim()) yield rest
}

/**
 * Yield one NDJSON line at a time from a compressed sidecar, without holding the whole thing.
 * `onCompressed` sees every byte read from the disk, so a checksum can be taken in the same pass.
 */
async function* iterateSidecarLines(
  absolutePath: string,
  onCompressed?: (chunk: Buffer) => void,
): AsyncGenerator<string> {
  const file = createReadStream(absolutePath)
  if (onCompressed) file.on('data', onCompressed)
  const source = unzstdStream()
  // `pipe` does not forward a read error, and a decompressor waiting for input that never comes
  // would hold this loop for ever.
  file.on('error', (e: Error) => source.destroy(e))
  file.pipe(source)
  try {
    yield* splitLines(source as AsyncIterable<Buffer>)
  } finally {
    file.destroy()
    source.destroy()
  }
}

export interface FilesRestoreResult {
  written: number
  bytes: number
  /** FR-13.37 â€” files whose bytes did not match the checksum recorded when they were packed. */
  checksumFailures: string[]
  /** Entries refused for naming outside the org's own `docs/` tree. */
  refused: string[]
}

/**
 * Put a sidecar's files back under `<UPLOAD_DIR>/<targetOrgId>/docs/`, verifying each one.
 *
 * âš  `targetOrgId`, not the sidecar's own `orgId`. On a remap (FR-13.32) the bytes belong to
 * the org being restored INTO, and writing them under the origin's id would reproduce the
 * exact hazard remap exists to prevent one directory down: files that exist, are backed up
 * forever, and are reachable from nothing.
 *
 * âš  Every entry's path is re-checked against the target root before it is opened. The sidecar
 * is an operator-supplied file on the restore path â€” `../../` inside one is a plausible way
 * to write anywhere the pod can reach, and "we wrote this format ourselves" is not a property
 * of the file in front of us.
 *
 * FR-13.37: a checksum mismatch is REPORTED, not thrown. The operator needs the list of files
 * that came back wrong, which means the rest of them have to come back first.
 */
export async function restoreFilesSidecar(
  absolutePath: string,
  targetOrgId: string,
): Promise<FilesRestoreResult> {
  // The format names the root (FR-20.21): `-1` holds `docs/`, `-2` the whole upload tree.
  let root = resolve(orgDocsDir(targetOrgId))
  let wholeTree = false
  const res: FilesRestoreResult = { written: 0, bytes: 0, checksumFailures: [], refused: [] }
  let header = true

  for await (const line of iterateSidecarLines(absolutePath)) {
    let entry: any
    try {
      entry = JSON.parse(line)
    } catch {
      res.refused.push('(unparseable line)')
      continue
    }
    if (header) {
      header = false
      if (entry?.format === FILES_SIDECAR_FORMAT_ORG) {
        root = resolve(orgUploadDir(targetOrgId))
        wholeTree = true
      } else if (entry?.format !== FILES_SIDECAR_FORMAT) {
        throw new Error(`not a ${FILES_SIDECAR_FORMAT} or ${FILES_SIDECAR_FORMAT_ORG} sidecar`)
      }
      continue
    }
    if (typeof entry?.path !== 'string' || typeof entry?.b64 !== 'string') {
      res.refused.push(String(entry?.path || '(nameless entry)'))
      continue
    }
    const target = restoreTarget(root, entry.path, wholeTree)
    if (!target) {
      res.refused.push(entry.path)
      continue
    }

    const content = Buffer.from(entry.b64, 'base64')
    if (entry.sha256 && createHash('sha256').update(content).digest('hex') !== entry.sha256) {
      // Written anyway: a corrupted document is still evidence, and withholding it turns a
      // reported problem into a missing file nobody can chase. The list is the point.
      res.checksumFailures.push(entry.path)
    }
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, content)
    res.written++
    res.bytes += content.length
  }

  return res
}

export interface FilesVerifyResult {
  ok: boolean
  /** The compressed bytes on disk hash to the value recorded when they were written. */
  sha256Ok: boolean
  count: number
  contentBytes: number
  problems: string[]
}

/**
 * Read a sidecar back the way a restore would, writing nothing. FR-20.21 asks for a master's
 * backup "restore-verified as FR-13 does it", which FR-13 does for the rows with `verifyBundle`
 * and did for nothing else. On a master this artifact is the ONLY copy of the uploads.
 *
 * Every entry must decode, match its size and checksum, and name a path the restore accepts. The
 * entries must number what the writer counted, and the bytes on disk must hash to what was
 * recorded. One pass, streamed: at 6.9 GB a second read is a second hour on a shop PC's disk.
 */
export async function verifyFilesSidecar(
  absolutePath: string,
  expected: { sha256?: string; count?: number } = {},
): Promise<FilesVerifyResult> {
  const res: FilesVerifyResult = { ok: false, sha256Ok: false, count: 0, contentBytes: 0, problems: [] }
  const onDisk = createHash('sha256')
  // Only the shape of each path matters, so it is judged against a root nothing is written to.
  const root = resolve(config.upload.dir, '.verify')
  let wholeTree: boolean | undefined
  try {
    for await (const line of iterateSidecarLines(absolutePath, chunk => onDisk.update(chunk))) {
      let entry: any
      try {
        entry = JSON.parse(line)
      } catch {
        res.problems.push('an unparseable line')
        continue
      }
      if (wholeTree === undefined) {
        if (entry?.format === FILES_SIDECAR_FORMAT_ORG) wholeTree = true
        else if (entry?.format === FILES_SIDECAR_FORMAT) wholeTree = false
        else {
          res.problems.push(`unknown format: ${entry?.format}`)
          return res
        }
        continue
      }
      const path = typeof entry?.path === 'string' ? entry.path : ''
      if (!path || typeof entry?.b64 !== 'string') {
        res.problems.push(`${path || '(nameless entry)'}: no content`)
        continue
      }
      if (!restoreTarget(root, path, wholeTree)) {
        res.problems.push(`${path}: a restore would refuse this path`)
        continue
      }
      const content = Buffer.from(entry.b64, 'base64')
      if (content.length !== entry.size || createHash('sha256').update(content).digest('hex') !== entry.sha256) {
        res.problems.push(`${path}: does not match its checksum`)
      }
      res.count++
      res.contentBytes += content.length
    }
  } catch (e: any) {
    res.problems.push(`does not read back: ${e?.message || e}`)
    return res
  }

  if (wholeTree === undefined) {
    res.problems.push('the sidecar has no header')
    return res
  }
  res.sha256Ok = !expected.sha256 || onDisk.digest('hex') === expected.sha256
  if (!res.sha256Ok) {
    // Reported alone, as `verifyBundle` does: if the artifact changed, nothing inside it is
    // evidence of anything.
    res.problems = ['the sidecar sha256 does not match the recorded value']
    return res
  }
  if (expected.count !== undefined && res.count !== expected.count) {
    res.problems.push(`${res.count} files read back, ${expected.count} written`)
  }
  res.ok = res.problems.length === 0
  return res
}

/** Whether a sidecar exists and how big it is, for a report that has to mention it. */
export async function sidecarStat(absolutePath: string): Promise<{ bytes: number } | null> {
  try {
    const s = await stat(absolutePath)
    return { bytes: s.size }
  } catch {
    return null
  }
}
