import { Schema, model, type Document, type Types } from 'mongoose'
import { tenantPlugin } from '../plugins/tenant.plugin.js'

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
  name: string
  assignedTo?: Types.ObjectId
  status: string
  dueDate?: Date
  completedAt?: Date
}

export interface IProjectPhase {
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
  employeeId: Types.ObjectId
  role: string
  startDate: Date
  endDate?: Date
}

export interface IProjectMaterial {
  productId: Types.ObjectId
  quantity: number
  unitCost: number
  totalCost: number
  deliveryDate?: Date
  status: string
  movementId?: Types.ObjectId
}

export interface IConstructionProject extends Document {
  _id: Types.ObjectId
  orgId: Types.ObjectId
  projectNumber: string
  name: string
  clientId: Types.ObjectId
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
  documents: Types.ObjectId[]
  notes?: string
  createdBy: Types.ObjectId
  createdAt: Date
  updatedAt: Date
}

const projectTaskSchema = new Schema<IProjectTask>(
  {
    name: { type: String, required: true },
    assignedTo: { type: Schema.Types.ObjectId, ref: 'Employee' },
    status: {
      type: String,
      required: true,
      default: 'pending',
      enum: ['pending', 'in_progress', 'completed'],
    },
    dueDate: Date,
    completedAt: Date,
  },
  { _id: false },
)

const projectPhaseSchema = new Schema<IProjectPhase>(
  {
    name: { type: String, required: true },
    order: { type: Number, required: true },
    status: {
      type: String,
      required: true,
      default: 'pending',
      enum: ['pending', 'in_progress', 'completed'],
    },
    startDate: Date,
    endDate: Date,
    budget: { type: Number, required: true },
    spent: { type: Number, required: true, default: 0 },
    tasks: [projectTaskSchema],
  },
  { _id: false },
)

const projectTeamMemberSchema = new Schema<IProjectTeamMember>(
  {
    employeeId: { type: Schema.Types.ObjectId, ref: 'Employee', required: true },
    role: { type: String, required: true },
    startDate: { type: Date, required: true },
    endDate: Date,
  },
  { _id: false },
)

const projectMaterialSchema = new Schema<IProjectMaterial>(
  {
    productId: { type: Schema.Types.ObjectId, ref: 'Product', required: true },
    quantity: { type: Number, required: true },
    unitCost: { type: Number, required: true },
    totalCost: { type: Number, required: true },
    deliveryDate: Date,
    status: {
      type: String,
      required: true,
      default: 'ordered',
      enum: ['ordered', 'delivered', 'installed'],
    },
    movementId: { type: Schema.Types.ObjectId, ref: 'StockMovement' },
  },
  { _id: false },
)

const constructionProjectSchema = new Schema<IConstructionProject>(
  {
    projectNumber: { type: String, required: true },
    name: { type: String, required: true },
    clientId: { type: Schema.Types.ObjectId, ref: 'Contact', required: true },
    address: {
      street: { type: String, required: true },
      city: { type: String, required: true },
      state: String,
      postalCode: { type: String, required: true },
      country: { type: String, required: true },
    },
    status: {
      type: String,
      required: true,
      default: 'planning',
      enum: ['planning', 'active', 'on_hold', 'completed', 'cancelled'],
    },
    startDate: { type: Date, required: true },
    expectedEndDate: { type: Date, required: true },
    actualEndDate: Date,
    budget: {
      estimated: { type: Number, required: true },
      currency: { type: String, required: true },
      approved: { type: Number, required: true },
      spent: { type: Number, required: true, default: 0 },
      remaining: { type: Number, required: true },
    },
    phases: [projectPhaseSchema],
    team: [projectTeamMemberSchema],
    materials: [projectMaterialSchema],
    totalInvoiced: { type: Number, required: true, default: 0 },
    totalPaid: { type: Number, required: true, default: 0 },
    margin: { type: Number, required: true, default: 0 },
    documents: [{ type: Schema.Types.ObjectId, ref: 'File' }],
    notes: String,
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: true },
)

constructionProjectSchema.plugin(tenantPlugin)
constructionProjectSchema.index({ orgId: 1, projectNumber: 1 }, { unique: true })
constructionProjectSchema.index({ orgId: 1, clientId: 1 })
constructionProjectSchema.index({ orgId: 1, status: 1 })

export const ConstructionProject = model<IConstructionProject>(
  'ConstructionProject',
  constructionProjectSchema,
)
