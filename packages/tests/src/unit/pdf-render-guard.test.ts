import { describe, it, expect } from 'bun:test'
import { looksLikePdf, PdfRenderError } from 'reporting/pdf/base.pdf'

/**
 * `md-to-pdf` starts its own static-file server and its own Chromium per call. When several
 * run in one process the launch can fail in a way that returns a buffer holding nothing but
 * the `%PDF-1.4\n` header — 9 bytes — instead of throwing.
 *
 * That buffer passes every naive check: it is defined, and it starts with the PDF magic. It
 * then travels all the way to the user as a download that opens to nothing. This guard is
 * what stops it.
 */
describe('PDF render guard', () => {
  it('rejects the header-only buffer a failed Chromium render returns', () => {
    // Exactly what was observed in production-suite runs.
    const headerOnly = Buffer.from('%PDF-1.4\n', 'latin1')
    expect(headerOnly.length).toBe(9)
    expect(looksLikePdf(headerOnly)).toBe(false)
  })

  it('rejects nothing at all', () => {
    expect(looksLikePdf(undefined)).toBe(false)
    expect(looksLikePdf(Buffer.alloc(0))).toBe(false)
  })

  it('rejects a long buffer that is not a PDF (an error page, say)', () => {
    expect(looksLikePdf(Buffer.from('<!DOCTYPE html>' + 'x'.repeat(2000), 'latin1'))).toBe(false)
  })

  it('accepts a buffer with the PDF magic and a real body', () => {
    const body = Buffer.concat([Buffer.from('%PDF-1.4\n', 'latin1'), Buffer.alloc(1000, 0x20)])
    expect(looksLikePdf(body)).toBe(true)
  })

  it('exposes a named error so callers can tell a render failure from a bug', () => {
    const err = new PdfRenderError('nope')
    expect(err).toBeInstanceOf(Error)
    expect(err.name).toBe('PdfRenderError')
  })
})
