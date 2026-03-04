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
      org.value = data.org || data
    } finally {
      loading.value = false
    }
  }

  async function updateOrg(payload: Record<string, any>) {
    const { data } = await httpClient.put(`${appStore.orgUrl()}`, payload)
    org.value = data.org || data
    return data.org || data
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
    const user = data.user || data
    users.value.push(user)
    return user
  }

  async function updateUser(userId: string, payload: Record<string, any>) {
    const { data } = await httpClient.put(`${appStore.orgUrl()}/user/${userId}`, payload)
    const user = data.user || data
    const idx = users.value.findIndex(u => u._id === userId)
    if (idx !== -1) users.value[idx] = user
    return user
  }

  async function deleteUser(userId: string) {
    await httpClient.delete(`${appStore.orgUrl()}/user/${userId}`)
    users.value = users.value.filter(u => u._id !== userId)
  }

  // Aliases used by OrganizationView
  const organization = org
  async function fetchOrganization() { return fetchOrg() }
  async function saveOrganization(payload: Record<string, any>) { return updateOrg(payload) }

  return {
    org,
    organization,
    users,
    loading,
    fetchOrg,
    updateOrg,
    fetchOrganization,
    saveOrganization,
    fetchUsers,
    createUser,
    updateUser,
    deleteUser,
  }
})
