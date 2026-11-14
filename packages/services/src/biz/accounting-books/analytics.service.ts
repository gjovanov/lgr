/**
 * FR-25a §3.2: the analytics of the books (`AccountingAnalytic`) for the screens that show them: a grid of the tree, an
 * analytic with its properties, and what a person may change on one of their own.
 *
 * ⚠ An analytic of an org that keeps a legal entity's books is the books' (`keepsBooks`): every one of them was written
 * by the import, and the next import would write over an edit, so a change to one is refused with `AS_BOOKED` (422).
 * Only an analytic of any other org is LGR's own. The analytic model has no origin field of its own, and needs none:
 * nothing but the import makes one in a books org.
 */
import { mongoose } from 'db/connection'
import { AccountingAnalytic, BankAccount, Contact, FixedAsset, JournalEntry, Org, POSTED_BOOKS } from 'db/models'
import { recordAuditEntry, diffChanges } from '../audit-log.service.js'
import { buildSearchFilter } from '../search.utils.js'
import { ANALYTIC_ROOTS, ancestorsOfPath } from './registry.js'
import {
  AS_BOOKED,
  analyticsMatch,
  analyticsSort,
  depthOf,
  keepsBooks,
  monthRange,
  normaliseParams,
  parseAnalyticsQuery,
  TREE_SEPARATOR,
  type AnalyticsQuery,
} from './analytics-query.js'

export class AnalyticsError extends Error {
  constructor(readonly statusCode: number, readonly code: string, message: string) {
    super(message)
    this.name = 'AnalyticsError'
  }
}

const oid = (v: unknown) => new mongoose.Types.ObjectId(String(v))
const str = (v: unknown) => (v === undefined || v === null ? undefined : String(v))

export interface AnalyticRow {
  _id: string
  path: string
  root: string
  name: string
  depth: number
  kind: string
  unit?: string
  parentId?: string
  contactId?: string
  contactName?: string
  bankAccountId?: string
  bankAccountName?: string
  fixedAssetId?: string
  fixedAssetName?: string
  isActive: boolean
  deactivatedAt?: Date
}

export interface AnalyticDetail extends AnalyticRow {
  params: { key: string; value: string }[]
  /** What is above it in the tree, the root first. */
  ancestors: { _id: string; path: string; name: string }[]
  createdAt?: Date
  updatedAt?: Date
}

export interface AnalyticRootCount {
  root: string
  kind?: string
  /** `reports.accountingBooks.roots.<labelKey>`; unset for a root the registry does not name. */
  labelKey?: string
  quantitative?: boolean
  partner?: boolean
  count: number
}

/** Whether the org's analytics are the books' (`keepsBooks`). */
export async function orgKeepsBooks(orgId: string): Promise<boolean> {
  const org: any = await Org.findById(orgId, { 'settings.accounting.books.mode': 1 }).lean()
  return keepsBooks(org)
}

const contactName = (c: any): string => c?.companyName || [c?.firstName, c?.lastName].filter(Boolean).join(' ') || c?.email || ''

/** The names of what a page of analytics links to, in one query per collection. */
async function linkedNames(orgId: string, rows: any[]) {
  const ids = (key: string) => [...new Set(rows.map(r => r[key]).filter(Boolean).map(String))].map(oid)
  const [contacts, banks, assets] = await Promise.all([
    ids('contactId').length ? Contact.find({ orgId, _id: { $in: ids('contactId') } }, { companyName: 1, firstName: 1, lastName: 1, email: 1 }).lean() : [],
    ids('bankAccountId').length ? BankAccount.find({ orgId, _id: { $in: ids('bankAccountId') } }, { name: 1 }).lean() : [],
    ids('fixedAssetId').length ? FixedAsset.find({ orgId, _id: { $in: ids('fixedAssetId') } }, { name: 1, code: 1 }).lean() : [],
  ])
  return {
    contacts: new Map((contacts as any[]).map(c => [String(c._id), contactName(c)])),
    banks: new Map((banks as any[]).map(b => [String(b._id), b.name as string])),
    assets: new Map((assets as any[]).map(a => [String(a._id), [a.code, a.name].filter(Boolean).join(' - ')])),
  }
}

function rowOf(a: any, names: Awaited<ReturnType<typeof linkedNames>>): AnalyticRow {
  const contactId = str(a.contactId)
  const bankAccountId = str(a.bankAccountId)
  const fixedAssetId = str(a.fixedAssetId)
  return {
    _id: String(a._id),
    path: a.path,
    root: a.root,
    name: a.name,
    depth: depthOf(a.path),
    kind: a.kind,
    ...(a.unit ? { unit: a.unit } : {}),
    ...(a.parentId ? { parentId: String(a.parentId) } : {}),
    // A link whose record is gone (another org's id, a deleted asset) still shows that it is there.
    ...(contactId ? { contactId, contactName: names.contacts.get(contactId) ?? '' } : {}),
    ...(bankAccountId ? { bankAccountId, bankAccountName: names.banks.get(bankAccountId) ?? '' } : {}),
    ...(fixedAssetId ? { fixedAssetId, fixedAssetName: names.assets.get(fixedAssetId) ?? '' } : {}),
    isActive: a.isActive !== false,
    ...(a.deactivatedAt ? { deactivatedAt: a.deactivatedAt } : {}),
  }
}

function matchOf(orgId: string, q: AnalyticsQuery): Record<string, unknown> {
  return {
    orgId: oid(orgId),
    ...analyticsMatch(q, oid),
    // `nameLower` mirrors the name in the `bg` locale (FR-25 §3.2): no case folding by the regex.
    ...(q.search ? buildSearchFilter(q.search, ['name'], { lowered: { name: 'nameLower' }, homoglyphs: true }) : {}),
  }
}

/** The rows of a query, in the tree's order (`analyticsSort`); `limit` 0 is every one. */
async function rowsOf(orgId: string, q: AnalyticsQuery, skip: number, limit: number): Promise<AnalyticRow[]> {
  const pipeline: any[] = [
    { $match: matchOf(orgId, q) },
    { $addFields: { treeKey: { $replaceAll: { input: '$path', find: ':', replacement: TREE_SEPARATOR } } } },
    { $sort: analyticsSort(q) },
    ...(skip ? [{ $skip: skip }] : []),
    ...(limit ? [{ $limit: limit }] : []),
    { $project: { params: 0, treeKey: 0 } },
  ]
  const rows = await AccountingAnalytic.aggregate(pipeline)
  const names = await linkedNames(orgId, rows)
  return rows.map(a => rowOf(a, names))
}

export async function listAnalytics(orgId: string, raw: Record<string, unknown>) {
  const q = parseAnalyticsQuery(raw)
  const [analytics, total, asBooked] = await Promise.all([
    rowsOf(orgId, q, q.size ? q.page * q.size : 0, q.size),
    AccountingAnalytic.countDocuments(matchOf(orgId, q)),
    orgKeepsBooks(orgId),
  ])
  return {
    analytics,
    total,
    page: q.size ? q.page : 0,
    size: q.size,
    totalPages: q.size ? Math.ceil(total / q.size) : 1,
    asBooked,
  }
}

/** Every row a query matches, up to `cap`, for the export; `truncated` when there were more. */
export async function analyticsForExport(orgId: string, raw: Record<string, unknown>, cap: number) {
  const q = { ...parseAnalyticsQuery(raw), page: 0, size: 0 }
  const rows = await rowsOf(orgId, q, 0, cap + 1)
  return { rows: rows.slice(0, cap), truncated: rows.length > cap }
}

/**
 * The roots of the org's tree with how many analytics each holds: the registry's first, in its order, with the word
 * for each (`reports.accountingBooks.roots.*`), then any other (a path with no `:` is a root of its own).
 */
export async function analyticRoots(orgId: string): Promise<{ roots: AnalyticRootCount[]; asBooked: boolean }> {
  const [counts, asBooked] = await Promise.all([
    AccountingAnalytic.aggregate([{ $match: { orgId: oid(orgId) } }, { $group: { _id: '$root', count: { $sum: 1 } } }]),
    orgKeepsBooks(orgId),
  ])
  const byRoot = new Map<string, number>(counts.map((c: any) => [String(c._id), c.count as number]))
  const known: AnalyticRootCount[] = ANALYTIC_ROOTS.filter(r => byRoot.has(r.root)).map(r => ({
    root: r.root,
    kind: r.kind,
    labelKey: r.labelKey,
    ...(r.quantitative ? { quantitative: true } : {}),
    ...(r.partner ? { partner: true } : {}),
    count: byRoot.get(r.root)!,
  }))
  const registry = new Set(ANALYTIC_ROOTS.map(r => r.root))
  const others = [...byRoot.keys()].filter(root => !registry.has(root)).sort().map(root => ({ root, count: byRoot.get(root)! }))
  return { roots: [...known, ...others], asBooked }
}

async function findOwn(orgId: string, id: string): Promise<any> {
  if (!mongoose.isValidObjectId(id)) throw new AnalyticsError(404, 'not_found', 'Analytic not found')
  const analytic: any = await AccountingAnalytic.findOne({ _id: oid(id), orgId: oid(orgId) }).lean()
  if (!analytic) throw new AnalyticsError(404, 'not_found', 'Analytic not found')
  return analytic
}

async function detailOf(orgId: string, a: any): Promise<AnalyticDetail> {
  const [names, above] = await Promise.all([
    linkedNames(orgId, [a]),
    AccountingAnalytic.find({ orgId, path: { $in: ancestorsOfPath(a.path) } }, { path: 1, name: 1 }).lean(),
  ])
  return {
    ...rowOf(a, names),
    params: (a.params ?? []).map((p: any) => ({ key: p.key, value: p.value ?? '' })),
    ancestors: (above as any[])
      .sort((x, y) => depthOf(x.path) - depthOf(y.path))
      .map(x => ({ _id: String(x._id), path: x.path, name: x.name })),
    ...(a.createdAt ? { createdAt: a.createdAt } : {}),
    ...(a.updatedAt ? { updatedAt: a.updatedAt } : {}),
  }
}

export async function getAnalytic(orgId: string, id: string): Promise<{ analytic: AnalyticDetail; asBooked: boolean }> {
  const [analytic, asBooked] = await Promise.all([findOwn(orgId, id), orgKeepsBooks(orgId)])
  return { analytic: await detailOf(orgId, analytic), asBooked }
}

export interface AnalyticChange {
  /** null (or '') unlinks. */
  contactId?: string | null
  bankAccountId?: string | null
  fixedAssetId?: string | null
  params?: { key: string; value?: string }[]
  isActive?: boolean
}

export interface AnalyticEditor {
  id: string
  operatorCode?: string
}

const LINKS = [
  { key: 'contactId', model: Contact, code: 'contact_not_found', what: 'contact' },
  { key: 'bankAccountId', model: BankAccount, code: 'bank_account_not_found', what: 'bank account' },
  { key: 'fixedAssetId', model: FixedAsset, code: 'fixed_asset_not_found', what: 'fixed asset' },
] as const

const AUDITED = ['contactId', 'bankAccountId', 'fixedAssetId', 'params', 'isActive', 'deactivatedAt']

/**
 * A change to an analytic of LGR's own: what it links to, its properties, whether it is offered. An analytic of the
 * books is refused whole (`AS_BOOKED`): nothing of it is LGR's to change.
 */
export async function updateAnalytic(orgId: string, id: string, change: AnalyticChange, by: AnalyticEditor): Promise<{ analytic: AnalyticDetail }> {
  const before = await findOwn(orgId, id)
  if (await orgKeepsBooks(orgId)) {
    throw new AnalyticsError(422, AS_BOOKED, "This analytic is as booked in the accountant's program: the import keeps it, and it is not changed here.")
  }

  const $set: Record<string, unknown> = {}
  const $unset: Record<string, ''> = {}
  for (const link of LINKS) {
    const value = change[link.key]
    if (value === undefined) continue
    if (value === null || value === '') {
      $unset[link.key] = ''
      continue
    }
    const found = mongoose.isValidObjectId(value) && await (link.model as any).exists({ _id: oid(value), orgId: oid(orgId) })
    if (!found) throw new AnalyticsError(422, link.code, `No such ${link.what} in this organisation.`)
    $set[link.key] = oid(value)
  }

  if (change.params !== undefined) {
    const kept = normaliseParams(change.params)
    if ('refusal' in kept) throw new AnalyticsError(422, kept.refusal, 'Each property needs a name of its own.')
    // None left is none: the field is unset, as on an analytic that never had any.
    if (kept.params.length) $set.params = kept.params
    else $unset.params = ''
  }

  if (change.isActive === true && before.isActive === false) {
    $set.isActive = true
    $unset.deactivatedAt = ''
  }
  if (change.isActive === false && before.isActive !== false) {
    $set.isActive = false
    $set.deactivatedAt = new Date()
  }

  if (!Object.keys($set).length && !Object.keys($unset).length) return { analytic: await detailOf(orgId, before) }

  const after: any = await AccountingAnalytic.findOneAndUpdate(
    { _id: before._id, orgId: oid(orgId) },
    { ...(Object.keys($set).length ? { $set } : {}), ...(Object.keys($unset).length ? { $unset } : {}) },
    { new: true },
  ).lean()
  if (!after) throw new AnalyticsError(404, 'not_found', 'Analytic not found')

  const deactivated = change.isActive === false && before.isActive !== false
  await recordAuditEntry({
    orgId,
    userId: by.id,
    operatorCode: by.operatorCode,
    action: deactivated ? 'deactivate' : 'update',
    module: 'accounting',
    entityType: 'accounting_analytic',
    entityId: String(before._id),
    entityName: before.path,
    changes: diffChanges(before, after, AUDITED),
  })
  return { analytic: await detailOf(orgId, after) }
}

/** No longer offered: kept, with every line that names it. Never a delete. */
export function deactivateAnalytic(orgId: string, id: string, by: AnalyticEditor) {
  return updateAnalytic(orgId, id, { isActive: false }, by)
}

/**
 * How many bank documents (entries with a `bankOperation`) touched each bank account in a month, through the analytic
 * of the account (`БАНКОВИ СМЕТКИ:<iban>`, linked by the import). An entry on two analytics of one account counts once.
 * An org with no analytic linked to a bank account answers no counts, and reads no entry.
 */
export async function bankOperationCounts(orgId: string, month: string): Promise<{ month: string; counts: Record<string, number> }> {
  const range = monthRange(month)
  if (!range) throw new AnalyticsError(422, 'invalid_month', 'A month is YYYY-MM.')
  const linked: any[] = await AccountingAnalytic.find({ orgId, bankAccountId: { $ne: null } }, { bankAccountId: 1 }).lean()
  if (!linked.length) return { month, counts: {} }

  const bankOf = new Map(linked.map(a => [String(a._id), String(a.bankAccountId)]))
  const entries: any[] = await JournalEntry.find({
    orgId,
    ...POSTED_BOOKS,
    'lines.analyticId': { $in: linked.map(a => a._id) },
    date: { $gte: range.from, $lt: range.to },
    bankOperation: { $nin: [null, ''] },
  }, { 'lines.analyticId': 1 }).lean()

  const counts: Record<string, number> = {}
  for (const entry of entries) {
    const banks = new Set((entry.lines ?? []).map((l: any) => bankOf.get(String(l.analyticId))).filter(Boolean) as string[])
    for (const bank of banks) counts[bank] = (counts[bank] ?? 0) + 1
  }
  return { month, counts }
}
