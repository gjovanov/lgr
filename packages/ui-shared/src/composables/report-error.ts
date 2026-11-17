import { isAbort } from './latest-only'
import { useSnackbar } from './useSnackbar'

/**
 * FR-32.5 (#797): a catch that reports its error, rather than one that holds only a comment.
 *
 * The HTTP client (`useHttpClient`) already says a network failure and a 5xx on the message line, and a 401 signs
 * the tab out. What it leaves to the caller is a refusal (another 4xx): this says it, in the server's own sentence
 * when it sent one. An error that is not an HTTP answer at all is a fault in the page: it is said and logged. A
 * request its caller gave up on (FR-31.4) failed nothing, and is said by nobody.
 *
 * Returns whether it said anything, for a caller that does more with a silent case.
 */
export function reportError(e: unknown, fallback?: string): boolean {
  if (isAbort(e)) return false
  const { showError } = useSnackbar()
  const err = e as { isAxiosError?: boolean; response?: { status?: number; data?: { message?: unknown } }; message?: unknown }
  if (err && typeof err === 'object' && err.isAxiosError) {
    const status = err.response?.status
    if (!err.response || status === undefined || status === 401 || status >= 500) return false // the client said it
    const said = typeof err.response.data?.message === 'string' && err.response.data.message ? err.response.data.message : undefined
    showError(said || fallback || `Request refused (${status})`)
    return true
  }
  console.error(e)
  showError(fallback || (e instanceof Error && e.message ? e.message : String(e)))
  return true
}
