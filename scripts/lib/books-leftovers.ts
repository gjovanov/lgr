/**
 * What the GUI export's damage left behind in a books org (FR-25 §9), and its deactivation.
 *
 * The GUI export breaks some Cyrillic letters into U+FFFD. The first R1 import booked those spellings,
 * so it created analytics, and a contact for each partner among them, under names the database does not
 * hold. The re-import from the archive (E6) moved every line onto the real names and left these behind,
 * empty. The archive holds no U+FFFD at all (checked 2026-11-05), so a name with one is the export's.
 *
 * Planned for deactivation, the soft delete every nomenclature model uses:
 * - an active analytic whose path holds U+FFFD, when no document of any model points at it and no active
 *   analytic under it stays;
 * - an active contact whose name holds U+FFFD and that has no ЕИК or VAT number, when nothing points at it
 *   but analytics planned with it. ⚠ A contact with a number is never planned: the import keys a partner
 *   by that number, so the real name's analytics may well point at it.
 *
 * "Points at" is read off the schemas: every path of every registered model whose `ref` names the model,
 * nested schemas included. A model that starts pointing at analytics or contacts is covered without an
 * edit here.
 */
import type { Schema } from 'mongoose'
import { mongoose } from '../../packages/db/src/connection.js'
import { AccountingAnalytic, Contact } from '../../packages/db/src/models/index.js'
import { recordAuditEntry } from '../../packages/services/src/biz/audit-log.service.js'

export const BROKEN = '�'

const NAME_FIELDS = ['companyName', 'firstName', 'lastName'] as const

export interface LeftoverAnalytic { id: string; path: string; root: string }
export interface LeftoverContact { id: string; name: string; was: Partial<Record<(typeof NAME_FIELDS)[number], string>> }
export interface LeftoverPlan {
  orgId: string
  analytics: LeftoverAnalytic[]
  contacts: LeftoverContact[]
  counts: Record<string, number>
}

const oid = (id: unknown) => new mongoose.Types.ObjectId(String(id))
const isBroken = (s: unknown) => typeof s === 'string' && s.includes(BROKEN)
const empty = (field: string) => ({ $or: [{ [field]: { $exists: false } }, { [field]: null }, { [field]: '' }] })
/** The analytics tree's own pointers: a child names its parent, a partner's analytic its contact. */
const ownTree = (model: string, path: string) => model === 'AccountingAnalytic' && (path === 'parentId' || path === 'contactId')

function refPathsOf(schema: Schema, target: string, prefix = '', above: Schema[] = []): string[] {
  // Only a schema that holds itself can recurse; one used in two places is walked in both.
  if (above.includes(schema)) return []
  const out: string[] = []
  schema.eachPath((path, type: any) => {
    const full = `${prefix}${path}`
    // An ObjectId names its ref in its options; an array of them in its caster's.
    const ref = type.options?.ref ?? type.caster?.options?.ref ?? type.embeddedSchemaType?.options?.ref
    if ((typeof ref === 'string' ? ref : ref?.modelName) === target) out.push(full)
    if (type.schema) out.push(...refPathsOf(type.schema, target, `${full}.`, [...above, schema]))
  })
  return out
}

/** Every `{ model, path }` whose schema says `ref: <target>`, subdocuments and arrays included. */
export function referencePaths(target: string): { model: string; path: string }[] {
  return mongoose.modelNames().flatMap(model => refPathsOf(mongoose.model(model).schema, target).map(path => ({ model, path })))
}

/**
 * For each of `ids` that something points at, what does: `Model.path` names. Documents of every status
 * count, voided ones included: a voided document still names what it voided.
 */
export async function pointersTo(
  target: string,
  orgId: unknown,
  ids: readonly unknown[],
  skip: (model: string, path: string) => boolean = () => false,
): Promise<Map<string, string[]>> {
  const held = new Map<string, string[]>()
  if (!ids.length) return held
  const wanted = new Set(ids.map(String))
  for (const { model, path } of referencePaths(target)) {
    if (skip(model, path)) continue
    const M = mongoose.model(model)
    const scope = M.schema.path('orgId') ? { orgId: oid(orgId) } : {}
    // `distinct` over an array answers every element of a matching document, the others too.
    const found: unknown[] = await M.distinct(path, { ...scope, [path]: { $in: [...wanted].map(oid) } }).exec()
    for (const id of found.map(String)) {
      if (wanted.has(id)) held.set(id, [...(held.get(id) ?? []), `${model}.${path}`])
    }
  }
  return held
}

const add = (map: Map<string, string[]>, id: unknown, by: string) => map.set(String(id), [...(map.get(String(id)) ?? []), by])

export async function planBooksLeftovers(orgId: unknown): Promise<LeftoverPlan> {
  const counts: Record<string, number> = {}
  const bump = (key: string, n = 1) => { if (n) counts[key] = (counts[key] ?? 0) + n }

  const active: any[] = await AccountingAnalytic.find({ orgId: oid(orgId), isActive: { $ne: false } }, { path: 1, root: 1, parentId: 1, contactId: 1 }).lean().exec()
  const broken = active.filter(a => isBroken(a.path))
  const brokenIds = new Set(broken.map(a => String(a._id)))
  bump('analytics with U+FFFD in the path', broken.length)

  const direct = await pointersTo('AccountingAnalytic', orgId, [...brokenIds], ownTree)
  const children = new Map<string, string[]>()
  for (const a of active) if (a.parentId) add(children, a.parentId, String(a._id))
  // A parent stays while anything under it stays, or while it has a child that is not broken.
  const stays = new Set(direct.keys())
  for (let grew = true; grew;) {
    grew = false
    for (const id of brokenIds) {
      if (stays.has(id)) continue
      if ((children.get(id) ?? []).some(c => !brokenIds.has(c) || stays.has(c))) { stays.add(id); grew = true }
    }
  }
  bump('left: a document points at the analytic', direct.size)
  bump('left: an analytic under it stays', stays.size - direct.size)
  const analytics: LeftoverAnalytic[] = broken
    .filter(a => !stays.has(String(a._id)))
    .map(a => ({ id: String(a._id), path: a.path, root: a.root }))
  bump('analytics to deactivate', analytics.length)

  const people: any[] = await Contact.find({ orgId: oid(orgId), isActive: { $ne: false } }, { ...Object.fromEntries(NAME_FIELDS.map(f => [f, 1])), taxId: 1, vatNumber: 1 }).lean().exec()
  const named = people.filter(c => NAME_FIELDS.some(f => isBroken(c[f])))
  bump('contacts with U+FFFD in the name', named.length)
  const bare = named.filter(c => !c.taxId && !c.vatNumber)
  bump('left: the contact has an ЕИК or VAT number', named.length - bare.length)

  // An analytic planned here does not hold its contact; any other active analytic, or any document, does.
  const goes = new Set(analytics.map(a => a.id))
  const held = await pointersTo('Contact', orgId, bare.map(c => c._id), ownTree)
  const partners: any[] = await AccountingAnalytic.find({ orgId: oid(orgId), contactId: { $in: bare.map(c => c._id) }, isActive: { $ne: false } }, { contactId: 1 }).lean().exec()
  for (const a of partners) if (!goes.has(String(a._id))) add(held, a.contactId, 'AccountingAnalytic.contactId')
  bump('left: something else points at the contact', held.size)
  const contacts: LeftoverContact[] = bare
    .filter(c => !held.has(String(c._id)))
    .map(c => ({
      id: String(c._id),
      name: c.companyName || [c.firstName, c.lastName].filter(Boolean).join(' '),
      was: Object.fromEntries(NAME_FIELDS.filter(f => c[f] != null).map(f => [f, c[f]])),
    }))
  bump('contacts to deactivate', contacts.length)

  return { orgId: String(orgId), analytics, contacts, counts }
}

export interface LeftoverResult { analytics: number; contacts: number; failed: string[] }

/**
 * Deactivate what the plan names, each row only while it still reads as the plan read it, with one audit
 * row per row under `by`. A failed audit row stops the run: a correction of master data is not done until
 * its audit row is.
 */
export async function applyBooksLeftovers(plan: LeftoverPlan, by: unknown, reason: string): Promise<LeftoverResult> {
  const result: LeftoverResult = { analytics: 0, contacts: 0, failed: [] }
  const orgId = oid(plan.orgId)
  const off = { $set: { isActive: false, deactivatedAt: new Date() } }
  const audit = (entityType: string, module: string, id: string, entityName: string) => recordAuditEntry({
    orgId: plan.orgId, userId: String(by), action: 'deactivate', module, entityType, entityId: id, entityName,
    changes: [{ field: 'isActive', oldValue: true, newValue: false }, { field: 'reason', oldValue: null, newValue: reason }],
  })

  for (const a of plan.analytics) {
    const res = await AccountingAnalytic.updateOne({ _id: oid(a.id), orgId, path: a.path, isActive: { $ne: false } }, off).exec()
    if (res.modifiedCount !== 1) { result.failed.push(`analytic ${a.id}: changed since the plan, left alone`); continue }
    if (!await audit('accounting_analytic', 'accounting', a.id, a.path)) throw new Error(`the audit row for analytic ${a.id} was not written; the change itself was`)
    result.analytics++
  }
  for (const c of plan.contacts) {
    const asRead = NAME_FIELDS.map(f => (c.was[f] != null ? { [f]: c.was[f] } : empty(f)))
    const res = await Contact.updateOne({ _id: oid(c.id), orgId, isActive: { $ne: false }, $and: [...asRead, empty('taxId'), empty('vatNumber')] }, off).exec()
    if (res.modifiedCount !== 1) { result.failed.push(`contact ${c.id}: changed since the plan, left alone`); continue }
    if (!await audit('contact', 'invoicing', c.id, c.name)) throw new Error(`the audit row for contact ${c.id} was not written; the change itself was`)
    result.contacts++
  }
  return result
}

/**
 * What points at the plan's rows from outside it: a run must find nothing once it has written. Within the
 * plan, a deactivated child still names its deactivated parent, and that is fine.
 */
export async function pointersFromOutside(plan: LeftoverPlan): Promise<string[]> {
  const out: string[] = []
  const tree = { orgId: oid(plan.orgId), isActive: { $ne: false } }
  for (const [id, by] of await pointersTo('AccountingAnalytic', plan.orgId, plan.analytics.map(r => r.id), ownTree)) out.push(`analytic ${id}: ${by.join(', ')}`)
  for (const a of await AccountingAnalytic.find({ ...tree, parentId: { $in: plan.analytics.map(r => oid(r.id)) } }, { parentId: 1 }).lean().exec() as any[]) {
    out.push(`analytic ${a.parentId}: an active analytic under it`)
  }
  for (const [id, by] of await pointersTo('Contact', plan.orgId, plan.contacts.map(r => r.id), ownTree)) out.push(`contact ${id}: ${by.join(', ')}`)
  for (const a of await AccountingAnalytic.find({ ...tree, contactId: { $in: plan.contacts.map(r => oid(r.id)) } }, { contactId: 1 }).lean().exec() as any[]) {
    out.push(`contact ${a.contactId}: an active analytic`)
  }
  return out
}
