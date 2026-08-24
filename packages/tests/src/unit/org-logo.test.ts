import { describe, it, expect } from 'bun:test'
import {
  MAX_LOGO_BYTES,
  MAX_LOGO_DIMENSION,
  hashLogo,
  orgLogoUrl,
  readImageSize,
  sniffImageType,
  validateLogo,
} from 'services/biz/org-logo.service'

// ── Minimal, header-only fixtures. The service never decodes pixels, so a valid header
// is exactly what it reads — and building them here keeps binary blobs out of the repo.

function png(width: number, height: number): Buffer {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const ihdr = Buffer.alloc(25)
  ihdr.writeUInt32BE(13, 0)
  ihdr.write('IHDR', 4, 'latin1')
  ihdr.writeUInt32BE(width, 8)
  ihdr.writeUInt32BE(height, 12)
  ihdr[16] = 8 // bit depth
  ihdr[17] = 6 // colour type
  return Buffer.concat([sig, ihdr])
}

function jpeg(width: number, height: number): Buffer {
  const soi = Buffer.from([0xff, 0xd8, 0xff])
  // APP0/JFIF segment, so the parser has to walk past something before reaching SOF0.
  const app0 = Buffer.alloc(18)
  app0[0] = 0xe0
  app0.writeUInt16BE(16, 1)
  app0.write('JFIF\0', 3, 'latin1')
  const sof = Buffer.alloc(12)
  sof[0] = 0xff
  sof[1] = 0xc0
  sof.writeUInt16BE(8, 2)
  sof[4] = 8
  sof.writeUInt16BE(height, 5)
  sof.writeUInt16BE(width, 7)
  return Buffer.concat([soi, app0, sof])
}

function webp(width: number, height: number): Buffer {
  const buf = Buffer.alloc(30)
  buf.write('RIFF', 0, 'latin1')
  buf.writeUInt32LE(22, 4)
  buf.write('WEBP', 8, 'latin1')
  buf.write('VP8X', 12, 'latin1')
  const w = width - 1
  const h = height - 1
  buf[24] = w & 0xff; buf[25] = (w >> 8) & 0xff; buf[26] = (w >> 16) & 0xff
  buf[27] = h & 0xff; buf[28] = (h >> 8) & 0xff; buf[29] = (h >> 16) & 0xff
  return buf
}

describe('org logo — format sniffing', () => {
  it('identifies the three accepted formats by their magic bytes', () => {
    expect(sniffImageType(png(10, 10))).toBe('image/png')
    expect(sniffImageType(jpeg(10, 10))).toBe('image/jpeg')
    expect(sniffImageType(webp(10, 10))).toBe('image/webp')
  })

  it('rejects anything else — an SVG renamed to .png stays rejected', () => {
    expect(sniffImageType(Buffer.from('<svg onload="alert(1)"></svg>'))).toBeNull()
    expect(sniffImageType(Buffer.from('%PDF-1.7'))).toBeNull()
    expect(sniffImageType(Buffer.alloc(0))).toBeNull()
  })
})

describe('org logo — dimensions', () => {
  it('reads the size out of each format header', () => {
    expect(readImageSize(png(600, 200), 'image/png')).toEqual({ width: 600, height: 200 })
    expect(readImageSize(jpeg(640, 480), 'image/jpeg')).toEqual({ width: 640, height: 480 })
    expect(readImageSize(webp(300, 120), 'image/webp')).toEqual({ width: 300, height: 120 })
  })

  it('returns null for a truncated header instead of throwing', () => {
    expect(readImageSize(png(10, 10).subarray(0, 14), 'image/png')).toBeNull()
    expect(readImageSize(Buffer.from([0xff, 0xd8, 0xff]), 'image/jpeg')).toBeNull()
  })
})

describe('org logo — validation', () => {
  it('accepts a well-formed image and reports its type and size', () => {
    expect(validateLogo(png(600, 200), 'image/png')).toEqual({ mime: 'image/png', width: 600, height: 200 })
  })

  it('accepts an image with no declared mime type at all', () => {
    expect(validateLogo(jpeg(100, 50)).mime).toBe('image/jpeg')
  })

  it('refuses bytes that disagree with the declared type', () => {
    expect(() => validateLogo(png(10, 10), 'image/jpeg')).toThrow(/not the declared/)
  })

  it('refuses an unsupported format', () => {
    expect(() => validateLogo(Buffer.from('<svg/>'), 'image/svg+xml')).toThrow(/Unsupported image format/)
  })

  it('refuses an empty file', () => {
    expect(() => validateLogo(Buffer.alloc(0))).toThrow(/Empty file/)
  })

  it('refuses anything over the byte cap', () => {
    const huge = Buffer.concat([png(10, 10), Buffer.alloc(MAX_LOGO_BYTES)])
    expect(() => validateLogo(huge)).toThrow(/at most/)
  })

  it('refuses absurd dimensions even when the file is small', () => {
    expect(() => validateLogo(png(MAX_LOGO_DIMENSION + 1, 10))).toThrow(/px on a side/)
  })
})

describe('org logo — hashing and URL', () => {
  it('hashes deterministically, and differently for different bytes', () => {
    const a = hashLogo(png(600, 200))
    expect(a).toBe(hashLogo(png(600, 200)))
    expect(a).not.toBe(hashLogo(png(600, 201)))
    expect(a).toHaveLength(16)
  })

  it('builds a cache-busting URL that carries the hash', () => {
    expect(orgLogoUrl('64f000000000000000000001', 'deadbeefdeadbeef'))
      .toBe('/api/org/64f000000000000000000001/logo?v=deadbeefdeadbeef')
  })
})
