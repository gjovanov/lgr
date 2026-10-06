/**
 * What an org switch must not interrupt in THIS tab (multi-org sign-in, Phase 3).
 *
 * A switch reloads the tab into the other org. A sale in progress, or a fiscal printer this tab
 * is bridging, would be orphaned mid-operation: the device could be left with a receipt open and
 * nobody to close it. A screen that holds such a thing registers a guard while it does. The org
 * menu asks before switching and refuses with the guard's reason.
 *
 * A guard returns the i18n key of why the switch must wait, or null.
 */
export type SwitchGuard = () => string | null

const guards = new Set<SwitchGuard>()

/** Register a guard; call the returned function when the screen no longer holds anything. */
export function registerSwitchGuard(guard: SwitchGuard): () => void {
  guards.add(guard)
  return () => {
    guards.delete(guard)
  }
}

/** The first reason (an i18n key) a switch must wait, or null when nothing in this tab objects. */
export function switchBlockedBy(): string | null {
  for (const guard of guards) {
    const reason = guard()
    if (reason) return reason
  }
  return null
}

const unsavedChecks = new Set<() => boolean>()

/**
 * A form with unsaved edits. A switch does not lose them (the page's `beforeunload` keeps them
 * under Pending changes, in the org they belong to), but the person is asked first, because they
 * reappear only back in that org.
 */
export function registerUnsavedCheck(check: () => boolean): () => void {
  unsavedChecks.add(check)
  return () => {
    unsavedChecks.delete(check)
  }
}

export function hasUnsavedWork(): boolean {
  for (const check of unsavedChecks) if (check()) return true
  return false
}
