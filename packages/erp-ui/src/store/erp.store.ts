import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { httpClient } from 'ui-shared/composables/useHttpClient'
import { useAppStore } from './app.store'

export interface BOM {
  _id: string
  name: string
  productId: string
  productName?: string
  version: string
  status: 'draft' | 'active' | 'obsolete'
  lines: BOMLine[]
  outputQuantity: number
  unit: string
}

export interface BOMLine {
  productId: string
  productName?: string
  quantity: number
  unit: string
  wastagePercent?: number
}

export interface ProductionOrder {
  _id: string
  number: string
  bomId: string
  bomName?: string
  quantity: number
  status: 'planned' | 'in_progress' | 'completed' | 'cancelled'
  plannedStart: string
  plannedEnd: string
  actualStart?: string
  actualEnd?: string
  warehouseId: string
  notes?: string
}

export interface ConstructionProject {
  _id: string
  name: string
  code: string
  clientId?: string
  clientName?: string
  startDate: string
  endDate?: string
  budget: number
  spent: number
  currency: string
  status: 'planning' | 'active' | 'on_hold' | 'completed' | 'cancelled'
  progress: number
  description?: string
}

export interface POSSession {
  _id: string
  number: string
  cashierId: string
  cashierName?: string
  openedAt: string
  closedAt?: string
  openingBalance: number
  closingBalance?: number
  status: 'open' | 'closed'
  transactionCount: number
  totalSales: number
}

export interface POSTransaction {
  _id: string
  sessionId: string
  number: string
  items: POSTransactionItem[]
  subtotal: number
  tax: number
  total: number
  paymentMethod: string
  date: string
  customerId?: string
}

export interface POSTransactionItem {
  productId: string
  productName: string
  quantity: number
  unitPrice: number
  amount: number
}

export const useERPStore = defineStore('erp', () => {
  const appStore = useAppStore()

  // State
  const boms = ref<BOM[]>([])
  const productionOrders = ref<ProductionOrder[]>([])
  const constructionProjects = ref<ConstructionProject[]>([])
  const posSessions = ref<POSSession[]>([])
  const posTransactions = ref<POSTransaction[]>([])
  const loading = ref(false)

  // Helpers
  function orgUrl() {
    return `/org/${appStore.currentOrg?.id}`
  }

  // Getters
  const activeBOMs = computed(() =>
    boms.value.filter(b => b.status === 'active')
  )

  const activeProductionOrders = computed(() =>
    productionOrders.value.filter(o => o.status === 'planned' || o.status === 'in_progress')
  )

  const activeProjects = computed(() =>
    constructionProjects.value.filter(p => p.status === 'active')
  )

  const openPOSSessions = computed(() =>
    posSessions.value.filter(s => s.status === 'open')
  )

  // --- BOMs ---
  async function fetchBOMs(filters?: Record<string, unknown>) {
    loading.value = true
    try {
      const { data } = await httpClient.get(`${orgUrl()}/erp/bom`, { params: filters })
      boms.value = data.boms
    } finally {
      loading.value = false
    }
  }

  async function createBOM(payload: Partial<BOM>) {
    loading.value = true
    try {
      const { data } = await httpClient.post(`${orgUrl()}/erp/bom`, payload)
      boms.value.push(data.bom)
      return data.bom
    } finally {
      loading.value = false
    }
  }

  async function updateBOM(id: string, payload: Partial<BOM>) {
    loading.value = true
    try {
      const { data } = await httpClient.put(`${orgUrl()}/erp/bom/${id}`, payload)
      const idx = boms.value.findIndex(b => b._id === id)
      if (idx !== -1) boms.value[idx] = data.bom
      return data.bom
    } finally {
      loading.value = false
    }
  }

  async function deleteBOM(id: string) {
    loading.value = true
    try {
      await httpClient.delete(`${orgUrl()}/erp/bom/${id}`)
      boms.value = boms.value.filter(b => b._id !== id)
    } finally {
      loading.value = false
    }
  }

  // --- Production Orders ---
  async function fetchProductionOrders(filters?: Record<string, unknown>) {
    loading.value = true
    try {
      const { data } = await httpClient.get(`${orgUrl()}/erp/production-order`, { params: filters })
      productionOrders.value = data.productionOrders
    } finally {
      loading.value = false
    }
  }

  async function createProductionOrder(payload: Partial<ProductionOrder>) {
    loading.value = true
    try {
      const { data } = await httpClient.post(`${orgUrl()}/erp/production-order`, payload)
      productionOrders.value.unshift(data.productionOrder)
      return data.productionOrder
    } finally {
      loading.value = false
    }
  }

  async function updateProductionOrder(id: string, payload: Partial<ProductionOrder>) {
    loading.value = true
    try {
      const { data } = await httpClient.put(`${orgUrl()}/erp/production-order/${id}`, payload)
      const idx = productionOrders.value.findIndex(o => o._id === id)
      if (idx !== -1) productionOrders.value[idx] = data.productionOrder
      return data.productionOrder
    } finally {
      loading.value = false
    }
  }

  async function deleteProductionOrder(id: string) {
    loading.value = true
    try {
      await httpClient.delete(`${orgUrl()}/erp/production-order/${id}`)
      productionOrders.value = productionOrders.value.filter(o => o._id !== id)
    } finally {
      loading.value = false
    }
  }

  async function startProduction(id: string) {
    loading.value = true
    try {
      const { data } = await httpClient.post(`${orgUrl()}/erp/production-order/${id}/start`)
      const idx = productionOrders.value.findIndex(o => o._id === id)
      if (idx !== -1) productionOrders.value[idx] = data.productionOrder
      return data.productionOrder
    } finally {
      loading.value = false
    }
  }

  async function completeProduction(id: string) {
    loading.value = true
    try {
      const { data } = await httpClient.post(`${orgUrl()}/erp/production-order/${id}/complete`)
      const idx = productionOrders.value.findIndex(o => o._id === id)
      if (idx !== -1) productionOrders.value[idx] = data.productionOrder
      return data.productionOrder
    } finally {
      loading.value = false
    }
  }

  // --- Construction Projects ---
  async function fetchConstructionProjects(filters?: Record<string, unknown>) {
    loading.value = true
    try {
      const { data } = await httpClient.get(`${orgUrl()}/erp/construction-project`, { params: filters })
      constructionProjects.value = data.projects
    } finally {
      loading.value = false
    }
  }

  async function createConstructionProject(payload: Partial<ConstructionProject>) {
    loading.value = true
    try {
      const { data } = await httpClient.post(`${orgUrl()}/erp/construction-project`, payload)
      constructionProjects.value.unshift(data.project)
      return data.project
    } finally {
      loading.value = false
    }
  }

  async function updateConstructionProject(id: string, payload: Partial<ConstructionProject>) {
    loading.value = true
    try {
      const { data } = await httpClient.put(`${orgUrl()}/erp/construction-project/${id}`, payload)
      const idx = constructionProjects.value.findIndex(p => p._id === id)
      if (idx !== -1) constructionProjects.value[idx] = data.project
      return data.project
    } finally {
      loading.value = false
    }
  }

  async function deleteConstructionProject(id: string) {
    loading.value = true
    try {
      await httpClient.delete(`${orgUrl()}/erp/construction-project/${id}`)
      constructionProjects.value = constructionProjects.value.filter(p => p._id !== id)
    } finally {
      loading.value = false
    }
  }

  // --- POS Sessions ---
  async function fetchPOSSessions(filters?: Record<string, unknown>) {
    loading.value = true
    try {
      const { data } = await httpClient.get(`${orgUrl()}/erp/pos/session`, { params: filters })
      posSessions.value = data.sessions
    } finally {
      loading.value = false
    }
  }

  async function openPOSSession(payload: { openingBalance: number }) {
    loading.value = true
    try {
      const { data } = await httpClient.post(`${orgUrl()}/erp/pos/session`, payload)
      posSessions.value.unshift(data.session)
      return data.session
    } finally {
      loading.value = false
    }
  }

  async function closePOSSession(id: string, payload?: { closingBalance: number }) {
    loading.value = true
    try {
      const { data } = await httpClient.post(`${orgUrl()}/erp/pos/session/${id}/close`, payload)
      const idx = posSessions.value.findIndex(s => s._id === id)
      if (idx !== -1) posSessions.value[idx] = data.session
      return data.session
    } finally {
      loading.value = false
    }
  }

  async function deletePOSSession(id: string) {
    loading.value = true
    try {
      await httpClient.delete(`${orgUrl()}/erp/pos/session/${id}`)
      posSessions.value = posSessions.value.filter(s => s._id !== id)
    } finally {
      loading.value = false
    }
  }

  // --- POS Transactions ---
  async function fetchPOSTransactions(sessionId: string) {
    loading.value = true
    try {
      const { data } = await httpClient.get(`${orgUrl()}/erp/pos/session/${sessionId}/transaction`)
      posTransactions.value = data.transactions
    } finally {
      loading.value = false
    }
  }

  async function createPOSTransaction(sessionId: string, payload: Partial<POSTransaction>) {
    loading.value = true
    try {
      const { data } = await httpClient.post(`${orgUrl()}/erp/pos/session/${sessionId}/transaction`, payload)
      posTransactions.value.unshift(data.transaction)
      return data.transaction
    } finally {
      loading.value = false
    }
  }

  return {
    // State
    boms,
    productionOrders,
    constructionProjects,
    posSessions,
    posTransactions,
    loading,
    // Getters
    activeBOMs,
    activeProductionOrders,
    activeProjects,
    openPOSSessions,
    // Actions - BOMs
    fetchBOMs,
    createBOM,
    updateBOM,
    deleteBOM,
    // Actions - Production Orders
    fetchProductionOrders,
    createProductionOrder,
    updateProductionOrder,
    deleteProductionOrder,
    startProduction,
    completeProduction,
    // Actions - Construction Projects
    fetchConstructionProjects,
    createConstructionProject,
    updateConstructionProject,
    deleteConstructionProject,
    // Actions - POS Sessions
    fetchPOSSessions,
    openPOSSession,
    closePOSSession,
    deletePOSSession,
    // Actions - POS Transactions
    fetchPOSTransactions,
    createPOSTransaction,
  }
})
