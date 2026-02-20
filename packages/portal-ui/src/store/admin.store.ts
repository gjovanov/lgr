import { defineStore } from 'pinia'
import { ref } from 'vue'
import { httpClient } from 'ui-shared/composables/useHttpClient'
import { useAppStore } from './app.store'

export const useAdminStore = defineStore('admin', () => {
  const appStore = useAppStore()
  const auditLogs = ref<any[]>([])
  const total = ref(0)
  const loading = ref(false)

  async function fetchAuditLogs(params?: { page?: number; pageSize?: number; module?: string; action?: string }) {
    loading.value = true
    try {
      // AuditLog endpoint will be available once fully wired
      auditLogs.value = []
      total.value = 0
    } finally {
      loading.value = false
    }
  }

  return {
    auditLogs,
    total,
    loading,
    fetchAuditLogs,
  }
})
