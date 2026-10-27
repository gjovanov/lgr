/**
 * The master's half of the file lane (FR-20.69, plan step P3-3, Part A.6.4): a chunk of a file
 * global asked for, read by its content and framed for the bulk socket.
 *
 * The supervisor asks over the control socket (`POST /replication/blob`) for `(org, sha256,
 * offset)`, global's own offset, and sends the frame as it comes. Which rows of the org name that
 * content is this side's business: global names only the content.
 *
 * - **Found by content, in the org.** A current document, any `File` row (its versions, the deleted
 *   ones, the imports), or an archive unit. A document moved into an archive is no longer on disk,
 *   and is in its unit.
 * - **Checked before the first byte leaves.** At offset 0 the whole file is hashed: bytes that are
 *   not what the row says are refused here, before the shop's uplink carries them. Global checks
 *   again at the end, whoever sent them.
 * - **Only an org homed here, linked at Full.** At Control no business data leaves the building
 *   (FR-20.54), files least of all.
 */
import { createHash } from 'node:crypto'
import { stat } from 'node:fs/promises'
import { ArchiveUnit, DocFile, File as FileModel } from 'db/models'
import { homeOf, thisNode } from 'db/home/home'
import { orgArchiveDir } from '../archive/archive.service.js'
import { containedJoin } from '../files/safe-path.js'
import { resolveStored } from '../files/stored-path.js'
import { BLOB_CHUNK, SHA256_HEX, encodeBlobChunk } from './blob-frame.js'
import { ControlAskError } from './control.js'
import { captureOn } from './engine.js'

const OBJECT_ID = /^[0-9a-f]{24}$/
/** States in which the home still sends: as for pages, a move drains what is left first. */
const SENDING: ReadonlySet<string> = new Set(['active', 'freezing', 'frozen'])

export interface BlobAsk {
  orgId: string
  sha256: string
  offset: number
}

export type BlobAnswer =
  | { status: 200; bytes: Uint8Array; size: number; length: number }
  | { status: 404; code: 'missing'; detail: string }
  | { status: 409; refused: 'not_full' | 'not_home' | 'hash_mismatch' | 'offset_beyond'; detail: string }

export function readBlobAsk(body: any): BlobAsk {
  const orgId = String(body?.orgId ?? '')
  const sha256 = String(body?.sha256 ?? '')
  const offset = Number(body?.offset)
  if (!OBJECT_ID.test(orgId)) throw new ControlAskError('orgId is not an org id')
  if (!SHA256_HEX.test(sha256)) throw new ControlAskError('sha256 is not a lower-case hex SHA-256')
  if (!Number.isSafeInteger(offset) || offset < 0) throw new ControlAskError('offset is not a position in a file')
  return { orgId, sha256, offset }
}

/** Where the bytes of `sha256` are for `orgId` on this server, if any row of the org names them. */
export async function locateBlob(orgId: string, sha256: string): Promise<{ path: string; size: number } | null> {
  const candidates: string[] = []
  const docs = await DocFile.find({ orgId, currentChecksum: sha256, archived: { $ne: true } }, { currentPath: 1 }).lean()
  const files = await FileModel.find({ orgId, sha256, storageProvider: { $in: ['local', null] } }, { storagePath: 1 }).lean()
  const units = await ArchiveUnit.find({ orgId, sha256 }, { filename: 1 }).lean()
  for (const d of docs as any[]) candidates.push(...stored(d.currentPath, orgId))
  for (const f of files as any[]) candidates.push(...stored(f.storagePath, orgId))
  for (const u of units as any[]) {
    // Where the archive service itself reads a unit: by its file name, in the org's archive folder.
    try { candidates.push(containedJoin(orgArchiveDir(orgId), String(u.filename ?? ''))) } catch { /* not a name in it */ }
  }
  for (const path of new Set(candidates)) {
    const s = await stat(path).catch(() => null)
    if (s?.isFile()) return { path, size: s.size }
  }
  return null
}

/** A row's stored path on this server, or nothing when it is not one under the org. */
function stored(p: unknown, orgId: string): string[] {
  if (typeof p !== 'string' || !p) return []
  try {
    return [resolveStored(p, orgId)]
  } catch {
    return []
  }
}

/** The last file found, kept for the chunks after the first: a 500 MB unit is 500 asks. */
const found = new Map<string, { path: string; size: number; at: number }>()
const FOUND_MS = 60_000
const FOUND_KEPT = 8

async function hashOf(path: string): Promise<string> {
  const h = createHash('sha256')
  for await (const part of Bun.file(path).stream()) h.update(part)
  return h.digest('hex')
}

/** The chunk of `sha256` at global's `offset`, framed; or why there is none. */
export async function blobFor(ask: BlobAsk): Promise<BlobAnswer> {
  // FR-20.54: at Control the mirror is off, files and all.
  if (!captureOn()) return { status: 409, refused: 'not_full', detail: 'this master is not linked at Full' }
  const home = await homeOf(ask.orgId)
  if (home.home !== thisNode() || !SENDING.has(home.state)) return { status: 409, refused: 'not_home', detail: `this server is not the org's home (${home.state})` }

  const key = `${ask.orgId}:${ask.sha256}`
  let hit = found.get(key)
  if (!hit || Date.now() - hit.at > FOUND_MS || ask.offset === 0) {
    const where = await locateBlob(ask.orgId, ask.sha256)
    if (!where) {
      found.delete(key)
      return { status: 404, code: 'missing', detail: 'no row of this org names these bytes, or none of them is on this server' }
    }
    if (ask.offset === 0 && (await hashOf(where.path)) !== ask.sha256) {
      found.delete(key)
      return { status: 409, refused: 'hash_mismatch', detail: 'the file on this server is not what its row says it is' }
    }
    hit = { ...where, at: Date.now() }
    found.delete(key)
    found.set(key, hit)
    while (found.size > FOUND_KEPT) found.delete(found.keys().next().value!)
  }
  if (ask.offset > hit.size || (ask.offset === hit.size && hit.size > 0)) {
    return { status: 409, refused: 'offset_beyond', detail: `global holds ${ask.offset} bytes of a file of ${hit.size}` }
  }
  const end = Math.min(hit.size, ask.offset + BLOB_CHUNK)
  const bytes = new Uint8Array(await Bun.file(hit.path).slice(ask.offset, end).arrayBuffer())
  if (bytes.length !== end - ask.offset) {
    // Shorter than it was a moment ago: the file changed. Global's check at the end would catch it;
    // saying so now costs nothing.
    found.delete(key)
    return { status: 409, refused: 'hash_mismatch', detail: 'the file changed while it was read' }
  }
  const frame = encodeBlobChunk({ orgId: ask.orgId, sha256: ask.sha256, offset: ask.offset, size: hit.size, bytes })
  return { status: 200, bytes: frame, size: hit.size, length: bytes.length }
}

/** Tests: forget the files found. */
export function forgetFoundBlobs(): void {
  found.clear()
}
