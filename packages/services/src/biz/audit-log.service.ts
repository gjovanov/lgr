import { AuditLog } from 'db/models'
import { mongoose } from 'db/connection'
const { Types } = mongoose

export interface AuditEntry {
  orgId: string
  userId: string
  action: string
  module: string
  entityType: string
  entityId: string
  changes?: { field: string; oldValue: any; newValue: any }[]
  ipAddress?: string
  userAgent?: string
}

export interface AuditQueryOptions {
  module?: string
  entityType?: string
  entityTypes?: string[]
  userId?: string
  action?: string
  dateFrom?: string
  dateTo?: string
  page?: number
  size?: number
}

/**
 * Create an audit log entry. Fire-and-forget — errors are caught and logged, never thrown.
 */
export function createAuditEntry(entry: AuditEntry): void {
  AuditLog.create({
    orgId: new Types.ObjectId(entry.orgId),
    userId: new Types.ObjectId(entry.userId),
    action: entry.action,
    module: entry.module,
    entityType: entry.entityType,
    entityId: new Types.ObjectId(entry.entityId),
    changes: entry.changes,
    ipAddress: entry.ipAddress,
    userAgent: entry.userAgent,
    timestamp: new Date(),
  }).catch(() => {
    // Audit failure must never block the operation
  })
}

/**
 * Compute field-level changes between two objects.
 */
export function diffChanges(
  oldDoc: Record<string, any>,
  newDoc: Record<string, any>,
  fields?: string[],
): { field: string; oldValue: any; newValue: any }[] {
  const changes: { field: string; oldValue: any; newValue: any }[] = []
  const keys = fields || Object.keys(newDoc)

  for (const key of keys) {
    if (key === '_id' || key === 'id' || key === 'orgId' || key === 'createdAt' || key === 'updatedAt' || key === '__v') continue
    const oldVal = oldDoc[key]
    const newVal = newDoc[key]

    // Simple comparison (stringify for objects/arrays)
    const oldStr = JSON.stringify(oldVal ?? null)
    const newStr = JSON.stringify(newVal ?? null)

    if (oldStr !== newStr) {
      changes.push({ field: key, oldValue: oldVal ?? null, newValue: newVal ?? null })
    }
  }

  return changes
}

/**
 * Query audit logs with filters and pagination.
 */
export async function queryAuditLogs(orgId: string, options: AuditQueryOptions = {}) {
  const filter: Record<string, any> = { orgId: new Types.ObjectId(orgId) }

  if (options.module) filter.module = options.module
  if (options.entityType) filter.entityType = options.entityType
  if (options.entityTypes?.length) filter.entityType = { $in: options.entityTypes }
  if (options.userId) filter.userId = new Types.ObjectId(options.userId)
  if (options.action) filter.action = options.action
  if (options.dateFrom || options.dateTo) {
    filter.timestamp = {} as any
    if (options.dateFrom) filter.timestamp.$gte = new Date(options.dateFrom)
    if (options.dateTo) filter.timestamp.$lte = new Date(options.dateTo)
  }

  const page = options.page ?? 0
  const size = options.size ?? 25
  const skip = page * size

  const [docs, total] = await Promise.all([
    AuditLog.find(filter)
      .sort({ timestamp: -1 })
      .skip(skip)
      .limit(size)
      .populate('userId', 'firstName lastName email username')
      .lean()
      .exec(),
    AuditLog.countDocuments(filter).exec(),
  ])

  const logs = docs.map((d: any) => ({
    _id: String(d._id),
    userId: d.userId?._id ? String(d.userId._id) : String(d.userId),
    userName: d.userId?.firstName
      ? `${d.userId.firstName} ${d.userId.lastName || ''}`.trim()
      : d.userId?.email || d.userId?.username || String(d.userId),
    action: d.action,
    module: d.module,
    entityType: d.entityType,
    entityId: String(d.entityId),
    changes: d.changes || [],
    ipAddress: d.ipAddress,
    userAgent: d.userAgent,
    timestamp: d.timestamp?.toISOString(),
  }))

  return {
    auditLogs: logs,
    total,
    page,
    size,
    totalPages: Math.ceil(total / size),
  }
}
