import { ref, inject, watch, onMounted, onUnmounted, onActivated, onDeactivated } from 'vue'
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

export function usePendingChanges(config: PendingChangesConfig) {
  const store = usePendingChangesStore()
  const route = useRoute()
  const router = useRouter()

  const saved = ref(false)
  // null until the form has taken its clean state (FR-22.13): leaving a document before it has
  // finished loading is not leaving unsaved changes.
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

  function snapshot() {
    try {
      initialSnapshot = JSON.stringify(config.getFormData())
    } catch {
      initialSnapshot = null
    }
  }

  function captureIfDirty() {
    if (saved.value || !isDirty()) return
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

  function markSaved() {
    saved.value = true
    if (restoredEntryId) {
      store.remove(restoredEntryId)
      restoredEntryId = null
    }
  }

  /**
   * The form shows what is stored, and stays open on it (FR-22.16: a document form keeps the user
   * on the document it saved). What it shows now is the clean state, and an edit from here is
   * unsaved again — `markSaved` alone would leave every later edit to be dropped on leaving.
   */
  function markClean() {
    saved.value = false
    snapshot()
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
    router.replace({ ...route, query: rest })
    // Re-snapshot after restore so navigating away without further changes won't re-capture
    setTimeout(() => snapshot(), 0)
    return true
  }

  // Route navigation guard. On the user's first dirty-leave we show a one-time
  // explanatory dialog ("your work is saved under Pending Changes"). After they
  // acknowledge with the "don't show again" checkbox, future leaves go straight
  // to capture. The capture itself always runs — we never silently drop changes.
  const leaveGuard: NavigationGuard = async () => {
    if (!isDirty() || saved.value) return
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
    unregisterUnsaved = registerUnsavedCheck(() => !saved.value && isDirty())
    window.addEventListener('beforeunload', handleBeforeUnload)
    // Delay initial snapshot to let form populate (e.g., from API fetch in edit mode)
    setTimeout(() => {
      if (!saved.value) snapshot()
    }, 500)
  })

  onUnmounted(() => {
    unregisterUnsaved?.()
    window.removeEventListener('beforeunload', handleBeforeUnload)
  })

  return { markSaved, markClean, tryRestore, isDirty, snapshot }
}
