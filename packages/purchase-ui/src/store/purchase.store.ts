import { defineStore } from 'pinia'
import { ref } from 'vue'
import { httpClient } from 'ui-shared/composables/useHttpClient'
import { useAppStore } from './app.store'

export const usePurchaseStore = defineStore('purchase', () => {
  const appStore = useAppStore()

  // State
  const orders = ref<any[]>([])
  const agreements = ref<any[]>([])
  const reorderRules = ref<any[]>([])
  const loading = ref(false)
  const total = ref(0)

  function orgUrl() {
    return `/org/${appStore.currentOrg?.id}`
  }

  // --- Orders ---

  async function fetchOrders(params?: Record<string, unknown>) {
    loading.value = true
    try {
      const { data } = await httpClient.get(`${orgUrl()}/purchase/orders`, { params })
      orders.value = data.purchaseOrders || []
      total.value = data.total ?? 0
      return data
    } finally {
      loading.value = false
    }
  }

  async function fetchOrder(id: string) {
    loading.value = true
    try {
      const { data } = await httpClient.get(`${orgUrl()}/purchase/orders/${id}`)
      return data
    } finally {
      loading.value = false
    }
  }

  async function createOrder(payload: Record<string, any>) {
    loading.value = true
    try {
      const { data } = await httpClient.post(`${orgUrl()}/purchase/orders`, payload)
      return data
    } finally {
      loading.value = false
    }
  }

  async function updateOrder(id: string, payload: Record<string, any>) {
    loading.value = true
    try {
      const { data } = await httpClient.put(`${orgUrl()}/purchase/orders/${id}`, payload)
      return data
    } finally {
      loading.value = false
    }
  }

  async function deleteOrder(id: string) {
    loading.value = true
    try {
      await httpClient.delete(`${orgUrl()}/purchase/orders/${id}`)
      orders.value = orders.value.filter(o => o._id !== id && o.id !== id)
    } finally {
      loading.value = false
    }
  }

  async function sendRFQ(id: string) {
    loading.value = true
    try {
      const { data } = await httpClient.post(`${orgUrl()}/purchase/orders/${id}/send`)
      return data
    } finally {
      loading.value = false
    }
  }

  async function requestApproval(id: string) {
    loading.value = true
    try {
      const { data } = await httpClient.post(`${orgUrl()}/purchase/orders/${id}/request-approval`)
      return data
    } finally {
      loading.value = false
    }
  }

  async function approve(id: string) {
    loading.value = true
    try {
      const { data } = await httpClient.post(`${orgUrl()}/purchase/orders/${id}/approve`)
      return data
    } finally {
      loading.value = false
    }
  }

  async function reject(id: string) {
    loading.value = true
    try {
      const { data } = await httpClient.post(`${orgUrl()}/purchase/orders/${id}/reject`)
      return data
    } finally {
      loading.value = false
    }
  }

  async function confirm(id: string) {
    loading.value = true
    try {
      const { data } = await httpClient.post(`${orgUrl()}/purchase/orders/${id}/confirm`)
      return data
    } finally {
      loading.value = false
    }
  }

  async function recordReceipt(id: string, lines: { productId: string; qtyReceived: number }[]) {
    loading.value = true
    try {
      const { data } = await httpClient.post(`${orgUrl()}/purchase/orders/${id}/receive`, { lines })
      return data
    } finally {
      loading.value = false
    }
  }

  async function createBill(id: string) {
    loading.value = true
    try {
      const { data } = await httpClient.post(`${orgUrl()}/purchase/orders/${id}/bill`)
      return data
    } finally {
      loading.value = false
    }
  }

  async function cancel(id: string) {
    loading.value = true
    try {
      const { data } = await httpClient.post(`${orgUrl()}/purchase/orders/${id}/cancel`)
      return data
    } finally {
      loading.value = false
    }
  }

  // --- Agreements ---

  async function fetchAgreements(params?: Record<string, unknown>) {
    loading.value = true
    try {
      const { data } = await httpClient.get(`${orgUrl()}/purchase/agreements`, { params })
      agreements.value = data.blanketOrders || []
      return data
    } finally {
      loading.value = false
    }
  }

  async function createAgreement(payload: Record<string, any>) {
    loading.value = true
    try {
      const { data } = await httpClient.post(`${orgUrl()}/purchase/agreements`, payload)
      agreements.value.unshift(data)
      return data
    } finally {
      loading.value = false
    }
  }

  async function updateAgreement(id: string, payload: Record<string, any>) {
    loading.value = true
    try {
      const { data } = await httpClient.put(`${orgUrl()}/purchase/agreements/${id}`, payload)
      const idx = agreements.value.findIndex(a => a._id === id || a.id === id)
      if (idx !== -1) agreements.value[idx] = data
      return data
    } finally {
      loading.value = false
    }
  }

  async function deleteAgreement(id: string) {
    loading.value = true
    try {
      await httpClient.delete(`${orgUrl()}/purchase/agreements/${id}`)
      agreements.value = agreements.value.filter(a => a._id !== id && a.id !== id)
    } finally {
      loading.value = false
    }
  }

  // --- Reorder Rules ---

  async function fetchReorderRules(params?: Record<string, unknown>) {
    loading.value = true
    try {
      const { data } = await httpClient.get(`${orgUrl()}/purchase/reorder-rules`, { params })
      reorderRules.value = data.reorderRules || []
      return data
    } finally {
      loading.value = false
    }
  }

  async function createReorderRule(payload: Record<string, any>) {
    loading.value = true
    try {
      const { data } = await httpClient.post(`${orgUrl()}/purchase/reorder-rules`, payload)
      reorderRules.value.unshift(data)
      return data
    } finally {
      loading.value = false
    }
  }

  async function updateReorderRule(id: string, payload: Record<string, any>) {
    loading.value = true
    try {
      const { data } = await httpClient.put(`${orgUrl()}/purchase/reorder-rules/${id}`, payload)
      const idx = reorderRules.value.findIndex(r => r._id === id || r.id === id)
      if (idx !== -1) reorderRules.value[idx] = data
      return data
    } finally {
      loading.value = false
    }
  }

  async function deleteReorderRule(id: string) {
    loading.value = true
    try {
      await httpClient.delete(`${orgUrl()}/purchase/reorder-rules/${id}`)
      reorderRules.value = reorderRules.value.filter(r => r._id !== id && r.id !== id)
    } finally {
      loading.value = false
    }
  }

  return {
    // State
    orders,
    agreements,
    reorderRules,
    loading,
    total,
    // Orders
    fetchOrders,
    fetchOrder,
    createOrder,
    updateOrder,
    deleteOrder,
    sendRFQ,
    requestApproval,
    approve,
    reject,
    confirm,
    recordReceipt,
    createBill,
    cancel,
    // Agreements
    fetchAgreements,
    createAgreement,
    updateAgreement,
    deleteAgreement,
    // Reorder Rules
    fetchReorderRules,
    createReorderRule,
    updateReorderRule,
    deleteReorderRule,
  }
})
