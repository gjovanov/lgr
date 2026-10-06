import { describe, it, expect } from 'bun:test'
import { filenameFromDisposition } from 'ui-shared/composables/useSessionDownload'

/**
 * Downloads now go through the tab's session (a fetch with its bearer token) instead of a plain
 * link, so the browser no longer names the file itself: the name has to come out of the
 * `Content-Disposition` header the server sends, in each of the shapes our endpoints use.
 */
describe('filenameFromDisposition', () => {
  it('reads the quoted name the backup endpoint sends', () => {
    expect(filenameFromDisposition('attachment; filename="lgr-regal-pz-full-2026-10-05.ndjson.zst"')).toBe(
      'lgr-regal-pz-full-2026-10-05.ndjson.zst',
    )
  })

  it('decodes the percent-encoded Cyrillic name the files endpoint sends', () => {
    const name = 'Разписка 12698.pdf'
    expect(filenameFromDisposition(`attachment; filename="${encodeURIComponent(name)}"`)).toBe(name)
  })

  it('prefers the RFC 6266 extended form when both are present', () => {
    expect(filenameFromDisposition(`attachment; filename="fallback.pdf"; filename*=UTF-8''%D0%A4%D0%B0%D0%BA%D1%82%D1%83%D1%80%D0%B0.pdf`)).toBe(
      'Фактура.pdf',
    )
  })

  it('answers empty when there is no name, and keeps a malformed escape as it came', () => {
    expect(filenameFromDisposition(undefined)).toBe('')
    expect(filenameFromDisposition('attachment')).toBe('')
    expect(filenameFromDisposition('attachment; filename="100%.txt"')).toBe('100%.txt')
  })
})
