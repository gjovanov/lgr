import { httpClient } from './useHttpClient'
import { decodeBlobError, triggerBlobDownload } from './useInvoicingExport'

/**
 * Download a file as THIS tab's session (multi-org sign-in, Phase 3).
 *
 * ⚠ Never a plain link to the API. An `<a href="/api/…">` carries only the `auth` cookie, and the
 * cookie names the org this browser entered LAST, in any tab. With each tab in its own org, a
 * download link in one tab would arrive as another tab's org and be refused (403, the tenant
 * guard), or worse, be answered for the wrong org on a route that takes no org in its path. This
 * fetches with the tab's own bearer token and saves the response under the server's filename.
 *
 * `path` is relative to the API base, like every `httpClient` call (`/org/:orgId/…`).
 */
export async function downloadAsSession(path: string, fallbackName = 'download'): Promise<void> {
  try {
    const res = await httpClient.get(path, { responseType: 'blob' })
    triggerBlobDownload(res.data, filenameFromDisposition(res.headers['content-disposition']) || fallbackName)
  } catch (e) {
    await decodeBlobError(e)
  }
}

/** The filename a `Content-Disposition` header names (RFC 6266 `filename*` first), or ''. */
export function filenameFromDisposition(disposition?: string | null): string {
  if (!disposition) return ''
  const extended = /filename\*\s*=\s*UTF-8''([^;]+)/i.exec(disposition)
  const plain = /filename\s*=\s*"?([^";]+)"?/i.exec(disposition)
  const raw = extended?.[1] ?? plain?.[1] ?? ''
  try {
    return decodeURIComponent(raw.trim())
  } catch {
    return raw.trim()
  }
}
