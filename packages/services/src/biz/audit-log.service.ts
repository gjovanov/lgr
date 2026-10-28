import { nodeRole } from 'config'
import { AuditLog, Desktop, User } from 'db/models'
import { mongoose } from 'db/connection'
import { currentRequest } from 'db/home/request-context'
import { getRepos } from '../context.js'
const { Types } = mongoose

const SENSITIVE_FIELDS = new Set(['password', 'token', 'secret', 'apiKey', 'creditCard', 'oauthProviders'])

export interface AuditEntry {
  orgId: string
  userId: string
  operatorCode?: string
  action: string
  module: string
  entityType: string
  entityId: string
  entityName?: string
  unpNumber?: string
  correlationId?: string
  changes?: { field: string; oldValue: any; newValue: any }[]
  ipAddress?: string
  userAgent?: string
  /** FR-20.48: where it came from, when the request context cannot say (a socket's own event). */
  via?: string
}

export interface AuditQueryOptions {
  modules?: string[]
  module?: string
  entityTypes?: string[]
  entityType?: string
  entityIds?: string[]
  userIds?: string[]
  userId?: string
  actions?: string[]
  action?: string
  dateFrom?: string
  dateTo?: string
  page?: number
  size?: number
}

/** ObjectId when castable, else the raw string (entityId is Mixed — e.g. sequence prefixes). */
function idOrString(v: unknown): Types.ObjectId | string | undefined {
  if (v == null) return undefined
  try { return new Types.ObjectId(String(v)) } catch { return String(v) }
}

/**
 * Create an audit log entry. Fire-and-forget — errors are logged, never thrown.
 * (Casts must not throw synchronously either: entityIds like "CASH_SALE" — sequence
 * prefixes — are not ObjectIds; they store as strings.)
 */
export function createAuditEntry(entry: AuditEntry): void {
  try {
    AuditLog.create(auditDoc(entry)).catch((err) => {
      console.warn('Audit log write failed:', err.message)
    })
  } catch (err: any) {
    console.warn('Audit log write failed:', err?.message)
  }
}

/**
 * `createAuditEntry`, awaited: for an entry that must be written before what follows changes the
 * org's home (FR-20.79's freeze), after which this node refuses the org's writes. Never throws either.
 */
export async function recordAuditEntry(entry: AuditEntry): Promise<boolean> {
  try {
    await AuditLog.create(auditDoc(entry))
    return true
  } catch (err: any) {
    console.warn('Audit log write failed:', err?.message)
    return false
  }
}

function auditDoc(entry: AuditEntry) {
  return {
    orgId: new Types.ObjectId(entry.orgId),
    userId: new Types.ObjectId(entry.userId),
    operatorCode: entry.operatorCode,
    action: entry.action,
    module: entry.module,
    entityType: entry.entityType,
    entityId: idOrString(entry.entityId),
    entityName: entry.entityName,
    unpNumber: entry.unpNumber,
    correlationId: entry.correlationId ? idOrString(entry.correlationId) : undefined,
    changes: entry.changes,
    ipAddress: entry.ipAddress,
    userAgent: entry.userAgent,
    via: viaOf(entry),
    timestamp: new Date(),
  }
}

/**
 * FR-20.48: on a master, every entry says where it came from: the request's `via` (a till, the
 * org's address, the console), and `loopback` for the server's own work (a tick, a job outside any
 * request). Nothing on lgrai.app, which has no shop network or tunnel of its own.
 */
function viaOf(entry: AuditEntry): string | undefined {
  if (entry.via) return entry.via
  const via = currentRequest()?.via
  if (via) return via
  return nodeRole() === 'master' ? 'loopback' : undefined
}

/** The desktops a page of entries names (`lan:<desktopId>`), by id, with their names. */
async function viaDesktops(orgId: string, docs: any[]): Promise<Map<string, string>> {
  const ids = [...new Set(docs.map(d => (typeof d.via === 'string' && d.via.startsWith('lan:') ? d.via.slice(4) : '')).filter(id => /^[0-9a-f]{24}$/.test(id)))]
  if (!ids.length) return new Map()
  const rows: any[] = await Desktop.find({ orgId: new Types.ObjectId(orgId), _id: { $in: ids.map(id => new Types.ObjectId(id)) } }, { name: 1 }).lean().exec()
  return new Map(rows.map(r => [String(r._id), String(r.name ?? '')]))
}

/** The entry's origin as the audit page shows it: the code, and the desktop's name for a till. */
function viaWire(d: any, desktops: Map<string, string>) {
  if (!d.via) return {}
  const desktop = typeof d.via === 'string' && d.via.startsWith('lan:') ? desktops.get(d.via.slice(4)) : undefined
  return { via: d.via, ...(desktop ? { viaDesktop: desktop } : {}) }
}

/**
 * Compute field-level changes between two objects.
 * Sensitive fields are redacted.
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

    if (SENSITIVE_FIELDS.has(key)) {
      const oldExists = oldDoc[key] != null
      const newExists = newDoc[key] != null
      if (oldExists !== newExists || (oldExists && JSON.stringify(oldDoc[key]) !== JSON.stringify(newDoc[key]))) {
        changes.push({ field: key, oldValue: '[REDACTED]', newValue: '[REDACTED]' })
      }
      continue
    }

    const oldVal = oldDoc[key]
    const newVal = newDoc[key]
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

  // Multi-value filters (arrays take precedence over single values)
  const modules = options.modules?.length ? options.modules : options.module ? [options.module] : null
  if (modules) filter.module = modules.length === 1 ? modules[0] : { $in: modules }

  const entityTypes = options.entityTypes?.length ? options.entityTypes : options.entityType ? [options.entityType] : null
  if (entityTypes) filter.entityType = entityTypes.length === 1 ? entityTypes[0] : { $in: entityTypes }

  const actions = options.actions?.length ? options.actions : options.action ? [options.action] : null
  if (actions) filter.action = actions.length === 1 ? actions[0] : { $in: actions }

  const userIds = options.userIds?.length ? options.userIds : options.userId ? [options.userId] : null
  if (userIds) filter.userId = userIds.length === 1 ? new Types.ObjectId(userIds[0]) : { $in: userIds.map(id => new Types.ObjectId(id)) }

  if (options.entityIds?.length) {
    // `entityId` is Mixed: an id is stored as an ObjectId, a sequence prefix as its string
    // (`idOrString`). Casting every value, as this did, threw on a prefix.
    filter.entityId = { $in: options.entityIds.flatMap(id => [idOrString(id), String(id)]) }
  }

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
  const desktops = await viaDesktops(orgId, docs)

  const logs = docs.map((d: any) => ({
    _id: String(d._id),
    userId: d.userId?._id ? String(d.userId._id) : String(d.userId),
    userName: d.userId?.firstName
      ? `${d.userId.firstName} ${d.userId.lastName || ''}`.trim()
      : d.userId?.email || d.userId?.username || String(d.userId),
    operatorCode: d.operatorCode,
    action: d.action,
    module: d.module,
    entityType: d.entityType,
    entityId: String(d.entityId),
    entityName: d.entityName || '',
    unpNumber: d.unpNumber,
    correlationId: d.correlationId ? String(d.correlationId) : undefined,
    changes: d.changes || [],
    ipAddress: d.ipAddress,
    userAgent: d.userAgent,
    ...viaWire(d, desktops),
    timestamp: d.timestamp?.toISOString(),
  }))

  return { auditLogs: logs, total, page, size, totalPages: Math.ceil(total / size) }
}

/**
 * Get distinct values for filter dropdowns.
 */
export async function queryDistinctFilters(orgId: string) {
  const filter = { orgId: new Types.ObjectId(orgId) }
  const [modules, actions, entityTypes] = await Promise.all([
    AuditLog.distinct('module', filter).exec(),
    AuditLog.distinct('action', filter).exec(),
    AuditLog.distinct('entityType', filter).exec(),
  ])
  return { modules: modules.sort(), actions: actions.sort(), entityTypes: entityTypes.sort() }
}

/**
 * Search entities by type for autocomplete.
 */
export async function searchEntitiesByType(orgId: string, entityType: string, query: string, limit = 10) {
  const r = getRepos()
  const filter: any = { orgId }
  if (query) filter.name = { $regex: query, $options: 'i' }

  const config: Record<string, { repo: any; labelField: string; searchField: string }> = {
    product: { repo: r.products, labelField: 'name', searchField: 'name' },
    warehouse: { repo: r.warehouses, labelField: 'name', searchField: 'name' },
    invoice: { repo: r.invoices, labelField: 'invoiceNumber', searchField: 'invoiceNumber' },
    contact: { repo: r.contacts, labelField: 'companyName', searchField: 'companyName' },
    account: { repo: r.accounts, labelField: 'name', searchField: 'name' },
    employee: { repo: r.employees, labelField: 'firstName', searchField: 'firstName' },
    department: { repo: r.departments, labelField: 'name', searchField: 'name' },
    lead: { repo: r.leads, labelField: 'companyName', searchField: 'companyName' },
    deal: { repo: r.deals, labelField: 'name', searchField: 'name' },
    pipeline: { repo: r.pipelines, labelField: 'name', searchField: 'name' },
  }

  const cfg = config[entityType]
  if (!cfg) return []

  // Override search field for non-name entities
  if (query && cfg.searchField !== 'name') {
    delete filter.name
    filter[cfg.searchField] = { $regex: query, $options: 'i' }
  }

  try {
    const result = await cfg.repo.findAll(filter, { page: 0, size: limit, sort: { [cfg.labelField]: 1 } })
    return result.items.map((item: any) => ({
      id: item.id || item._id,
      label: item[cfg.labelField] || item.name || item.id,
    }))
  } catch {
    return []
  }
}

/**
 * Search users for autocomplete.
 */
export async function searchUsers(orgId: string, query: string, limit = 10) {
  const filter: any = { orgId: new Types.ObjectId(orgId) }
  if (query) {
    filter.$or = [
      { firstName: { $regex: query, $options: 'i' } },
      { lastName: { $regex: query, $options: 'i' } },
      { email: { $regex: query, $options: 'i' } },
      { username: { $regex: query, $options: 'i' } },
    ]
  }

  const docs = await User.find(filter).select('firstName lastName email username').limit(limit).lean().exec()
  return docs.map((d: any) => ({
    id: String(d._id),
    label: `${d.firstName || ''} ${d.lastName || ''}`.trim() || d.email || d.username,
  }))
}

/**
 * Generate a new correlation ID for grouping related audit entries.
 */
export function generateCorrelationId(): string {
  return new Types.ObjectId().toHexString()
}

/**
 * Query all audit entries sharing a correlation ID.
 */
export async function queryByCorrelationId(orgId: string, correlationId: string) {
  const docs = await AuditLog.find({
    orgId: new Types.ObjectId(orgId),
    correlationId: new Types.ObjectId(correlationId),
  })
    .sort({ timestamp: 1 })
    .populate('userId', 'firstName lastName email username')
    .lean()
    .exec()

  return docs.map((d: any) => ({
    _id: String(d._id),
    userId: d.userId?._id ? String(d.userId._id) : String(d.userId),
    userName: d.userId?.firstName
      ? `${d.userId.firstName} ${d.userId.lastName || ''}`.trim()
      : d.userId?.email || d.userId?.username || String(d.userId),
    action: d.action,
    module: d.module,
    entityType: d.entityType,
    entityId: String(d.entityId),
    entityName: d.entityName || '',
    correlationId: d.correlationId ? String(d.correlationId) : undefined,
    changes: d.changes || [],
    timestamp: d.timestamp?.toISOString(),
  }))
}
