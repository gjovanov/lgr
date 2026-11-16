import { ref } from 'vue'
import { isAbort } from './latest-only'
import { loadFailureOf, type LoadFailure } from './load-failure'
import { useSnackbar } from './useSnackbar'

/**
 * What a form on `EntityFormShell` says about its load and its actions (FR-31.6, FR-31.8). Bind both to the shell:
 *
 *   <EntityFormShell :load-error="loadError" :refusal="refusal" @retry="load" @dismiss-refusal="dismissRefusal">
 *
 * - `loadStarted()` / `loadFailed(e)` around the record's load: a record that was not found, may not be read or
 *   could not be loaded is said as such, with Back and Retry, instead of an empty form that looks like a new draft.
 * - `refused(text)` when a save, an issue, a delete or a confirm is refused: said at the top of the form until the
 *   person closes it or the next action succeeds (`succeeded()`). It is said on the message line too, where it was
 *   said before (and where it now stays until closed); a success takes it off both.
 */
export function useFormFeedback() {
  const loadError = ref<LoadFailure | null>(null)
  const refusal = ref('')
  const { showError, withdraw } = useSnackbar()

  function loadStarted() {
    loadError.value = null
  }

  /** The load failed; an abort (a newer load replaced it) is no failure. */
  function loadFailed(e: unknown) {
    if (!isAbort(e)) loadError.value = loadFailureOf(e)
  }

  function refused(text: string) {
    refusal.value = text
    showError(text)
  }

  /** The next action succeeded: the refusal before it is no longer true. */
  function succeeded() {
    if (refusal.value) withdraw(refusal.value)
    refusal.value = ''
  }

  function dismissRefusal() {
    if (refusal.value) withdraw(refusal.value)
    refusal.value = ''
  }

  return { loadError, refusal, loadStarted, loadFailed, refused, succeeded, dismissRefusal }
}
