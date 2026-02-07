import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { httpClient } from '../composables/useHttpClient'
import { useAppStore } from './app.store'

export interface Notification {
  _id: string
  type: string
  title: string
  message: string
  read: boolean
  createdAt: string
  data?: Record<string, unknown>
}

export const useNotificationStore = defineStore('notification', () => {
  const appStore = useAppStore()

  // State
  const notifications = ref<Notification[]>([])
  const loading = ref(false)

  // Helpers
  function orgUrl() {
    return `/org/${appStore.currentOrg?.id}`
  }

  // Getters
  const unreadCount = computed(() =>
    notifications.value.filter(n => !n.read).length
  )

  const unreadNotifications = computed(() =>
    notifications.value.filter(n => !n.read)
  )

  // Actions
  async function fetchNotifications() {
    loading.value = true
    try {
      const { data } = await httpClient.get(`${orgUrl()}/notification`)
      notifications.value = data.notifications
    } finally {
      loading.value = false
    }
  }

  async function markAsRead(id: string) {
    const notification = notifications.value.find(n => n._id === id)
    if (notification) {
      notification.read = true
      await httpClient.patch(`${orgUrl()}/notification/${id}/read`)
    }
  }

  async function markAllAsRead() {
    notifications.value.forEach(n => { n.read = true })
    await httpClient.patch(`${orgUrl()}/notification/read-all`)
  }

  function addNotification(notification: Notification) {
    notifications.value.unshift(notification)
  }

  function clearAll() {
    notifications.value = []
  }

  return {
    // State
    notifications,
    loading,
    // Getters
    unreadCount,
    unreadNotifications,
    // Actions
    fetchNotifications,
    markAsRead,
    markAllAsRead,
    addNotification,
    clearAll,
  }
})
