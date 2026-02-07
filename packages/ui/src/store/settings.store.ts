import { defineStore } from 'pinia'
import { ref } from 'vue'
import { useAppStore } from './app.store'

export const useSettingsStore = defineStore('settings', () => {
  const appStore = useAppStore()
  const organization = ref<any>(null)
  const users = ref<any[]>([])
  const loading = ref(false)

  async function fetchOrganization() {
    loading.value = true
    try { organization.value = null } finally { loading.value = false }
  }

  async function saveOrganization(data: any) { /* TODO */ }

  async function fetchUsers() {
    loading.value = true
    try { users.value = [] } finally { loading.value = false }
  }

  async function saveUser(data: any) { /* TODO */ }
  async function inviteUser(email: string) { /* TODO */ }

  return {
    organization, users, loading,
    fetchOrganization, saveOrganization,
    fetchUsers, saveUser, inviteUser,
  }
})
