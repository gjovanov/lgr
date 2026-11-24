import { nodeRole } from 'config'
import {
  Account, AuditLog, Contact, Desktop, Employee, GlobalAuditEntry, InternalOrder, Invoice, JournalEntry, Order, POSSession, Product, Reservation,
  StockMovement, User, Warehouse,
} from 'db/models'
import { mongoose } from 'db/connection'
import { HomeElsewhereError } from 'db/home/home'
import { currentRequest } from 'db/home/request-context'
import { logger } from '../logger/logger.js'
import { buildSearchFilter } from './search.utils.js'
import { capsOfSortKey, seesCosts, seesEveryPrice, seesLevel, type Grant } from 'config/access'

/** Records whose `lines` carry a cost (`unitCost`, `varianceCost`, an order's expected price). */
const COST_LINE_ENTITIES = new Set(['stock_movement', 'inventory_count', 'order', 'StockMovement', 'InventoryCount', 'Order'])

/**
 * FR-27.11.C.5 (#529): what changed is itself a figure. For a caller whose role does not see a price level or the cost
 * figures, a change of such a field is dropped from an entry (its field named as a sort key is: `purchasePrice`,
 * `priceTiers`, `sellingPrice`…, and a movement's, a count's or an order's `lines` without the costs). No grant: the
 * system's own reader (the digest), which sees everything.
 */
export function visibleChanges<C extends { field: string }>(grant: Grant | null | undefined, entityType: string | undefined, changes: readonly C[] | null | undefined): C[] {
  const list = Array.isArray(changes) ? [...changes] : []
  if (!grant || seesEveryPrice(grant)) return list
  return list.filter(c => {
    if (c?.field === 'lines' && COST_LINE_ENTITIES.has(String(entityType)) && !seesCosts(grant)) return false
    return capsOfSortKey(c?.field).every(cap => seesLevel(grant, cap))
  })
}
const { Types } = mongoose

const SENSITIVE_FIELDS = new Set(['password', 'token', 'secret', 'apiKey', 'creditCard', 'oauthProviders'])

/** One changed field, as an entry stores it. */
export interface AuditChange { field: string; oldValue: unknown; newValue: unknown }

/**
 * FR-29.19: what changed, as a caller may say it: the stored array, or a map of the fields it names to their old and
 * new values (`{ invoiceNumber: { from, to } }`). Both are stored as the array. Any other shape does not compile.
 */
export type AuditChanges = AuditChange[] | Record<string, { from?: unknown; to?: unknown }>

/**
 * FR-29.20: who made the entry when it is not a person: the system, naming the job or the event that wrote it
 * (`invoice.posted`, `backup`). The audit page shows "System".
 */
export interface AuditActor { kind: 'system'; name: string }

/** The system as the actor of an entry, named by its job or event. */
export const systemActor = (name: string): AuditActor => ({ kind: 'system', name })

export interface AuditEntry {
  orgId: string
  /** The person who acted. Absent for the system (`actor`) and a sys-admin script (`via: 'scripts/…'`). */
  userId?: string
  actor?: AuditActor
  operatorCode?: string
  action: string
  module: string
  entityType: string
  entityId: string
  entityName?: string
  unpNumber?: string
  correlationId?: string
  changes?: AuditChanges
  ipAddress?: string
  userAgent?: string
  /** FR-20.48: where it came from, when the request context cannot say (a socket's own event). */
  via?: string
}

/** FR-29.19: the changes as an entry stores them, whichever shape the caller used. */
export function changesOf(changes: AuditChanges | undefined): AuditChange[] | undefined {
  if (!changes) return undefined
  if (Array.isArray(changes)) return changes
  return Object.entries(changes).map(([field, c]) => ({ field, oldValue: c?.from ?? null, newValue: c?.to ?? null }))
}

/**
 * FR-29.21: audit writes that failed since this process started, and the entries global kept for itself about an org
 * whose home is elsewhere (`GlobalAuditEntry`), for health.
 */
const failures = { count: 0, lastAt: undefined as Date | undefined }
const keptHere = { count: 0, lastAt: undefined as Date | undefined }
export function auditHealth(): { writeFailures: number; lastFailureAt?: Date; keptOnGlobal: number; lastKeptAt?: Date } {
  return {
    writeFailures: failures.count,
    ...(failures.lastAt ? { lastFailureAt: failures.lastAt } : {}),
    keptOnGlobal: keptHere.count,
    ...(keptHere.lastAt ? { lastKeptAt: keptHere.lastAt } : {}),
  }
}

/**
 * FR-29.21 (D-6): a failed audit write is loud, and the action it belongs to still succeeds. Logged at error level with
 * what was being recorded (never its values) and counted for health.
 */
function auditWriteFailed(entry: AuditEntry, err: unknown): void {
  failures.count++
  failures.lastAt = new Date()
  logger.error(
    { module: entry.module, action: entry.action, entityType: entry.entityType, entityId: String(entry.entityId ?? ''), error: err instanceof Error ? err.message : String(err) },
    'Audit log write failed',
  )
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
  /** FR-27.11.C.5: the caller's grant; changes of a figure it does not see are dropped. Absent: every change. */
  viewer?: Grant | null
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
 * On global, an entry about an org whose home is elsewhere is kept there (`GlobalAuditEntry`).
 */
export function createAuditEntry(entry: AuditEntry): void {
  void writeEntry(entry, true)
}

/**
 * `createAuditEntry`, awaited: for an entry that must be written before what follows changes the
 * org's home (FR-20.79's freeze), after which this node refuses the org's writes. Never throws either.
 *
 * True when the org's trail has the entry. ⚠ An entry global keeps for itself is not in the org's trail, so it is
 * written only when the caller asks (`keepOnGlobal`, then true too): a caller that refuses to go on without the trail
 * (a payroll reveal: no entry, no file) stays refused where the org is not home.
 */
export async function recordAuditEntry(entry: AuditEntry, opts: { keepOnGlobal?: boolean } = {}): Promise<boolean> {
  return (await writeEntry(entry, opts.keepOnGlobal === true)) !== 'failed'
}

/** The write guard's refusal of an org whose home is not here, as global meets it. */
function refusedOnGlobal(err: unknown): err is HomeElsewhereError {
  if (nodeRole() !== 'global' || typeof err !== 'object' || err === null) return false
  return err instanceof HomeElsewhereError || ((err as { code?: unknown }).code === 'org_home_elsewhere' && 'info' in err)
}

/**
 * The entry into the org's trail, or, on global and only when the write guard refused it there because the org's home
 * is elsewhere, into global's own (`GlobalAuditEntry`) when `keep` allows. Never throws.
 */
async function writeEntry(entry: AuditEntry, keep: boolean): Promise<'trail' | 'kept' | 'failed'> {
  let doc: ReturnType<typeof auditDoc> | undefined
  try {
    doc = auditDoc(entry)
    await AuditLog.create(doc)
    return 'trail'
  } catch (err) {
    if (!(doc && keep && refusedOnGlobal(err))) {
      auditWriteFailed(entry, err)
      return 'failed'
    }
    try {
      await GlobalAuditEntry.create({ ...doc, home: err.info.home, homeState: err.info.state, homeEpoch: err.info.epoch })
    } catch (keptErr) {
      auditWriteFailed(entry, keptErr)
      return 'failed'
    }
    keptHere.count++
    keptHere.lastAt = new Date()
    return 'kept'
  }
}

function auditDoc(entry: AuditEntry) {
  // FR-29.20: `userId: 'system'` is how the handlers used to say it, and the cast threw, so the entry was never written.
  const actor = entry.actor ?? (entry.userId === 'system' ? systemActor(entry.action) : undefined)
  return {
    orgId: new Types.ObjectId(entry.orgId),
    // A script's entry has no person (`via: 'scripts/…'`), nor does the system's: an empty id is no id, never a cast
    // that throws.
    userId: entry.userId && !actor ? new Types.ObjectId(entry.userId) : undefined,
    ...(actor ? { actor } : {}),
    operatorCode: entry.operatorCode,
    action: entry.action,
    module: entry.module,
    entityType: entry.entityType,
    entityId: idOrString(entry.entityId),
    entityName: entry.entityName,
    unpNumber: entry.unpNumber,
    correlationId: entry.correlationId ? idOrString(entry.correlationId) : undefined,
    changes: changesOf(entry.changes),
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

/** Who an entry names: the person, or "System" for the system's own (FR-29.20), or the script that wrote it. */
function actorNameOf(d: any): string {
  if (d.actor?.kind === 'system') return 'System'
  return d.userId?.firstName
    ? `${d.userId.firstName} ${d.userId.lastName || ''}`.trim()
    : d.userId?.email || d.userId?.username || (d.userId ? String(d.userId) : String(d.via ?? ''))
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

const AUTHOR_FIELDS = 'firstName lastName email username'

/** Newest first, the later id first within one millisecond. */
const newestFirst = (a: any, b: any) => (new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()) || (String(b._id) > String(a._id) ? 1 : -1)

/**
 * A page of entries, newest first: the org's trail, and on global also the entries global kept for itself while the
 * org's home was elsewhere (`GlobalAuditEntry`), merged by time. An org without such entries reads its trail alone,
 * as it always did. With them, each side is read up to the end of the page (`limit(0)` reads all, as `size` 0 does).
 */
async function auditPage(filter: Record<string, any>, skip: number, size: number): Promise<{ docs: any[]; total: number }> {
  const kept = nodeRole() === 'global' ? await GlobalAuditEntry.countDocuments(filter).exec() : 0
  if (!kept) {
    const [docs, total] = await Promise.all([
      AuditLog.find(filter).sort({ timestamp: -1 }).skip(skip).limit(size).populate('userId', AUTHOR_FIELDS).lean().exec(),
      AuditLog.countDocuments(filter).exec(),
    ])
    return { docs, total }
  }
  const upTo = size > 0 ? skip + size : 0
  const [trail, ours, total] = await Promise.all([
    AuditLog.find(filter).sort({ timestamp: -1 }).limit(upTo).populate('userId', AUTHOR_FIELDS).lean().exec(),
    GlobalAuditEntry.find(filter).sort({ timestamp: -1 }).limit(upTo).populate('userId', AUTHOR_FIELDS).lean().exec(),
    AuditLog.countDocuments(filter).exec(),
  ])
  const merged = [...trail, ...ours].sort(newestFirst)
  return { docs: size > 0 ? merged.slice(skip, skip + size) : merged.slice(skip), total: total + kept }
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

  const { docs, total } = await auditPage(filter, skip, size)
  const desktops = await viaDesktops(orgId, docs)

  const logs = docs.map((d: any) => ({
    _id: String(d._id),
    userId: d.userId?._id ? String(d.userId._id) : d.userId ? String(d.userId) : null,
    userName: actorNameOf(d),
    // FR-29.20: the system's entry, and the job or event that wrote it; the page shows "System".
    ...(d.actor?.kind === 'system' ? { system: true, systemName: d.actor.name } : {}),
    operatorCode: d.operatorCode,
    action: d.action,
    module: d.module,
    entityType: d.entityType,
    entityId: String(d.entityId),
    entityName: d.entityName || '',
    unpNumber: d.unpNumber,
    correlationId: d.correlationId ? String(d.correlationId) : undefined,
    changes: visibleChanges(options.viewer, d.entityType, d.changes),
    ipAddress: d.ipAddress,
    userAgent: d.userAgent,
    ...viaWire(d, desktops),
    timestamp: d.timestamp?.toISOString(),
  }))

  return { auditLogs: logs, total, page, size, totalPages: Math.ceil(total / size) }
}

/** A field's values in the org's trail, and on global in the entries it kept for itself (`GlobalAuditEntry`). */
async function distinctOfBoth(field: 'module' | 'action' | 'entityType', filter: Record<string, unknown>): Promise<string[]> {
  const [trail, ours] = await Promise.all([
    AuditLog.distinct(field, filter).exec(),
    nodeRole() === 'global' ? GlobalAuditEntry.distinct(field, filter).exec() : Promise.resolve([]),
  ])
  return [...new Set([...trail, ...ours].map(String))]
}

/**
 * Get distinct values for filter dropdowns.
 */
export async function queryDistinctFilters(orgId: string) {
  const filter = { orgId: new Types.ObjectId(orgId) }
  const [modules, actions, entityTypes] = await Promise.all([
    distinctOfBoth('module', filter),
    distinctOfBoth('action', filter),
    distinctOfBoth('entityType', filter),
  ])
  // FR-29.22: the types the entity search can search; the page offers the search for those only.
  return { modules: modules.sort(), actions: actions.sort(), entityTypes: entityTypes.sort(), searchableEntityTypes: [...SEARCHABLE_ENTITY_TYPES] }
}

/**
 * FR-29.22: the entity types the audit page can search, each by the fields its documents are known by. A type not here
 * is not offered (`/audit-logs/filters` answers `searchableEntityTypes`): the four the search used to offer without a
 * repository behind them (department, lead, deal, pipeline) returned nothing.
 */
const ENTITY_SEARCH: Record<string, { model: () => any; label: string; fields: string[]; lowered?: Record<string, string> }> = {
  product: { model: () => Product, label: 'name', fields: ['name', 'sku'], lowered: { name: 'nameLower', sku: 'skuLower' } },
  warehouse: { model: () => Warehouse, label: 'name', fields: ['name', 'code'], lowered: { name: 'nameLower', code: 'codeLower' } },
  contact: {
    model: () => Contact, label: 'companyName', fields: ['companyName', 'firstName', 'lastName'],
    lowered: { companyName: 'companyNameLower', firstName: 'firstNameLower', lastName: 'lastNameLower' },
  },
  invoice: { model: () => Invoice, label: 'invoiceNumber', fields: ['invoiceNumber'] },
  account: { model: () => Account, label: 'name', fields: ['code', 'name'] },
  employee: { model: () => Employee, label: 'firstName', fields: ['firstName', 'lastName'] },
  stock_movement: { model: () => StockMovement, label: 'movementNumber', fields: ['movementNumber'] },
  journal_entry: { model: () => JournalEntry, label: 'entryNumber', fields: ['entryNumber'] },
  order: { model: () => Order, label: 'orderNumber', fields: ['orderNumber'] },
  internal_order: { model: () => InternalOrder, label: 'orderNumber', fields: ['orderNumber'] },
  reservation: { model: () => Reservation, label: 'reservationNumber', fields: ['reservationNumber'] },
  pos_session: { model: () => POSSession, label: 'sessionNumber', fields: ['sessionNumber'] },
}

/** FR-29.22: the entity types `searchEntitiesByType` searches. */
export const SEARCHABLE_ENTITY_TYPES: readonly string[] = Object.keys(ENTITY_SEARCH)

/**
 * Search entities by type for autocomplete. The keyword goes through `buildSearchFilter`, as every other search does:
 * escaped, so a keyword of pattern characters finds the rows that contain those characters and nothing else.
 */
export async function searchEntitiesByType(orgId: string, entityType: string, query: string, limit = 10) {
  const cfg = ENTITY_SEARCH[entityType]
  if (!cfg) return []
  const filter = { orgId: new Types.ObjectId(orgId), ...(query ? buildSearchFilter(query, cfg.fields, cfg.lowered ? { lowered: cfg.lowered } : undefined) : {}) }
  const rows: any[] = await cfg.model().find(filter, { [cfg.label]: 1 }).sort({ [cfg.label]: 1 }).limit(limit).lean().exec()
  return rows.map(r => ({ id: String(r._id), label: String(r[cfg.label] ?? r._id) }))
}

/**
 * Search users for autocomplete.
 */
export async function searchUsers(orgId: string, query: string, limit = 10) {
  // FR-29.22: the keyword escaped by the shared builder, as every other search.
  const filter = { orgId: new Types.ObjectId(orgId), ...(query ? buildSearchFilter(query, ['firstName', 'lastName', 'email', 'username']) : {}) }

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
export async function queryByCorrelationId(orgId: string, correlationId: string, viewer?: Grant | null) {
  const filter = { orgId: new Types.ObjectId(orgId), correlationId: new Types.ObjectId(correlationId) }
  const [trail, ours] = await Promise.all([
    AuditLog.find(filter).sort({ timestamp: 1 }).populate('userId', AUTHOR_FIELDS).lean().exec(),
    // On global, with the entries it kept for itself while the org's home was elsewhere.
    nodeRole() === 'global' ? GlobalAuditEntry.find(filter).sort({ timestamp: 1 }).populate('userId', AUTHOR_FIELDS).lean().exec() : Promise.resolve([]),
  ])
  const docs: any[] = [...trail, ...ours].sort((a, b) => newestFirst(b, a))

  return docs.map((d: any) => ({
    _id: String(d._id),
    userId: d.userId?._id ? String(d.userId._id) : d.userId ? String(d.userId) : null,
    userName: actorNameOf(d),
    // FR-29.20: the system's entry, and the job or event that wrote it; the page shows "System".
    ...(d.actor?.kind === 'system' ? { system: true, systemName: d.actor.name } : {}),
    action: d.action,
    module: d.module,
    entityType: d.entityType,
    entityId: String(d.entityId),
    entityName: d.entityName || '',
    correlationId: d.correlationId ? String(d.correlationId) : undefined,
    changes: visibleChanges(viewer, d.entityType, d.changes),
    timestamp: d.timestamp?.toISOString(),
  }))
}
