import { ref, computed } from 'vue'
import { defineStore } from 'pinia'
import type { PendingChangeEntry } from './pending-changes.types'

const MAX_ENTRIES = 20

function storageKey(orgId: string, userId: string) {
  return `lgr_pending_changes_${orgId}_${userId}`
}

// Leave-dialog decisions: 'cancel' = stay on page; 'ok' = leave (dialog persists);
// 'ack' = leave AND don't show this dialog again (persisted to localStorage).
export type LeaveDecision = 'cancel' | 'ok' | 'ack'

function dialogAckKey(userId: string) {
  return `lgr:pending-changes:dialog-ack:${userId}`
}

export const usePendingChangesStore = defineStore('pendingChanges', () => {
  const entries = ref<PendingChangeEntry[]>([])
  const currentOrgId = ref('')
  const currentUserId = ref('')

  // Singleton leave-dialog state. Activated by usePendingChanges() composable; rendered
  // by AppShell. We keep the resolver here (not in the dialog component) so the
  // composable can await it across navigation events.
  const leaveDialogOpen = ref(false)
  let leaveDialogResolver: ((d: LeaveDecision) => void) | null = null

  const count = computed(() => entries.value.length)

  function load(orgId: string, userId: string) {
    currentOrgId.value = orgId
    currentUserId.value = userId
    try {
      const raw = localStorage.getItem(storageKey(orgId, userId))
      entries.value = raw ? JSON.parse(raw) : []
    } catch {
      entries.value = []
    }
  }

  function persist() {
    if (!currentOrgId.value || !currentUserId.value) return
    localStorage.setItem(
      storageKey(currentOrgId.value, currentUserId.value),
      JSON.stringify(entries.value),
    )
  }

  function capture(entry: Omit<PendingChangeEntry, 'id' | 'capturedAt' | 'orgId' | 'userId'>) {
    // Dedup: for edit mode, replace existing entry for same entity
    // For create mode, replace existing entry for same entityType + appId
    const idx = entries.value.findIndex(e => {
      if (entry.mode === 'edit' && e.mode === 'edit' && entry.entityId) {
        return e.entityType === entry.entityType && e.entityId === entry.entityId
      }
      if (entry.mode === 'create' && e.mode === 'create') {
        return e.entityType === entry.entityType && e.appId === entry.appId
      }
      return false
    })

    const full: PendingChangeEntry = {
      ...entry,
      id: crypto.randomUUID(),
      orgId: currentOrgId.value,
      userId: currentUserId.value,
      capturedAt: new Date().toISOString(),
    }

    if (idx >= 0) {
      entries.value.splice(idx, 1)
    }

    entries.value.unshift(full)

    // FIFO eviction
    if (entries.value.length > MAX_ENTRIES) {
      entries.value = entries.value.slice(0, MAX_ENTRIES)
    }

    persist()
  }

  function remove(id: string) {
    entries.value = entries.value.filter(e => e.id !== id)
    persist()
  }

  function removeAll() {
    entries.value = []
    persist()
  }

  function getById(id: string) {
    return entries.value.find(e => e.id === id)
  }

  // Cross-tab sync
  if (typeof window !== 'undefined') {
    window.addEventListener('storage', (e) => {
      if (e.key?.startsWith('lgr_pending_changes_') && currentOrgId.value && currentUserId.value) {
        if (e.key === storageKey(currentOrgId.value, currentUserId.value)) {
          try {
            entries.value = e.newValue ? JSON.parse(e.newValue) : []
          } catch { /* ignore */ }
        }
      }
    })
  }

  function isDialogAcknowledged(): boolean {
    if (!currentUserId.value) return false
    try {
      return localStorage.getItem(dialogAckKey(currentUserId.value)) === 'true'
    } catch { return false }
  }

  function acknowledgeDialog() {
    if (!currentUserId.value) return
    try { localStorage.setItem(dialogAckKey(currentUserId.value), 'true') } catch { /* ignore */ }
  }

  function requestLeaveDecision(): Promise<LeaveDecision> {
    return new Promise<LeaveDecision>(resolve => {
      leaveDialogResolver = resolve
      leaveDialogOpen.value = true
    })
  }

  function resolveLeaveDecision(decision: LeaveDecision) {
    leaveDialogOpen.value = false
    if (leaveDialogResolver) {
      const r = leaveDialogResolver
      leaveDialogResolver = null
      r(decision)
    }
  }

  return {
    entries,
    count,
    currentOrgId,
    currentUserId,
    leaveDialogOpen,
    load,
    capture,
    remove,
    removeAll,
    getById,
    isDialogAcknowledged,
    acknowledgeDialog,
    requestLeaveDecision,
    resolveLeaveDecision,
  }
})
