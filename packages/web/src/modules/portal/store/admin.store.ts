import { defineStore } from 'pinia'
import { ref } from 'vue'
import { httpClient } from 'ui-shared/composables/useHttpClient'
import { useAppStore } from './app.store'

export const useAdminStore = defineStore('admin', () => {
  const appStore = useAppStore()
  const auditLogs = ref<any[]>([])
  const total = ref(0)
  const page = ref(0)
  const totalPages = ref(0)
  const loading = ref(false)

  async function fetchAuditLogs(params?: Record<string, any>) {
    loading.value = true
    try {
      const orgId = appStore.currentOrg?.id
      if (!orgId) return

      const queryParams: Record<string, any> = {
        page: params?.page ?? 0,
        size: params?.pageSize ?? 25,
      }
      if (params?.module) queryParams.module = params.module
      if (params?.modules) queryParams.modules = params.modules
      if (params?.action) queryParams.action = params.action
      if (params?.actions) queryParams.actions = params.actions
      if (params?.userId) queryParams.userId = params.userId
      if (params?.userIds) queryParams.userIds = params.userIds
      if (params?.entityType) queryParams.entityType = params.entityType
      if (params?.entityTypes) queryParams.entityTypes = params.entityTypes
      if (params?.entityIds) queryParams.entityIds = params.entityIds
      if (params?.dateFrom) queryParams.dateFrom = params.dateFrom
      if (params?.dateTo) queryParams.dateTo = params.dateTo

      const { data } = await httpClient.get(`/org/${orgId}/audit-logs`, { params: queryParams })
      auditLogs.value = data.auditLogs || []
      total.value = data.total || 0
      page.value = data.page || 0
      totalPages.value = data.totalPages || 0
    } catch {
      auditLogs.value = []
      total.value = 0
    } finally {
      loading.value = false
    }
  }

  return {
    auditLogs,
    total,
    page,
    totalPages,
    loading,
    fetchAuditLogs,
  }
})
