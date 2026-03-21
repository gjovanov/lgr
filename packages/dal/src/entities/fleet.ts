import type { TenantEntity } from '../types.js'

export interface IVehicle extends TenantEntity {
  name: string; model: string; brand: string; driverId?: string
  state: string; acquisitionDate?: Date; purchaseValue?: number
  fuelType: string; odometer: number; nextServiceDate?: Date; insuranceExpiry?: Date; notes?: string
}

export interface IVehicleCost extends TenantEntity {
  vehicleId: string; type: string; amount: number; date: Date
  vendorId?: string; odometer?: number; description?: string
  isRecurring: boolean; recurringInterval?: number; recurringPeriod?: string
}
