import { Schema, model, type Document, type Types } from 'mongoose'
import { tenantPlugin } from '../plugins/tenant.plugin.js'

export interface IFieldServicePart {
  productId: Types.ObjectId
  quantity: number
  unitCost: number
}

export interface IFieldServiceTask extends Document {
  _id: Types.ObjectId
  orgId: Types.ObjectId
  name: string
  description?: string
  partnerId?: Types.ObjectId       // Customer
  assigneeId: Types.ObjectId       // Field technician
  projectId?: Types.ObjectId
  state: string                    // scheduled, in_progress, done, cancelled
  priority: string                 // low, normal, high, urgent
  dateScheduled: Date
  dateStart?: Date
  dateEnd?: Date
  location?: string
  latitude?: number
  longitude?: number
  plannedHours: number
  effectiveHours: number
  parts: IFieldServicePart[]
  totalPartsCost: number
  totalLaborCost: number
  worksheetNotes?: string
  customerSignature?: string       // Base64
  technicianSignature?: string     // Base64
  invoiceId?: Types.ObjectId
  salesOrderId?: Types.ObjectId
  tags?: string[]
  createdBy: Types.ObjectId
  createdAt: Date
  updatedAt: Date
}

const partSchema = new Schema({ productId: { type: Schema.Types.ObjectId, ref: 'Product', required: true }, quantity: { type: Number, required: true, min: 0 }, unitCost: { type: Number, default: 0 } }, { _id: false })

const fieldServiceTaskSchema = new Schema<IFieldServiceTask>(
  {
    name: { type: String, required: true },
    description: String,
    partnerId: { type: Schema.Types.ObjectId, ref: 'Contact' },
    assigneeId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    projectId: { type: Schema.Types.ObjectId, ref: 'Project' },
    state: { type: String, default: 'scheduled', enum: ['scheduled', 'in_progress', 'done', 'cancelled'] },
    priority: { type: String, default: 'normal', enum: ['low', 'normal', 'high', 'urgent'] },
    dateScheduled: { type: Date, required: true },
    dateStart: Date,
    dateEnd: Date,
    location: String,
    latitude: Number,
    longitude: Number,
    plannedHours: { type: Number, default: 0 },
    effectiveHours: { type: Number, default: 0 },
    parts: [partSchema],
    totalPartsCost: { type: Number, default: 0 },
    totalLaborCost: { type: Number, default: 0 },
    worksheetNotes: String,
    customerSignature: String,
    technicianSignature: String,
    invoiceId: { type: Schema.Types.ObjectId, ref: 'Invoice' },
    salesOrderId: { type: Schema.Types.ObjectId, ref: 'SalesOrder' },
    tags: [String],
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: true },
)

fieldServiceTaskSchema.plugin(tenantPlugin)
fieldServiceTaskSchema.index({ orgId: 1, assigneeId: 1, dateScheduled: 1 })
fieldServiceTaskSchema.index({ orgId: 1, partnerId: 1 })
fieldServiceTaskSchema.index({ orgId: 1, state: 1, dateScheduled: 1 })
fieldServiceTaskSchema.index({ orgId: 1, projectId: 1 })
fieldServiceTaskSchema.index({ name: 'text', description: 'text', location: 'text' })

export const FieldServiceTask = model<IFieldServiceTask>('FieldServiceTask', fieldServiceTaskSchema)
