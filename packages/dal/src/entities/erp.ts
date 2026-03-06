import type { TenantEntity } from '../types.js'

// ── BillOfMaterials ──

export interface IBOMMaterial {
  id?: string
  productId: string
  quantity: number
  unit: string
  wastagePercent: number
  cost: number
  notes?: string
}

export interface IBillOfMaterials extends TenantEntity {
  productId: string
  name: string
  version: string
  status: string
  materials: IBOMMaterial[]
  laborHours: number
  laborCostPerHour: number
  overheadCost: number
  totalMaterialCost: number
  totalCost: number
  instructions?: string
}

// ── ProductionOrder ──

export interface IQualityCheck {
  parameter: string
  expected: string
  actual: string
  passed: boolean
}

export interface IProductionStage {
  id?: string
  name: string
  order: number
  status: string
  plannedDuration: number
  actualDuration?: number
  assignedTo?: string
  startedAt?: Date
  completedAt?: Date
  notes?: string
  qualityChecks?: IQualityCheck[]
}

export interface IMaterialConsumed {
  id?: string
  productId: string
  plannedQuantity: number
  actualQuantity: number
  wastage: number
  movementId?: string
}

export interface IProductionOrder extends TenantEntity {
  orderNumber: string
  bomId: string
  productId: string
  quantity: number
  warehouseId: string
  outputWarehouseId: string
  status: string
  priority: string
  plannedStartDate: Date
  plannedEndDate: Date
  actualStartDate?: Date
  actualEndDate?: Date
  stages: IProductionStage[]
  materialsConsumed: IMaterialConsumed[]
  quantityProduced: number
  quantityDefective: number
  totalCost: number
  costPerUnit: number
  notes?: string
  createdBy: string
}

// ── ConstructionProject ──

export interface IProjectAddress {
  street: string
  city: string
  state?: string
  postalCode: string
  country: string
}

export interface IProjectBudget {
  estimated: number
  currency: string
  approved: number
  spent: number
  remaining: number
}

export interface IProjectTask {
  id?: string
  name: string
  assignedTo?: string
  status: string
  dueDate?: Date
  completedAt?: Date
}

export interface IProjectPhase {
  id?: string
  name: string
  order: number
  status: string
  startDate?: Date
  endDate?: Date
  budget: number
  spent: number
  tasks: IProjectTask[]
}

export interface IProjectTeamMember {
  id?: string
  employeeId: string
  role: string
  startDate: Date
  endDate?: Date
}

export interface IProjectMaterial {
  id?: string
  productId: string
  quantity: number
  unitCost: number
  totalCost: number
  deliveryDate?: Date
  status: string
  movementId?: string
}

export interface IConstructionProject extends TenantEntity {
  projectNumber: string
  name: string
  clientId: string
  address?: IProjectAddress
  status: string
  startDate: Date
  expectedEndDate: Date
  actualEndDate?: Date
  budget: IProjectBudget
  phases: IProjectPhase[]
  team: IProjectTeamMember[]
  materials: IProjectMaterial[]
  totalInvoiced: number
  totalPaid: number
  margin: number
  documents: string[]
  notes?: string
  createdBy: string
}

// ── POSSession ──

export interface IPOSSession extends TenantEntity {
  warehouseId: string
  cashierId: string
  sessionNumber: string
  openedAt: Date
  closedAt?: Date
  status: string
  openingBalance: number
  closingBalance?: number
  expectedBalance?: number
  difference?: number
  currency: string
  totalSales: number
  totalReturns: number
  totalCash: number
  totalCard: number
  transactionCount: number
}

// ── POSTransaction ──

export interface IPOSTransactionLine {
  id?: string
  productId: string
  name: string
  quantity: number
  unitPrice: number
  discount: number
  taxRate: number
  taxAmount: number
  lineTotal: number
}

export interface IPOSTransactionPayment {
  id?: string
  method: string
  amount: number
  reference?: string
}

export interface IPOSTransaction extends TenantEntity {
  sessionId: string
  transactionNumber: string
  type: string
  customerId?: string
  lines: IPOSTransactionLine[]
  subtotal: number
  discountTotal: number
  taxTotal: number
  total: number
  payments: IPOSTransactionPayment[]
  changeDue: number
  invoiceId?: string
  movementId?: string
  createdBy: string
}
