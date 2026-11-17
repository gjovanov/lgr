import { reactive, watch } from 'vue'

/**
 * The app's one message line (`web/App.vue` draws it).
 *
 * FR-31.8: an error stays until the person closes it, and nothing replaces it: a message that comes meanwhile waits
 * for it to go. Until 2026-11 there was one slot, an error showed for five seconds, and the next message (a success
 * toast, another error) wiped it, so a refused action could be said and gone before anyone read it. Success, info and
 * warnings still close by themselves, and a newer one of those takes the place of an older one.
 */
export interface SnackbarMessage {
  message: string
  color: string
  /** Milliseconds; -1: until closed. */
  timeout: number
}

const snackbar = reactive({
  visible: false,
  message: '',
  color: 'error',
  timeout: 5000,
  /** What waits behind the one shown. */
  queue: [] as SnackbarMessage[],
})

/** How long a success stays. An error stays until it is closed. */
export const SUCCESS_TIMEOUT_MS = 3000
export const ERROR_TIMEOUT = -1

function show(next: SnackbarMessage) {
  snackbar.message = next.message
  snackbar.color = next.color
  snackbar.timeout = next.timeout
  snackbar.visible = true
}

// The shown message went (closed, or its time was up): the next one in the queue is shown, a moment later so that
// it reads as a new message. `sync`: a message shown and closed in one tick is still followed by the next.
watch(() => snackbar.visible, (visible) => {
  if (visible) return
  const next = snackbar.queue.shift()
  if (next) setTimeout(() => show(next), 0)
}, { flush: 'sync' })

export function useSnackbar() {
  function showSnackbar(text: string, color = 'error', timeout = color === 'error' ? ERROR_TIMEOUT : 5000) {
    // An error stays until it is closed, whatever time a caller asked for.
    const next = { message: text, color, timeout: color === 'error' ? ERROR_TIMEOUT : timeout }
    // The same message twice in a row (a button pressed again) is said once.
    const last = snackbar.queue.at(-1) ?? (snackbar.visible ? snackbar : null)
    if (last && last.message === text && last.color === color) return
    // Nothing removes an error: what comes while one is shown (or waits) queues behind it. A message that closes by
    // itself (a success, a warning) is replaced by the next one, as before: it was going anyway.
    if (snackbar.visible && (snackbar.color === 'error' || snackbar.queue.length)) snackbar.queue.push(next)
    else show(next)
  }

  function showError(text: string) {
    showSnackbar(text, 'error', ERROR_TIMEOUT)
  }

  function showSuccess(text: string) {
    showSnackbar(text, 'success', SUCCESS_TIMEOUT_MS)
  }

  /** Close the message shown; the next in the queue follows. */
  function hideSnackbar() {
    snackbar.visible = false
  }

  /** A message no longer true (the action it refused has now succeeded): out of the line, shown or waiting. */
  function withdraw(text: string) {
    snackbar.queue = snackbar.queue.filter((m) => m.message !== text)
    if (snackbar.visible && snackbar.message === text) snackbar.visible = false
  }

  return { snackbar, showSnackbar, showError, showSuccess, hideSnackbar, withdraw }
}
