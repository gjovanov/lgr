/**
 * FR-20.75: where the org is written changed under this page: a move started or ended, or a
 * promotion's legal numbering opened again (FR-20.81). The page that did it says so, and the home
 * banner (`ui-shell/HomeBanner.vue`) looks again at once rather than at its next two-minute poll,
 * which left it saying "numbering waits" right under "numbering resumes".
 */
const EVENT = 'lgr:home-changed'

export function announceHomeChanged(): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(EVENT))
}

/** Listen for it; the returned function stops listening. */
export function onHomeChanged(fn: () => void): () => void {
  if (typeof window === 'undefined') return () => {}
  window.addEventListener(EVENT, fn)
  return () => window.removeEventListener(EVENT, fn)
}
