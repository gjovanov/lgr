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
import { dirname, join, resolve, sep } from 'node:path'
import { pipeline } from 'node:stream/promises'
import zlib from 'node:zlib'
import { config } from 'config'
import { logger } from '../../logger/logger.js'

export const FILES_SIDECAR_FORMAT = 'lgr-backup-files-1'

/** `<UPLOAD_DIR>/<orgId>/docs` â€” the tree `doc-store.service.ts` writes into. */
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

/** Every file under `docs/`, as paths relative to it, depth-first and sorted for determinism. */
async function walk(root: string, prefix = ''): Promise<string[]> {
  let entries: any[]
  try {
    entries = await readdir(join(root, prefix), { withFileTypes: true })
  } catch {
    return []   // no docs/ tree at all is a legitimate state, not an error
  }
  const out: string[] = []
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
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
  opts: { subdir?: string } = {},
): Promise<BuiltFilesSidecar> {
  const docsRoot = orgDocsDir(orgId)
  const files = await walk(docsRoot)

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
    format: FILES_SIDECAR_FORMAT,
    orgId: String(orgId),
    createdAt: new Date().toISOString(),
  }))

  let count = 0
  let contentBytes = 0
  for (const rel of files) {
    const abs = join(docsRoot, rel)
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

/** Yield one NDJSON line at a time from a compressed sidecar, without holding the whole thing. */
async function* iterateSidecarLines(absolutePath: string): AsyncGenerator<string> {
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
  const root = resolve(orgDocsDir(targetOrgId))
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
      if (entry?.format !== FILES_SIDECAR_FORMAT) {
        throw new Error(`not a ${FILES_SIDECAR_FORMAT} sidecar`)
      }
      continue
    }
    if (typeof entry?.path !== 'string' || typeof entry?.b64 !== 'string') {
      res.refused.push(String(entry?.path || '(nameless entry)'))
      continue
    }

    const target = resolve(join(root, entry.path))
    if (target !== root && !target.startsWith(root + sep)) {
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

/** Whether a sidecar exists and how big it is, for a report that has to mention it. */
export async function sidecarStat(absolutePath: string): Promise<{ bytes: number } | null> {
  try {
    const s = await stat(absolutePath)
    return { bytes: s.size }
  } catch {
    return null
  }
}
