import { Schema, model, type Document, type Types } from 'mongoose'
import { tenantPlugin } from '../plugins/tenant.plugin.js'

export interface IQualityCheck {
  parameter: string
  expected: string
  actual: string
  passed: boolean
}

export interface IProductionStage {
  name: string
  order: number
  status: string
  plannedDuration: number
  actualDuration?: number
  assignedTo?: Types.ObjectId
  startedAt?: Date
  completedAt?: Date
  notes?: string
  qualityChecks?: IQualityCheck[]
}

export interface IMaterialConsumed {
  productId: Types.ObjectId
  plannedQuantity: number
  actualQuantity: number
  wastage: number
  movementId?: Types.ObjectId
}

export interface IProductionOrder extends Document {
  _id: Types.ObjectId
  orgId: Types.ObjectId
  orderNumber: string
  bomId: Types.ObjectId
  productId: Types.ObjectId
  quantity: number
  warehouseId: Types.ObjectId
  outputWarehouseId: Types.ObjectId
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
  createdBy: Types.ObjectId
  createdAt: Date
  updatedAt: Date
}

const qualityCheckSchema = new Schema<IQualityCheck>(
  {
    parameter: { type: String, required: true },
    expected: { type: String, required: true },
    actual: { type: String, required: true },
    passed: { type: Boolean, required: true },
  },
  { _id: false },
)

const productionStageSchema = new Schema<IProductionStage>(
  {
    name: { type: String, required: true },
    order: { type: Number, required: true },
    status: {
      type: String,
      required: true,
      default: 'pending',
      enum: ['pending', 'in_progress', 'completed', 'skipped'],
    },
    plannedDuration: { type: Number, required: true },
    actualDuration: Number,
    assignedTo: { type: Schema.Types.ObjectId, ref: 'Employee' },
    startedAt: Date,
    completedAt: Date,
    notes: String,
    qualityChecks: [qualityCheckSchema],
  },
  { _id: false },
)

const materialConsumedSchema = new Schema<IMaterialConsumed>(
  {
    productId: { type: Schema.Types.ObjectId, ref: 'Product', required: true },
    plannedQuantity: { type: Number, required: true },
    actualQuantity: { type: Number, required: true, default: 0 },
    wastage: { type: Number, required: true, default: 0 },
    movementId: { type: Schema.Types.ObjectId, ref: 'StockMovement' },
  },
  { _id: false },
)

const productionOrderSchema = new Schema<IProductionOrder>(
  {
    orderNumber: { type: String, required: true },
    bomId: { type: Schema.Types.ObjectId, ref: 'BillOfMaterials', required: true },
    productId: { type: Schema.Types.ObjectId, ref: 'Product', required: true },
    quantity: { type: Number, required: true },
    warehouseId: { type: Schema.Types.ObjectId, ref: 'Warehouse', required: true },
    outputWarehouseId: { type: Schema.Types.ObjectId, ref: 'Warehouse', required: true },
    status: {
      type: String,
      required: true,
      default: 'planned',
      enum: ['planned', 'in_progress', 'quality_check', 'completed', 'cancelled'],
    },
    priority: {
      type: String,
      required: true,
      default: 'normal',
      enum: ['low', 'normal', 'high', 'urgent'],
    },
    plannedStartDate: { type: Date, required: true },
    plannedEndDate: { type: Date, required: true },
    actualStartDate: Date,
    actualEndDate: Date,
    stages: [productionStageSchema],
    materialsConsumed: [materialConsumedSchema],
    quantityProduced: { type: Number, required: true, default: 0 },
    quantityDefective: { type: Number, required: true, default: 0 },
    totalCost: { type: Number, required: true, default: 0 },
    costPerUnit: { type: Number, required: true, default: 0 },
    notes: String,
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: true },
)

productionOrderSchema.plugin(tenantPlugin)
productionOrderSchema.index({ orgId: 1, orderNumber: 1 }, { unique: true })
productionOrderSchema.index({ orgId: 1, status: 1, plannedStartDate: 1 })
productionOrderSchema.index({ orgId: 1, productId: 1 })

export const ProductionOrder = model<IProductionOrder>('ProductionOrder', productionOrderSchema)
