import { defineStore } from 'pinia'
import { ref } from 'vue'
import { httpClient } from 'ui-shared/composables/useHttpClient'
import { useAppStore } from './app.store'

export const useSalesStore = defineStore('sales', () => {
  const appStore = useAppStore()

  // State
  const orders = ref<any[]>([])
  const templates = ref<any[]>([])
  const loading = ref(false)
  const total = ref(0)

  function orgUrl() {
    return `/org/${appStore.currentOrg?.id}`
  }

  // --- Orders ---

  async function fetchOrders(params?: Record<string, unknown>) {
    loading.value = true
    try {
      const { data } = await httpClient.get(`${orgUrl()}/sales/orders`, { params })
      orders.value = data.salesOrders || []
      total.value = data.total ?? 0
      return data
    } finally {
      loading.value = false
    }
  }

  async function fetchOrder(id: string) {
    loading.value = true
    try {
      const { data } = await httpClient.get(`${orgUrl()}/sales/orders/${id}`)
      return data
    } finally {
      loading.value = false
    }
  }

  async function createOrder(payload: Record<string, any>) {
    loading.value = true
    try {
      const { data } = await httpClient.post(`${orgUrl()}/sales/orders`, payload)
      return data
    } finally {
      loading.value = false
    }
  }

  async function updateOrder(id: string, payload: Record<string, any>) {
    loading.value = true
    try {
      const { data } = await httpClient.put(`${orgUrl()}/sales/orders/${id}`, payload)
      return data
    } finally {
      loading.value = false
    }
  }

  async function deleteOrder(id: string) {
    loading.value = true
    try {
      await httpClient.delete(`${orgUrl()}/sales/orders/${id}`)
      orders.value = orders.value.filter(o => o._id !== id && o.id !== id)
    } finally {
      loading.value = false
    }
  }

  async function sendQuotation(id: string) {
    loading.value = true
    try {
      const { data } = await httpClient.post(`${orgUrl()}/sales/orders/${id}/send`)
      return data
    } finally {
      loading.value = false
    }
  }

  async function confirmOrder(id: string) {
    loading.value = true
    try {
      const { data } = await httpClient.post(`${orgUrl()}/sales/orders/${id}/confirm`)
      return data
    } finally {
      loading.value = false
    }
  }

  async function createInvoice(id: string) {
    loading.value = true
    try {
      const { data } = await httpClient.post(`${orgUrl()}/sales/orders/${id}/invoice`)
      return data
    } finally {
      loading.value = false
    }
  }

  async function cancelOrder(id: string) {
    loading.value = true
    try {
      const { data } = await httpClient.post(`${orgUrl()}/sales/orders/${id}/cancel`)
      return data
    } finally {
      loading.value = false
    }
  }

  async function markDone(id: string) {
    loading.value = true
    try {
      const { data } = await httpClient.post(`${orgUrl()}/sales/orders/${id}/done`)
      return data
    } finally {
      loading.value = false
    }
  }

  // --- Templates ---

  async function fetchTemplates(params?: Record<string, unknown>) {
    loading.value = true
    try {
      const { data } = await httpClient.get(`${orgUrl()}/sales/templates`, { params })
      templates.value = data.templates || []
      return data
    } finally {
      loading.value = false
    }
  }

  async function createTemplate(payload: Record<string, any>) {
    loading.value = true
    try {
      const { data } = await httpClient.post(`${orgUrl()}/sales/templates`, payload)
      templates.value.unshift(data)
      return data
    } finally {
      loading.value = false
    }
  }

  async function updateTemplate(id: string, payload: Record<string, any>) {
    loading.value = true
    try {
      const { data } = await httpClient.put(`${orgUrl()}/sales/templates/${id}`, payload)
      const idx = templates.value.findIndex(t => t._id === id || t.id === id)
      if (idx !== -1) templates.value[idx] = data
      return data
    } finally {
      loading.value = false
    }
  }

  async function deleteTemplate(id: string) {
    loading.value = true
    try {
      await httpClient.delete(`${orgUrl()}/sales/templates/${id}`)
      templates.value = templates.value.filter(t => t._id !== id && t.id !== id)
    } finally {
      loading.value = false
    }
  }

  return {
    // State
    orders,
    templates,
    loading,
    total,
    // Orders
    fetchOrders,
    fetchOrder,
    createOrder,
    updateOrder,
    deleteOrder,
    sendQuotation,
    confirmOrder,
    createInvoice,
    cancelOrder,
    markDone,
    // Templates
    fetchTemplates,
    createTemplate,
    updateTemplate,
    deleteTemplate,
  }
})
