import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { httpClient } from '../composables/useHttpClient'
import { useAppStore } from './app.store'

export interface Product {
  _id: string
  sku: string
  name: string
  description?: string
  category: string
  unit: string
  price: number
  cost: number
  isActive: boolean
  trackInventory: boolean
}

export interface Warehouse {
  _id: string
  name: string
  code: string
  address?: string
  isActive: boolean
}

export interface StockLevel {
  _id: string
  productId: string
  productName?: string
  warehouseId: string
  warehouseName?: string
  quantity: number
  reservedQuantity: number
  availableQuantity: number
}

export interface StockMovement {
  _id: string
  type: 'receipt' | 'shipment' | 'transfer' | 'adjustment'
  status: 'draft' | 'confirmed' | 'cancelled'
  fromWarehouseId?: string
  toWarehouseId?: string
  date: string
  reference?: string
  lines: MovementLine[]
}

export interface MovementLine {
  productId: string
  productName?: string
  quantity: number
  unit: string
}

export interface InventoryCount {
  _id: string
  warehouseId: string
  date: string
  status: 'in_progress' | 'completed'
  lines: InventoryCountLine[]
}

export interface InventoryCountLine {
  productId: string
  expectedQuantity: number
  countedQuantity: number
  difference: number
}

export interface PriceList {
  _id: string
  name: string
  currency: string
  isActive: boolean
  items: PriceListItem[]
}

export interface PriceListItem {
  productId: string
  price: number
  minQuantity?: number
}

export const useWarehouseStore = defineStore('warehouse', () => {
  const appStore = useAppStore()

  // State
  const products = ref<Product[]>([])
  const warehouses = ref<Warehouse[]>([])
  const stockLevels = ref<StockLevel[]>([])
  const stockMovements = ref<StockMovement[]>([])
  const inventoryCounts = ref<InventoryCount[]>([])
  const priceLists = ref<PriceList[]>([])
  const loading = ref(false)

  // Helpers
  function orgUrl() {
    return `/org/${appStore.currentOrg?.id}`
  }

  // Getters
  const activeProducts = computed(() =>
    products.value.filter(p => p.isActive)
  )

  const activeWarehouses = computed(() =>
    warehouses.value.filter(w => w.isActive)
  )

  const lowStockProducts = computed(() =>
    stockLevels.value.filter(s => s.availableQuantity <= 0)
  )

  // --- Products ---
  async function fetchProducts(filters?: Record<string, unknown>) {
    loading.value = true
    try {
      const { data } = await httpClient.get(`${orgUrl()}/warehouse/product`, { params: filters })
      products.value = data.products
    } finally {
      loading.value = false
    }
  }

  async function createProduct(payload: Partial<Product>) {
    loading.value = true
    try {
      const { data } = await httpClient.post(`${orgUrl()}/warehouse/product`, payload)
      products.value.push(data.product)
      return data.product
    } finally {
      loading.value = false
    }
  }

  async function updateProduct(id: string, payload: Partial<Product>) {
    loading.value = true
    try {
      const { data } = await httpClient.put(`${orgUrl()}/warehouse/product/${id}`, payload)
      const idx = products.value.findIndex(p => p._id === id)
      if (idx !== -1) products.value[idx] = data.product
      return data.product
    } finally {
      loading.value = false
    }
  }

  async function deleteProduct(id: string) {
    loading.value = true
    try {
      await httpClient.delete(`${orgUrl()}/warehouse/product/${id}`)
      products.value = products.value.filter(p => p._id !== id)
    } finally {
      loading.value = false
    }
  }

  // --- Warehouses ---
  async function fetchWarehouses() {
    loading.value = true
    try {
      const { data } = await httpClient.get(`${orgUrl()}/warehouse/warehouse`)
      warehouses.value = data.warehouses
    } finally {
      loading.value = false
    }
  }

  async function createWarehouse(payload: Partial<Warehouse>) {
    loading.value = true
    try {
      const { data } = await httpClient.post(`${orgUrl()}/warehouse/warehouse`, payload)
      warehouses.value.push(data.warehouse)
      return data.warehouse
    } finally {
      loading.value = false
    }
  }

  async function updateWarehouse(id: string, payload: Partial<Warehouse>) {
    loading.value = true
    try {
      const { data } = await httpClient.put(`${orgUrl()}/warehouse/warehouse/${id}`, payload)
      const idx = warehouses.value.findIndex(w => w._id === id)
      if (idx !== -1) warehouses.value[idx] = data.warehouse
      return data.warehouse
    } finally {
      loading.value = false
    }
  }

  async function deleteWarehouse(id: string) {
    loading.value = true
    try {
      await httpClient.delete(`${orgUrl()}/warehouse/warehouse/${id}`)
      warehouses.value = warehouses.value.filter(w => w._id !== id)
    } finally {
      loading.value = false
    }
  }

  // --- Stock Levels ---
  async function fetchStockLevels(filters?: { warehouseId?: string; productId?: string }) {
    loading.value = true
    try {
      const { data } = await httpClient.get(`${orgUrl()}/warehouse/stock-level`, { params: filters })
      stockLevels.value = data.stockLevels
    } finally {
      loading.value = false
    }
  }

  async function createStockLevel(payload: Partial<StockLevel>) {
    loading.value = true
    try {
      const { data } = await httpClient.post(`${orgUrl()}/warehouse/stock-level`, payload)
      stockLevels.value.push(data.stockLevel)
      return data.stockLevel
    } finally {
      loading.value = false
    }
  }

  async function updateStockLevel(id: string, payload: Partial<StockLevel>) {
    loading.value = true
    try {
      const { data } = await httpClient.put(`${orgUrl()}/warehouse/stock-level/${id}`, payload)
      const idx = stockLevels.value.findIndex(s => s._id === id)
      if (idx !== -1) stockLevels.value[idx] = data.stockLevel
      return data.stockLevel
    } finally {
      loading.value = false
    }
  }

  async function deleteStockLevel(id: string) {
    loading.value = true
    try {
      await httpClient.delete(`${orgUrl()}/warehouse/stock-level/${id}`)
      stockLevels.value = stockLevels.value.filter(s => s._id !== id)
    } finally {
      loading.value = false
    }
  }

  // --- Stock Movements ---
  async function fetchStockMovements(filters?: Record<string, unknown>) {
    loading.value = true
    try {
      const { data } = await httpClient.get(`${orgUrl()}/warehouse/stock-movement`, { params: filters })
      stockMovements.value = data.stockMovements
    } finally {
      loading.value = false
    }
  }

  async function createStockMovement(payload: Partial<StockMovement>) {
    loading.value = true
    try {
      const { data } = await httpClient.post(`${orgUrl()}/warehouse/stock-movement`, payload)
      stockMovements.value.unshift(data.stockMovement)
      return data.stockMovement
    } finally {
      loading.value = false
    }
  }

  async function updateStockMovement(id: string, payload: Partial<StockMovement>) {
    loading.value = true
    try {
      const { data } = await httpClient.put(`${orgUrl()}/warehouse/stock-movement/${id}`, payload)
      const idx = stockMovements.value.findIndex(m => m._id === id)
      if (idx !== -1) stockMovements.value[idx] = data.stockMovement
      return data.stockMovement
    } finally {
      loading.value = false
    }
  }

  async function deleteStockMovement(id: string) {
    loading.value = true
    try {
      await httpClient.delete(`${orgUrl()}/warehouse/stock-movement/${id}`)
      stockMovements.value = stockMovements.value.filter(m => m._id !== id)
    } finally {
      loading.value = false
    }
  }

  async function confirmMovement(id: string) {
    loading.value = true
    try {
      const { data } = await httpClient.post(`${orgUrl()}/warehouse/stock-movement/${id}/confirm`)
      const idx = stockMovements.value.findIndex(m => m._id === id)
      if (idx !== -1) stockMovements.value[idx] = data.stockMovement
      return data.stockMovement
    } finally {
      loading.value = false
    }
  }

  // --- Inventory Counts ---
  async function fetchInventoryCounts(filters?: Record<string, unknown>) {
    loading.value = true
    try {
      const { data } = await httpClient.get(`${orgUrl()}/warehouse/inventory-count`, { params: filters })
      inventoryCounts.value = data.inventoryCounts
    } finally {
      loading.value = false
    }
  }

  async function createInventoryCount(payload: Partial<InventoryCount>) {
    loading.value = true
    try {
      const { data } = await httpClient.post(`${orgUrl()}/warehouse/inventory-count`, payload)
      inventoryCounts.value.unshift(data.inventoryCount)
      return data.inventoryCount
    } finally {
      loading.value = false
    }
  }

  async function updateInventoryCount(id: string, payload: Partial<InventoryCount>) {
    loading.value = true
    try {
      const { data } = await httpClient.put(`${orgUrl()}/warehouse/inventory-count/${id}`, payload)
      const idx = inventoryCounts.value.findIndex(c => c._id === id)
      if (idx !== -1) inventoryCounts.value[idx] = data.inventoryCount
      return data.inventoryCount
    } finally {
      loading.value = false
    }
  }

  async function deleteInventoryCount(id: string) {
    loading.value = true
    try {
      await httpClient.delete(`${orgUrl()}/warehouse/inventory-count/${id}`)
      inventoryCounts.value = inventoryCounts.value.filter(c => c._id !== id)
    } finally {
      loading.value = false
    }
  }

  // --- Price Lists ---
  async function fetchPriceLists() {
    loading.value = true
    try {
      const { data } = await httpClient.get(`${orgUrl()}/warehouse/price-list`)
      priceLists.value = data.priceLists
    } finally {
      loading.value = false
    }
  }

  async function createPriceList(payload: Partial<PriceList>) {
    loading.value = true
    try {
      const { data } = await httpClient.post(`${orgUrl()}/warehouse/price-list`, payload)
      priceLists.value.push(data.priceList)
      return data.priceList
    } finally {
      loading.value = false
    }
  }

  async function updatePriceList(id: string, payload: Partial<PriceList>) {
    loading.value = true
    try {
      const { data } = await httpClient.put(`${orgUrl()}/warehouse/price-list/${id}`, payload)
      const idx = priceLists.value.findIndex(p => p._id === id)
      if (idx !== -1) priceLists.value[idx] = data.priceList
      return data.priceList
    } finally {
      loading.value = false
    }
  }

  async function deletePriceList(id: string) {
    loading.value = true
    try {
      await httpClient.delete(`${orgUrl()}/warehouse/price-list/${id}`)
      priceLists.value = priceLists.value.filter(p => p._id !== id)
    } finally {
      loading.value = false
    }
  }

  // --- Special ---
  async function getStockValuation() {
    loading.value = true
    try {
      const { data } = await httpClient.get(`${orgUrl()}/warehouse/report/stock-valuation`)
      return data
    } finally {
      loading.value = false
    }
  }

  return {
    // State
    products,
    warehouses,
    stockLevels,
    stockMovements,
    inventoryCounts,
    priceLists,
    loading,
    // Getters
    activeProducts,
    activeWarehouses,
    lowStockProducts,
    // Actions - Products
    fetchProducts,
    createProduct,
    updateProduct,
    deleteProduct,
    // Actions - Warehouses
    fetchWarehouses,
    createWarehouse,
    updateWarehouse,
    deleteWarehouse,
    // Actions - Stock Levels
    fetchStockLevels,
    createStockLevel,
    updateStockLevel,
    deleteStockLevel,
    // Actions - Stock Movements
    fetchStockMovements,
    createStockMovement,
    updateStockMovement,
    deleteStockMovement,
    confirmMovement,
    // Actions - Inventory Counts
    fetchInventoryCounts,
    createInventoryCount,
    updateInventoryCount,
    deleteInventoryCount,
    // Actions - Price Lists
    fetchPriceLists,
    createPriceList,
    updatePriceList,
    deletePriceList,
    // Actions - Reports
    getStockValuation,
  }
})
