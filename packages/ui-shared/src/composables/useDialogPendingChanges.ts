import { ref, watch, type Ref } from 'vue'
import { useRoute } from 'vue-router'
import { usePendingChangesStore } from '../stores/pending-changes.store'

export interface DialogPendingChangesConfig {
  appId: string
  entityType: string
  dialogId: string
  icon?: string
  dialogVisible: Ref<boolean>
  getFormData: () => Record<string, any>
  getPreviewFields: () => { label: string; value: string }[]
  setFormData: (data: Record<string, any>) => void
  isEdit: () => boolean
  entityId?: () => string | undefined
}

export function useDialogPendingChanges(config: DialogPendingChangesConfig) {
  const store = usePendingChangesStore()
  const route = useRoute()

  const saved = ref(false)
  let initialSnapshot = ''

  function snapshot() {
    try {
      initialSnapshot = JSON.stringify(config.getFormData())
    } catch {
      initialSnapshot = ''
    }
  }

  function isDirty(): boolean {
    try {
      return JSON.stringify(config.getFormData()) !== initialSnapshot
    } catch {
      return false
    }
  }

  function markSaved() {
    saved.value = true
  }

  // Watch dialog visibility
  watch(config.dialogVisible, (open, wasOpen) => {
    if (open && !wasOpen) {
      // Dialog just opened — snapshot and reset saved flag
      saved.value = false
      setTimeout(() => snapshot(), 0)
    } else if (!open && wasOpen) {
      // Dialog just closed — capture if dirty and not saved
      if (!saved.value && isDirty()) {
        store.capture({
          appId: config.appId,
          entityType: config.entityType,
          mode: config.isEdit() ? 'edit' : 'create',
          entityId: config.entityId?.(),
          dialogId: config.dialogId,
          routePath: route.fullPath,
          formData: config.getFormData(),
          previewFields: config.getPreviewFields(),
          icon: config.icon,
        })
      }
    }
  })

  // Check if there's a pending entry for this dialog to restore
  function restoreIfPending(): boolean {
    const restoreId = (route.query.restore as string) || ''
    if (!restoreId) return false
    const entry = store.getById(restoreId)
    if (!entry || entry.dialogId !== config.dialogId) return false
    config.setFormData(entry.formData)
    store.remove(restoreId)
    return true
  }

  return { markSaved, restoreIfPending, isDirty }
}
