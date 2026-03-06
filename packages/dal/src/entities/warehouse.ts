import type { TenantEntity } from '../types.js'

// ── Product ──

export interface IProductDimensions {
  length: number
  width: number
  height: number
  unit: string
}

export interface IProductCustomPrice {
  id?: string
  contactId: string
  price: number
  minQuantity?: number
  validFrom?: Date
  validTo?: Date
}

export interface IProductVariant {
  id?: string
  name: string
  options: string[]
}

export interface IProduct extends TenantEntity {
  sku: string
  barcode?: string
  name: string
  description?: string
  category: string
  type: string
  unit: string
  purchasePrice: number
  sellingPrice: number
  currency: string
  taxRate: number
  revenueAccountId?: string
  expenseAccountId?: string
  inventoryAccountId?: string
  trackInventory: boolean
  minStockLevel?: number
  maxStockLevel?: number
  weight?: number
  dimensions?: IProductDimensions
  images?: string[]
  customPrices: IProductCustomPrice[]
  variants?: IProductVariant[]
  tags?: string[]
  isActive: boolean
}

// ── Warehouse ──

export interface IWarehouseAddress {
  street: string
  city: string
  state?: string
  postalCode: string
  country: string
}

export interface IWarehouse extends TenantEntity {
  name: string
  code: string
  address?: IWarehouseAddress | string
  type: string
  manager?: string
  managerId?: string
  isDefault: boolean
  isActive: boolean
  tags?: string[]
}

// ── StockLevel ──

export interface IStockLevel extends TenantEntity {
  productId: string
  warehouseId: string
  quantity: number
  reservedQuantity: number
  availableQuantity: number
  avgCost: number
  lastCountDate?: Date
}

// ── StockMovement ──

export interface IStockMovementLine {
  id?: string
  productId: string
  quantity: number
  unitCost: number
  totalCost: number
  batchNumber?: string
  expiryDate?: Date
  serialNumbers?: string[]
}

export interface IStockMovement extends TenantEntity {
  movementNumber: string
  type: string
  status: string
  date: Date
  fromWarehouseId?: string
  toWarehouseId?: string
  contactId?: string
  invoiceId?: string
  productionOrderId?: string
  lines: IStockMovementLine[]
  totalAmount: number
  notes?: string
  journalEntryId?: string
  createdBy: string
}

// ── InventoryCount ──

export interface IInventoryCountLine {
  id?: string
  productId: string
  systemQuantity: number
  countedQuantity: number
  variance: number
  varianceCost: number
  notes?: string
}

export interface IInventoryCount extends TenantEntity {
  countNumber: string
  warehouseId: string
  date: Date
  status: string
  type: string
  lines: IInventoryCountLine[]
  adjustmentMovementId?: string
  completedBy?: string
  completedAt?: Date
  createdBy: string
}

// ── PriceList ──

export interface IPriceListItem {
  id?: string
  productId: string
  price: number
  minQuantity?: number
  discount?: number
}

export interface IPriceList extends TenantEntity {
  name: string
  currency: string
  isDefault: boolean
  validFrom?: Date
  validTo?: Date
  items: IPriceListItem[]
  isActive: boolean
}
