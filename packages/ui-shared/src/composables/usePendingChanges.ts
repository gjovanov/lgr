import { ref, onMounted, onUnmounted } from 'vue'
import { useRoute, useRouter, onBeforeRouteLeave } from 'vue-router'
import { usePendingChangesStore } from '../stores/pending-changes.store'

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
  let initialSnapshot = ''

  function isDirty(): boolean {
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
      initialSnapshot = ''
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
  }

  // Restore from pending changes if ?restore= query param
  function tryRestore() {
    const restoreId = route.query.restore as string
    if (!restoreId) return false
    const entry = store.getById(restoreId)
    if (!entry) return false
    config.setFormData(entry.formData)
    store.remove(restoreId)
    // Remove the restore query param silently
    const { restore: _, ...rest } = route.query
    router.replace({ ...route, query: rest })
    // Re-snapshot after restore so navigating away without further changes won't re-capture
    setTimeout(() => snapshot(), 0)
    return true
  }

  // Route navigation guard
  onBeforeRouteLeave(() => {
    captureIfDirty()
  })

  // Browser close / tab close
  function handleBeforeUnload() {
    captureIfDirty()
  }

  onMounted(() => {
    window.addEventListener('beforeunload', handleBeforeUnload)
    // Delay initial snapshot to let form populate (e.g., from API fetch in edit mode)
    setTimeout(() => {
      if (!saved.value) snapshot()
    }, 500)
  })

  onUnmounted(() => {
    window.removeEventListener('beforeunload', handleBeforeUnload)
  })

  return { markSaved, tryRestore, isDirty, snapshot }
}
