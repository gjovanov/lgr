/**
 * One chunk of a file on the bulk socket (FR-20.69, plan step P3-3, Part A.6.4): the master's API
 * builds the frame, the supervisor sends it without reading it, and global checks every byte of it.
 *
 * ```
 * 0..4     "LGRB"
 * 4        version (1)
 * 5..9     header length n, u32 big-endian, at most 1 KB
 * 9..9+n   header, JSON: { orgId, sha256, offset, size }
 * 9+n..    the chunk's bytes, at most BLOB_CHUNK
 * ```
 *
 * ⚠ The magic is not zstd's (`28 B5 2F FD`), so a frame is never mistaken for a page, nor a page
 * for a chunk. Files are not compressed on the way: they are mostly PDFs and spreadsheets, which
 * already are.
 *
 * Import-pure.
 */

export const BLOB_MAGIC = [0x4c, 0x47, 0x52, 0x42] as const // "LGRB"
const VERSION = 1
const HEADER_MAX = 1024
/** 1 MB: a chunk the shop's uplink sends in about a second at 10 Mbit/s, resumable from global's offset. */
export const BLOB_CHUNK = 1 << 20

export const SHA256_HEX = /^[0-9a-f]{64}$/
const OBJECT_ID = /^[0-9a-f]{24}$/

export interface BlobChunk {
  orgId: string
  sha256: string
  /** Where these bytes start in the file. */
  offset: number
  /** The whole file's size. */
  size: number
  bytes: Uint8Array
}

export class BlobFrameError extends Error {
  readonly code = 'malformed'
}

export function isBlobFrame(b: Uint8Array): boolean {
  return b.length > BLOB_MAGIC.length && BLOB_MAGIC.every((x, i) => b[i] === x)
}

export function encodeBlobChunk(c: BlobChunk): Uint8Array {
  checkHeader(c, c.bytes.length)
  const header = new TextEncoder().encode(JSON.stringify({ orgId: c.orgId, sha256: c.sha256, offset: c.offset, size: c.size }))
  const out = new Uint8Array(9 + header.length + c.bytes.length)
  out.set(BLOB_MAGIC, 0)
  out[4] = VERSION
  new DataView(out.buffer).setUint32(5, header.length, false)
  out.set(header, 9)
  out.set(c.bytes, 9 + header.length)
  return out
}

/** A frame off the wire, checked: its shape, its header, and that its bytes fit the file it names. */
export function decodeBlobChunk(b: Uint8Array): BlobChunk {
  if (!isBlobFrame(b) || b.length < 9) throw new BlobFrameError('not a file chunk')
  if (b[4] !== VERSION) throw new BlobFrameError(`a file chunk of version ${b[4]}`)
  const n = new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(5, false)
  if (n < 2 || n > HEADER_MAX || 9 + n > b.length) throw new BlobFrameError('a file chunk with a header of no size it can have')
  let h: any
  try {
    h = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(b.subarray(9, 9 + n)))
  } catch {
    throw new BlobFrameError('a file chunk whose header is not JSON')
  }
  const bytes = b.subarray(9 + n)
  const chunk = { orgId: h?.orgId, sha256: h?.sha256, offset: h?.offset, size: h?.size, bytes }
  checkHeader(chunk, bytes.length)
  return chunk as BlobChunk
}

function checkHeader(c: { orgId: unknown; sha256: unknown; offset: unknown; size: unknown }, len: number): void {
  if (typeof c.orgId !== 'string' || !OBJECT_ID.test(c.orgId)) throw new BlobFrameError('orgId is not an org id')
  if (typeof c.sha256 !== 'string' || !SHA256_HEX.test(c.sha256)) throw new BlobFrameError('sha256 is not a lower-case hex SHA-256')
  if (!Number.isSafeInteger(c.offset) || (c.offset as number) < 0) throw new BlobFrameError('offset is not a position in a file')
  if (!Number.isSafeInteger(c.size) || (c.size as number) < 0) throw new BlobFrameError('size is not a file size')
  if (len > BLOB_CHUNK) throw new BlobFrameError(`a chunk is at most ${BLOB_CHUNK} bytes`)
  // Only an empty file is sent as an empty chunk; any other chunk carries bytes, inside the file.
  if (len === 0 ? !((c.size as number) === 0 && (c.offset as number) === 0) : (c.offset as number) + len > (c.size as number)) {
    throw new BlobFrameError('the chunk does not fit the file it names')
  }
}
