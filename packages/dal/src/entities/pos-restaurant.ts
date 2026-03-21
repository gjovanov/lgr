import type { TenantEntity } from '../types.js'

export interface IRestaurantTable {
  number: number; name: string; seats: number; positionX: number; positionY: number
  shape: string; state: string; currentOrderId?: string
}

export interface IRestaurantFloor extends TenantEntity {
  name: string; tables: IRestaurantTable[]; isActive: boolean
}

export interface IKitchenOrderLine {
  productId: string; productName: string; quantity: number; notes?: string; state: string
}

export interface IKitchenOrder extends TenantEntity {
  posTransactionId: string; tableNumber?: number; state: string
  lines: IKitchenOrderLine[]; priority: string; notes?: string
}
