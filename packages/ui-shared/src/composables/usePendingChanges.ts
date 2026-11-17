import { inject, watch, nextTick, onMounted, onUnmounted, onActivated, onDeactivated } from 'vue'
import { useRoute, useRouter, matchedRouteKey, type NavigationGuard, type RouteRecordNormalized } from 'vue-router'
import { usePendingChangesStore } from '../stores/pending-changes.store'
import { registerUnsavedCheck } from '../session/switch-guards'
import { jwtUserId, orgIdFromStorage } from './useStorageIdentity'

export interface PendingChangesConfig {
  appId: string
  entityType: string
  icon?: string
  getFormData: () => Record<string, any>
  getPreviewFields: () => { label: string; value: string }[]
  setFormData: (data: Record<string, any>) => void
  isEdit: () => boolean
  entityId?: () => string | undefined
}

/** A copy of what a form holds, as it would be stored, or null when it cannot be written down. */
function copyOf(data: Record<string, any>): Record<string, any> | null {
  try {
    return JSON.parse(JSON.stringify(data))
  } catch {
    return null
  }
}

/**
 * The fields of `before` that differ from `clean`: what the person changed before a load put the stored values in
 * (FR-31.2). Compared field by field, as the snapshot is written; null when nothing differs.
 */
export function editsSince(before: Record<string, any>, clean: Record<string, any>): Record<string, any> | null {
  const edits: Record<string, any> = {}
  let any = false
  for (const key of Object.keys(before)) {
    if (JSON.stringify(before[key]) !== JSON.stringify(clean[key])) {
      edits[key] = before[key]
      any = true
    }
  }
  return any ? edits : null
}

/**
 * The guard over a form's unsaved edits (FR-31.1 to .3): it asks on leaving the page, keeps them on closing the tab,
 * and tells the org switch, while the form differs from its clean state.
 *
 * The clean state is taken
 *  - when the form mounts (a new record: what it starts with);
 *  - when its load resolves: `markLoaded()`, the first load and a reload after a save. No timer decides what an edit is;
 *  - when it is saved: `markSaved()`. The guard stays on, so an edit after a save that stays open is asked about.
 */
export function usePendingChanges(config: PendingChangesConfig) {
  const store = usePendingChangesStore()
  const route = useRoute()
  const router = useRouter()

  // null until the form has taken its clean state: there is nothing to compare with yet.
  let initialSnapshot: string | null = null
  // The pending-changes entry id this form was restored from (if any). Kept around so
  // we can remove it on successful save instead of on tryRestore — letting users
  // navigate in/out of a restored form without losing the entry until they save or
  // explicitly remove it from the right panel.
  let restoredEntryId: string | null = null

  function isDirty(): boolean {
    if (initialSnapshot === null) return false
    try {
      return JSON.stringify(config.getFormData()) !== initialSnapshot
    } catch {
      return false
    }
  }

  // The record the clean state was taken for: edits are carried over a load of the same record only.
  let cleanOf: string | undefined

  function snapshot() {
    cleanOf = config.entityId?.()
    try {
      initialSnapshot = JSON.stringify(config.getFormData())
    } catch {
      initialSnapshot = null
    }
  }

  function captureIfDirty() {
    if (!isDirty()) return
    store.capture({
      appId: config.appId,
      entityType: config.entityType,
      mode: config.isEdit() ? 'edit' : 'create',
      entityId: config.entityId?.(),
      routeName: route.name as string,
      routeParams: { ...route.params } as Record<string, string>,
      routePath: route.fullPath,
      formData: config.getFormData(),
      previewFields: config.getPreviewFields(),
      icon: config.icon,
    })
  }

  /**
   * What the form shows now is saved (FR-31.1, D-1). The clean state is taken again and the guard stays on: a form
   * that leaves right after its save is clean and is not asked, and one that stays open is guarded for the next edit.
   * Until 2026-11 this raised a flag that switched the guard off for good, and on the eight forms that stay open
   * after a save an edit made afterwards was dropped on leaving without a word.
   */
  function markSaved() {
    if (restoredEntryId) {
      store.remove(restoredEntryId)
      restoredEntryId = null
    }
    snapshot()
  }

  /** What the form shows now is what is stored (it was just read again); an edit from here is unsaved. */
  function markClean() {
    snapshot()
  }

  /**
   * The form's load has resolved (FR-31.2): what `apply` puts in the form is the clean state.
   *
   * Call it once the answer has arrived, with the assignment of the stored values as `apply`. An edit the person made
   * while the load was running is kept, over the loaded value of that field, and counts as an edit: the loaded
   * values never overwrite it silently. What `apply` itself awaits belongs to the load. Without `apply` the form's
   * values as they stand now are the clean state.
   *
   * A load of ANOTHER record (a link from one entry to the next on the same view) carries nothing over: the edits
   * were made to the record the form showed before.
   */
  async function markLoaded(apply?: () => void | Promise<void>): Promise<void> {
    const sameRecord = cleanOf === config.entityId?.()
    const clean = initialSnapshot === null || !sameRecord ? null : JSON.parse(initialSnapshot)
    const before = apply && clean ? copyOf(config.getFormData()) : null
    if (apply) await apply()
    // The watchers the loaded values set off run first: what they settle is part of the load.
    await nextTick()
    const edits = before && clean ? editsSince(before, clean) : null
    snapshot()
    if (edits) config.setFormData({ ...config.getFormData(), ...edits })
  }

  // Restore from pending changes if ?restore= query param
  function tryRestore() {
    const restoreId = route.query.restore as string
    if (!restoreId) return false
    // On a page load a form mounts before the shell that loads the store: the entry would not be
    // there yet, and the restore was lost with nothing said.
    if (!store.currentOrgId) store.load(orgIdFromStorage(), jwtUserId())
    const entry = store.getById(restoreId)
    if (!entry) return false
    config.setFormData(entry.formData)
    // Remember the source entry — it will be removed on successful save (markSaved).
    // Until then, navigating away without saving must keep the entry visible.
    restoredEntryId = restoreId
    // Remove the restore query param silently
    const { restore: _, ...rest } = route.query
    void router.replace({ ...route, query: rest }) // a failed navigation only leaves the query in the address
    // Re-snapshot after restore so navigating away without further changes won't re-capture
    setTimeout(() => snapshot(), 0)
    return true
  }

  // Route navigation guard. On the user's first dirty-leave we show a one-time
  // explanatory dialog ("your work is saved under Pending Changes"). After they
  // acknowledge with the "don't show again" checkbox, future leaves go straight
  // to capture. The capture itself always runs — we never silently drop changes.
  const leaveGuard: NavigationGuard = async () => {
    if (!isDirty()) return
    if (store.isDialogAcknowledged()) {
      captureIfDirty()
      return
    }
    const decision = await store.requestLeaveDecision()
    if (decision === 'cancel') return false
    if (decision === 'ack') store.acknowledgeDialog()
    captureIfDirty()
  }

  /**
   * `onBeforeRouteLeave`, except that the guard follows the route record the form is shown under.
   * vue-router binds it to the record of the moment it is registered, and a new document's form
   * stays mounted as it moves onto its own edit route once saved (FR-22.16): left on the `new`
   * record, the guard would never run again, and every later edit would be dropped on leaving.
   */
  const shownUnder = inject(matchedRouteKey, null)
  let guarded: RouteRecordNormalized | undefined
  function guardRecord(record: RouteRecordNormalized | undefined) {
    if (record === guarded) return
    guarded?.leaveGuards.delete(leaveGuard)
    guarded = record
    guarded?.leaveGuards.add(leaveGuard)
  }
  // As vue-router's own guard does under <keep-alive>: a cached, hidden form guards nothing, and
  // must not follow the record of the page shown in its place.
  let active = true
  watch(() => shownUnder?.value, (record) => { if (active) guardRecord(record) }, { immediate: true })
  onDeactivated(() => { active = false; guardRecord(undefined) })
  onActivated(() => { active = true; guardRecord(shownUnder?.value) })
  onUnmounted(() => guardRecord(undefined))

  // Browser close / tab close
  function handleBeforeUnload() {
    captureIfDirty()
  }

  // The org menu asks before a switch while this form has unsaved edits.
  let unregisterUnsaved: (() => void) | null = null

  onMounted(() => {
    unregisterUnsaved = registerUnsavedCheck(isDirty)
    if (typeof window !== 'undefined') window.addEventListener('beforeunload', handleBeforeUnload)
    // What the form starts with, once its mount has run (a new record's defaults, a restored entry): the clean state
    // until a load or a save takes another. Never a timer: one fired before a slow load and counted the load as an
    // edit, and took an edit made in the first half second as loaded.
    void nextTick(() => {
      if (initialSnapshot === null) snapshot()
    })
  })

  onUnmounted(() => {
    unregisterUnsaved?.()
    if (typeof window !== 'undefined') window.removeEventListener('beforeunload', handleBeforeUnload)
  })

  return { markSaved, markClean, markLoaded, tryRestore, isDirty, snapshot }
}
