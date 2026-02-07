import type { Schema } from 'mongoose'

export function tenantPlugin(schema: Schema) {
  schema.add({
    orgId: {
      type: 'ObjectId',
      ref: 'Org',
      required: true,
      index: true,
    },
  })

  // Auto-filter by orgId on find queries
  schema.pre('find', function () {
    if (!this.getFilter().orgId) return
  })

  schema.pre('findOne', function () {
    if (!this.getFilter().orgId) return
  })

  schema.pre('countDocuments', function () {
    if (!this.getFilter().orgId) return
  })
}
