import { createHash } from 'node:crypto'
import { Org, OrgLogo } from 'db/models'

/**
 * Per-organization letterhead: validation, storage and the data URI the PDF generators need.
 *
 * The image is downscaled in the browser before it is posted (see `useImageResize`), so nothing
 * here re-encodes pixels — that keeps a native image library out of the server image. What the
 * server does do is refuse to trust the client: the declared mime type is checked against the
 * file's magic bytes, and the dimensions are read out of the header, so a renamed .svg or .html
 * cannot be stored and later served back from the GET endpoint.
 */

/** Comfortably above a downscaled 600x200 PNG (~20-60 KB), far below the 16 MB document limit. */
export const MAX_LOGO_BYTES = 512_000
export const MAX_LOGO_DIMENSION = 4000

export type LogoMime = 'image/png' | 'image/jpeg' | 'image/webp'

/** SVG is intentionally absent: it can carry script, and this content is served back verbatim. */
const ALLOWED_MIMES: readonly LogoMime[] = ['image/png', 'image/jpeg', 'image/webp']

export class OrgLogoError extends Error {
  statusCode: number
  constructor(message: string, statusCode = 400) {
    super(message)
    this.name = 'OrgLogoError'
    this.statusCode = statusCode
  }
}

export interface OrgLogoMeta {
  url: string
  hash: string
  mimeType: string
  size: number
  width: number
  height: number
}

/** The URL stored on `Org.logo`; the `?v=` makes a replaced logo a different URL for caches. */
export function orgLogoUrl(orgId: string, hash: string): string {
  return `/api/org/${orgId}/logo?v=${hash}`
}

/** Identify the image by its bytes. Returns null when it is not one of the accepted formats. */
export function sniffImageType(buf: Buffer): LogoMime | null {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'image/png'
  }
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg'
  if (
    buf.length >= 12
    && buf.subarray(0, 4).toString('latin1') === 'RIFF'
    && buf.subarray(8, 12).toString('latin1') === 'WEBP'
  ) {
    return 'image/webp'
  }
  return null
}

/**
 * Pixel dimensions straight out of the file header — enough for a sanity bound, without decoding.
 * PNG: IHDR is always the first chunk. JPEG: walk the segments to the first SOF. WebP: the three
 * container flavours (lossy VP8, lossless VP8L, extended VP8X) each keep the size in a different
 * place. Returns null when the header is malformed or truncated.
 */
export function readImageSize(buf: Buffer, mime: LogoMime): { width: number; height: number } | null {
  try {
    if (mime === 'image/png') {
      if (buf.length < 24 || buf.subarray(12, 16).toString('latin1') !== 'IHDR') return null
      return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
    }

    if (mime === 'image/jpeg') {
      let off = 2
      while (off + 9 < buf.length) {
        if (buf[off] !== 0xff) { off++; continue }
        const marker = buf[off + 1]!
        // SOF0..SOF15, excluding the non-frame markers DHT (c4), JPG (c8) and DAC (cc).
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return { height: buf.readUInt16BE(off + 5), width: buf.readUInt16BE(off + 7) }
        }
        if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd9)) { off += 2; continue }
        off += 2 + buf.readUInt16BE(off + 2)
      }
      return null
    }

    // WebP
    const fourcc = buf.subarray(12, 16).toString('latin1')
    if (fourcc === 'VP8X' && buf.length >= 30) {
      const w = 1 + (buf[24]! | (buf[25]! << 8) | (buf[26]! << 16))
      const h = 1 + (buf[27]! | (buf[28]! << 8) | (buf[29]! << 16))
      return { width: w, height: h }
    }
    if (fourcc === 'VP8L' && buf.length >= 25) {
      const bits = buf.readUInt32LE(21)
      return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 }
    }
    if (fourcc === 'VP8 ' && buf.length >= 30) {
      return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff }
    }
    return null
  } catch {
    return null
  }
}

/** Validate bytes + declared type. Throws `OrgLogoError` with the reason. */
export function validateLogo(buf: Buffer, declaredMime?: string): { mime: LogoMime; width: number; height: number } {
  if (!buf.length) throw new OrgLogoError('Empty file')
  if (buf.length > MAX_LOGO_BYTES) {
    throw new OrgLogoError(`Logo must be at most ${Math.floor(MAX_LOGO_BYTES / 1000)} KB (got ${Math.ceil(buf.length / 1000)} KB)`)
  }

  const sniffed = sniffImageType(buf)
  if (!sniffed) throw new OrgLogoError('Unsupported image format — use PNG, JPEG or WebP')

  // A declared type that disagrees with the bytes means the upload is not what it claims to be.
  const declared = String(declaredMime || '').split(';')[0]!.trim().toLowerCase()
  if (declared && ALLOWED_MIMES.includes(declared as LogoMime) && declared !== sniffed) {
    throw new OrgLogoError(`File content is ${sniffed}, not the declared ${declared}`)
  }

  const size = readImageSize(buf, sniffed)
  if (!size || !size.width || !size.height) throw new OrgLogoError('Could not read the image dimensions')
  if (size.width > MAX_LOGO_DIMENSION || size.height > MAX_LOGO_DIMENSION) {
    throw new OrgLogoError(`Image must be at most ${MAX_LOGO_DIMENSION}px on a side`)
  }

  return { mime: sniffed, width: size.width, height: size.height }
}

export function hashLogo(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex').slice(0, 16)
}

/**
 * In-process data-URI cache. Keyed by `orgId:hash`, so a logo replaced by another replica is
 * picked up as soon as the (Buffer-free) meta read returns the new hash.
 */
const dataUriCache = new Map<string, string>()

/** Store (or replace) the org's logo and point `Org.logo` at the versioned endpoint URL. */
export async function saveOrgLogo(
  orgId: string,
  buf: Buffer,
  declaredMime?: string,
  uploadedBy?: string,
): Promise<OrgLogoMeta> {
  const { mime, width, height } = validateLogo(buf, declaredMime)
  const hash = hashLogo(buf)

  await OrgLogo.findOneAndUpdate(
    { orgId },
    { orgId, data: buf, mimeType: mime, size: buf.length, width, height, hash, uploadedBy },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  )

  const url = orgLogoUrl(orgId, hash)
  await Org.updateOne({ _id: orgId }, { $set: { logo: url } })
  dataUriCache.set(`${orgId}:${hash}`, `data:${mime};base64,${buf.toString('base64')}`)

  return { url, hash, mimeType: mime, size: buf.length, width, height }
}

/** Metadata only — never pulls the Buffer, so it is cheap enough for a cache check per render. */
export async function getOrgLogoMeta(orgId: string): Promise<OrgLogoMeta | null> {
  const doc = await OrgLogo.findOne({ orgId }).select('hash mimeType size width height').lean()
  if (!doc) return null
  return {
    url: orgLogoUrl(orgId, doc.hash),
    hash: doc.hash,
    mimeType: doc.mimeType,
    size: doc.size,
    width: doc.width,
    height: doc.height,
  }
}

/**
 * A `Buffer` path read through `.lean()` comes back as a BSON `Binary`, not a Node Buffer —
 * and `Buffer.from(binary)` silently yields **zero bytes**, which would serve an empty image.
 * Normalise both shapes here.
 */
function toBuffer(value: any): Buffer {
  if (Buffer.isBuffer(value)) return value
  if (value?.buffer) return Buffer.from(value.buffer)
  return Buffer.from(value ?? [])
}

export async function getOrgLogoBytes(orgId: string): Promise<{ data: Buffer; mimeType: string; hash: string } | null> {
  const doc = await OrgLogo.findOne({ orgId }).lean()
  if (!doc) return null
  return { data: toBuffer(doc.data), mimeType: doc.mimeType, hash: doc.hash }
}

/**
 * The form the PDF generators need: Chromium renders them from a string with no base URL and no
 * network access, so the bytes have to travel inline. `null` means "no own logo" — the caller
 * lets `resolveLogo()` fall back to the bundled asset.
 */
export async function getOrgLogoDataUri(orgId: string): Promise<string | null> {
  const meta = await getOrgLogoMeta(orgId)
  if (!meta) return null

  const key = `${orgId}:${meta.hash}`
  const cached = dataUriCache.get(key)
  if (cached) return cached

  const full = await getOrgLogoBytes(orgId)
  if (!full) return null
  const uri = `data:${full.mimeType};base64,${full.data.toString('base64')}`
  dataUriCache.set(`${orgId}:${full.hash}`, uri)
  return uri
}

/** Remove the org's own logo; printed documents revert to the bundled letterhead. */
export async function deleteOrgLogo(orgId: string): Promise<boolean> {
  const doc = await OrgLogo.findOneAndDelete({ orgId })
  if (doc) dataUriCache.delete(`${orgId}:${doc.hash}`)
  await Org.updateOne({ _id: orgId }, { $unset: { logo: '' } })
  return !!doc
}
