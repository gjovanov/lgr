import { defineStore } from 'pinia'
import { ref } from 'vue'
import { useAppStore } from './app.store'

export const useAdminStore = defineStore('admin', () => {
  const appStore = useAppStore()
  const auditLogs = ref<any[]>([])
  const loading = ref(false)

  async function fetchAuditLogs(filters?: { module?: string; userId?: string; action?: string; dateFrom?: string; dateTo?: string }) {
    loading.value = true
    try { auditLogs.value = [] } finally { loading.value = false }
  }

  return {
    auditLogs, loading,
    fetchAuditLogs,
  }
})
