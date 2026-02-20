import { defineStore } from 'pinia'
import { ref } from 'vue'
import { httpClient } from 'ui-shared/composables/useHttpClient'
import { useAppStore } from './app.store'

export const useSettingsStore = defineStore('settings', () => {
  const appStore = useAppStore()
  const org = ref<Record<string, any> | null>(null)
  const users = ref<any[]>([])
  const loading = ref(false)

  async function fetchOrg() {
    loading.value = true
    try {
      const { data } = await httpClient.get(`${appStore.orgUrl()}`)
      org.value = data
    } finally {
      loading.value = false
    }
  }

  async function updateOrg(payload: Record<string, any>) {
    const { data } = await httpClient.put(`${appStore.orgUrl()}`, payload)
    org.value = data
    return data
  }

  async function fetchUsers() {
    loading.value = true
    try {
      const { data } = await httpClient.get(`${appStore.orgUrl()}/user`)
      users.value = Array.isArray(data) ? data : []
    } finally {
      loading.value = false
    }
  }

  async function createUser(payload: Record<string, any>) {
    const { data } = await httpClient.post(`${appStore.orgUrl()}/user`, payload)
    users.value.push(data)
    return data
  }

  async function updateUser(userId: string, payload: Record<string, any>) {
    const { data } = await httpClient.put(`${appStore.orgUrl()}/user/${userId}`, payload)
    const idx = users.value.findIndex(u => u._id === userId)
    if (idx !== -1) users.value[idx] = data
    return data
  }

  async function deleteUser(userId: string) {
    await httpClient.delete(`${appStore.orgUrl()}/user/${userId}`)
    users.value = users.value.filter(u => u._id !== userId)
  }

  return {
    org,
    users,
    loading,
    fetchOrg,
    updateOrg,
    fetchUsers,
    createUser,
    updateUser,
    deleteUser,
  }
})
