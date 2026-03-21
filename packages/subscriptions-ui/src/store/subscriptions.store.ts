import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { httpClient } from 'ui-shared/composables/useHttpClient'
import { useAppStore } from './app.store'

export interface SubscriptionLine {
  productId?: string
  name: string
  quantity: number
  priceUnit: number
  discount?: number
  priceSubtotal?: number
}

export interface Subscription {
  _id: string
  name: string
  partnerId: string
  partnerName?: string
  state: 'draft' | 'active' | 'paused' | 'cancelled' | 'expired'
  lines: SubscriptionLine[]
  recurringInterval: number
  recurringPeriod: 'day' | 'week' | 'month' | 'year'
  dateStart: string
  dateEnd?: string
  nextInvoiceDate: string
  currency: string
  amountRecurring: number
  paymentMethod?: string
  autoRenew: boolean
  cancellationReason?: string
  invoiceIds: string[]
  notes?: string
  createdBy: string
  createdAt: string
}

export const useSubscriptionsStore = defineStore('subscriptions', () => {
  const appStore = useAppStore()

  // State
  const subscriptions = ref<Subscription[]>([])
  const currentSubscription = ref<Subscription | null>(null)
  const loading = ref(false)

  function orgUrl() {
    return `/org/${appStore.currentOrg?.id}`
  }

  // Getters
  const activeSubscriptions = computed(() =>
    subscriptions.value.filter(s => s.state === 'active')
  )

  const totalMRR = computed(() =>
    activeSubscriptions.value.reduce((sum, s) => {
      let monthly = s.amountRecurring
      if (s.recurringPeriod === 'year') monthly = s.amountRecurring / 12
      else if (s.recurringPeriod === 'week') monthly = s.amountRecurring * 4.33
      else if (s.recurringPeriod === 'day') monthly = s.amountRecurring * 30
      return sum + monthly
    }, 0)
  )

  const averageValue = computed(() => {
    const active = activeSubscriptions.value
    if (!active.length) return 0
    return active.reduce((sum, s) => sum + s.amountRecurring, 0) / active.length
  })

  // Actions
  async function fetchSubscriptions(filters?: Record<string, unknown>) {
    loading.value = true
    try {
      const { data } = await httpClient.get(`${orgUrl()}/subscriptions`, { params: filters })
      subscriptions.value = data.subscriptions || []
      return data
    } finally {
      loading.value = false
    }
  }

  async function fetchSubscription(id: string) {
    loading.value = true
    try {
      const { data } = await httpClient.get(`${orgUrl()}/subscriptions/${id}`)
      currentSubscription.value = data
      return data
    } finally {
      loading.value = false
    }
  }

  async function createSubscription(payload: Partial<Subscription>) {
    loading.value = true
    try {
      const { data } = await httpClient.post(`${orgUrl()}/subscriptions`, payload)
      subscriptions.value.unshift(data)
      return data
    } finally {
      loading.value = false
    }
  }

  async function updateSubscription(id: string, payload: Partial<Subscription>) {
    loading.value = true
    try {
      const { data } = await httpClient.put(`${orgUrl()}/subscriptions/${id}`, payload)
      const idx = subscriptions.value.findIndex(s => s._id === id)
      if (idx !== -1) subscriptions.value[idx] = data
      currentSubscription.value = data
      return data
    } finally {
      loading.value = false
    }
  }

  async function deleteSubscription(id: string) {
    loading.value = true
    try {
      await httpClient.delete(`${orgUrl()}/subscriptions/${id}`)
      subscriptions.value = subscriptions.value.filter(s => s._id !== id)
    } finally {
      loading.value = false
    }
  }

  async function activateSubscription(id: string) {
    loading.value = true
    try {
      const { data } = await httpClient.post(`${orgUrl()}/subscriptions/${id}/activate`)
      const idx = subscriptions.value.findIndex(s => s._id === id)
      if (idx !== -1) subscriptions.value[idx] = data
      currentSubscription.value = data
      return data
    } finally {
      loading.value = false
    }
  }

  async function pauseSubscription(id: string) {
    loading.value = true
    try {
      const { data } = await httpClient.post(`${orgUrl()}/subscriptions/${id}/pause`)
      const idx = subscriptions.value.findIndex(s => s._id === id)
      if (idx !== -1) subscriptions.value[idx] = data
      currentSubscription.value = data
      return data
    } finally {
      loading.value = false
    }
  }

  async function resumeSubscription(id: string) {
    loading.value = true
    try {
      const { data } = await httpClient.post(`${orgUrl()}/subscriptions/${id}/resume`)
      const idx = subscriptions.value.findIndex(s => s._id === id)
      if (idx !== -1) subscriptions.value[idx] = data
      currentSubscription.value = data
      return data
    } finally {
      loading.value = false
    }
  }

  async function cancelSubscription(id: string, reason: string) {
    loading.value = true
    try {
      const { data } = await httpClient.post(`${orgUrl()}/subscriptions/${id}/cancel`, { reason })
      const idx = subscriptions.value.findIndex(s => s._id === id)
      if (idx !== -1) subscriptions.value[idx] = data
      currentSubscription.value = data
      return data
    } finally {
      loading.value = false
    }
  }

  async function generateInvoices() {
    loading.value = true
    try {
      const { data } = await httpClient.post(`${orgUrl()}/subscriptions/generate-invoices`)
      return data
    } finally {
      loading.value = false
    }
  }

  return {
    // State
    subscriptions,
    currentSubscription,
    loading,
    // Getters
    activeSubscriptions,
    totalMRR,
    averageValue,
    // Actions
    fetchSubscriptions,
    fetchSubscription,
    createSubscription,
    updateSubscription,
    deleteSubscription,
    activateSubscription,
    pauseSubscription,
    resumeSubscription,
    cancelSubscription,
    generateInvoices,
  }
})
