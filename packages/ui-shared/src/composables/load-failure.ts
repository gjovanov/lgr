/**
 * Why a record or a list could not be shown (FR-31.6, FR-31.7): the screen says so, instead of looking like an
 * empty draft or a list without rows.
 *
 *  - `not_found`: the server answered 404 (an id that names nothing, or a record of another organization);
 *  - `forbidden`: 401 or 403, the role may not read it;
 *  - `failed`: anything else, the network included.
 *
 * An abort is no failure: the caller gave up on the request (`latestOnly`), and says nothing.
 */
export type LoadFailure = 'not_found' | 'forbidden' | 'failed'

export function loadFailureOf(e: unknown): LoadFailure {
  const status = (e as { response?: { status?: number } } | null)?.response?.status
  if (status === 404) return 'not_found'
  if (status === 401 || status === 403) return 'forbidden'
  return 'failed'
}

/** The catalogue key of a load failure's sentence: `common.loadFailure.<failure>`. */
export function loadFailureKey(failure: LoadFailure): string {
  return `common.loadFailure.${failure}`
}
