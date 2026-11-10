import type { Schema } from 'mongoose'
import { currentRequest } from '../home/request-context.js'

/**
 * Every reference a document holds names a record of the document's own organization.
 *
 * A body names records by id (`contactId`, `lines[].productId`, `accountId`…). The tenant guard
 * checks the org in the URL and `findByIdInOrg` the document in the URL (S-25); the ids INSIDE a
 * body are checked here. A per-route check would have to be written for every route that takes an
 * id (about ninety) and remembered for every new one, so the rule lives where the writes are, like
 * the home guard: installed by `tenantPlugin` on every org-scoped model. The views that resolve a
 * stored id (a list's contact names, an invoice's contact) also filter by the org, so neither side
 * relies on the other alone.
 *
 * Which fields are references comes from the schema (`ref: 'Contact'`), and only references to
 * org-scoped models count. A new document is checked whole, a saved one only in the paths the save
 * changes, an update in the paths it sets (`$set`, `$setOnInsert`, `$push`, `$addToSet`, plain
 * fields).
 *
 * ⚠ Refused: an id that IS a record of another org. Allowed: an id that is no record at all.
 * Old documents keep references to deleted records and must still save, and a transaction may
 * name a record it created a moment ago, which this read (outside the session) cannot see yet.
 * Neither can point another org's data at this one.
 *
 * ⚠ Only inside a request (`home/request-context.ts`). Scripts, migrations, the test-org copy job
 * and the mirror write as trusted code and are not slowed down or second-guessed, and raw driver
 * writes (`Model.collection.*`) pass, as they pass the home guard.
 */
export class ForeignReferenceError extends Error {
  readonly statusCode = 422
  readonly code = 'foreign_reference'
  constructor(public path: string, public target: string) {
    super(`${path}: not a record of this organization`)
    this.name = 'ForeignReferenceError'
  }
}

/** A reference field of a schema: its path (`*` = each element of an array) and what it names. */
export interface RefLeaf {
  path: string[]
  ref: string
  caster: any
}

const leafCache = new WeakMap<object, RefLeaf[]>()

function refName(ref: unknown): string | undefined {
  if (typeof ref === 'string') return ref
  if (ref && typeof (ref as any).modelName === 'string') return (ref as any).modelName
  return undefined // a function or a `refPath`: decided per document, not knowable here
}

const isObjectIdType = (t: any) => t?.instance === 'ObjectId' || t?.instance === 'ObjectID'

/** Every reference field of a schema, at any depth. Cached per schema. */
export function refLeaves(schema: Schema): RefLeaf[] {
  const cached = leafCache.get(schema)
  if (cached) return cached
  const out: RefLeaf[] = []
  leafCache.set(schema, out) // a schema that contains itself stops here
  schema.eachPath((path: string, type: any) => {
    const segs = path.split('.')
    if (isObjectIdType(type)) {
      const ref = refName(type.options?.ref)
      if (ref) out.push({ path: segs, ref, caster: type })
      return
    }
    if (type?.schema && (type.$isMongooseDocumentArray || type.instance === 'Array')) {
      for (const l of refLeaves(type.schema)) out.push({ ...l, path: [...segs, '*', ...l.path] })
      return
    }
    if (type?.schema && (type.$isSingleNested || type.instance === 'Embedded')) {
      for (const l of refLeaves(type.schema)) out.push({ ...l, path: [...segs, ...l.path] })
      return
    }
    if (type?.instance === 'Array') {
      const el = type.caster ?? type.embeddedSchemaType ?? type.$embeddedSchemaType
      const ref = refName(el?.options?.ref ?? type.options?.ref)
      if (isObjectIdType(el) && ref) out.push({ path: [...segs, '*'], ref, caster: el })
    }
  })
  return out
}

export interface FoundRef {
  path: string
  ref: string
  id: string
}

/** The ids at `segs` under `value`. A `*` takes each element, and also a lone element. */
function collect(value: any, segs: string[], i: number, leaf: RefLeaf, out: FoundRef[]): void {
  if (value === undefined || value === null) return
  if (i === segs.length) {
    for (const v of Array.isArray(value) ? value : [value]) {
      if (v === undefined || v === null || v === '') continue
      let id: any
      try { id = leaf.caster.cast(v) } catch { continue } // not an id: the write fails on its own
      if (id) out.push({ path: leaf.path.filter(s => s !== '*').join('.'), ref: leaf.ref, id: String(id) })
    }
    return
  }
  const s = segs[i]
  if (s === '*') {
    for (const v of Array.isArray(value) ? value : [value]) collect(v, segs, i + 1, leaf, out)
    return
  }
  if (Array.isArray(value)) {
    for (const v of value) collect(v, segs, i, leaf, out)
    return
  }
  if (typeof value === 'object') collect(value[s], segs, i + 1, leaf, out)
}

/** The references a whole document carries, or only those under `tops` (top-level fields). */
export function refsInDocument(schema: Schema, doc: any, tops?: Set<string>): FoundRef[] {
  const out: FoundRef[] = []
  for (const leaf of refLeaves(schema)) {
    if (tops && !tops.has(leaf.path[0])) continue
    collect(doc, leaf.path, 0, leaf, out)
  }
  return out
}

/** The references an update sets. A pipeline update is computed by the server and not read. */
export function refsInUpdate(schema: Schema, update: any): FoundRef[] {
  if (!update || typeof update !== 'object' || Array.isArray(update)) return []
  const sets: Array<[string, any]> = []
  for (const [k, v] of Object.entries<any>(update)) {
    if (k === '$set' || k === '$setOnInsert') for (const [p, val] of Object.entries<any>(v ?? {})) sets.push([p, val])
    else if (k === '$push' || k === '$addToSet') {
      for (const [p, val] of Object.entries<any>(v ?? {})) sets.push([p, val && typeof val === 'object' && '$each' in val ? val.$each : val])
    } else if (!k.startsWith('$')) sets.push([k, v])
  }
  if (!sets.length) return []
  const out: FoundRef[] = []
  for (const [key, val] of sets) {
    // `lines.3.productId`, `lines.$.productId`, `lines.$[l].productId` all name `lines.*.productId`.
    const keySegs = key.split('.').filter(s => !/^\d+$/.test(s) && !s.startsWith('$'))
    for (const leaf of refLeaves(schema)) {
      let i = 0
      let j = 0
      while (j < keySegs.length && i < leaf.path.length) {
        if (leaf.path[i] === '*') { i++; continue }
        if (leaf.path[i] !== keySegs[j]) break
        i++
        j++
      }
      if (j === keySegs.length) collect(val, leaf.path, i, leaf, out)
    }
  }
  return out
}

/** The org ids a filter or a document names, if it names them. Undefined: it does not say. */
function orgIdsIn(value: any): string[] | undefined {
  const v = value?.orgId
  if (v === undefined || v === null) return undefined
  if (typeof v === 'object' && !('_bsontype' in v) && !(typeof v.toHexString === 'function')) {
    if (Array.isArray(v.$in)) return v.$in.map(String)
    if (v.$eq !== undefined) return [String(v.$eq)]
    return undefined
  }
  return [String(v)]
}

/**
 * Ids already asked about in this request, per org. Confirming a movement writes a stock level per
 * line, each naming the product and warehouse the movement itself was just checked for.
 */
const askedThisRequest = new WeakMap<object, Set<string>>()

/** Refuse when a reference names a record that belongs to an org other than `orgId`. */
export async function assertRefsInOrg(model: any, orgId: unknown, refs: FoundRef[]): Promise<void> {
  if (!refs.length || orgId === undefined || orgId === null || orgId === '') return
  const ctx = currentRequest()
  let asked = ctx ? askedThisRequest.get(ctx) : undefined
  if (ctx && !asked) askedThisRequest.set(ctx, (asked = new Set()))
  const byRef = new Map<string, FoundRef[]>()
  for (const r of refs) byRef.set(r.ref, [...(byRef.get(r.ref) ?? []), r])
  for (const [ref, list] of byRef) {
    const target = model?.db?.models?.[ref] ?? model?.base?.models?.[ref]
    if (!target?.schema?.path('orgId')) continue // a global model (Org, Identity…): no org to compare
    const key = (id: string) => `${String(orgId)}:${ref}:${id}`
    const ids = [...new Set(list.map(r => r.id))].filter(id => !asked?.has(key(id)))
    if (!ids.length) continue
    const hit: any = await target
      .findOne({ _id: { $in: ids }, orgId: { $exists: true, $nin: [String(orgId), null] } }, { _id: 1 })
      .lean()
      .exec()
    if (hit) throw new ForeignReferenceError(list.find(r => r.id === String(hit._id))?.path ?? list[0].path, ref)
    for (const id of ids) asked?.add(key(id))
  }
}

const QUERY_WRITES = ['updateOne', 'updateMany', 'findOneAndUpdate', 'replaceOne', 'findOneAndReplace'] as const

async function checkQuery(model: any, filter: any, update: any): Promise<void> {
  const refs = refsInUpdate(model.schema, update)
  if (!refs.length) return
  const orgs = orgIdsIn(update?.$set) ?? orgIdsIn(update?.$setOnInsert) ?? orgIdsIn(update) ?? orgIdsIn(filter)
    ?? (await model.distinct('orgId', filter ?? {})).map(String)
  for (const org of new Set(orgs)) await assertRefsInOrg(model, org, refs)
}

export function referenceGuard(schema: Schema): void {
  schema.pre('save', async function (this: any) {
    if (!currentRequest()) return
    const model = this.constructor
    if (!refLeaves(model.schema).length) return
    const tops = this.isNew ? undefined : new Set<string>(this.modifiedPaths().map((p: string) => p.split('.')[0]))
    if (tops && !tops.size) return
    const plain = this.toObject({ depopulate: true, getters: false, virtuals: false, transform: false })
    await assertRefsInOrg(model, this.orgId, refsInDocument(model.schema, plain, tops))
  })

  schema.pre('insertMany', async function (this: any, next: any, docs: any) {
    if (!currentRequest() || !refLeaves(this.schema).length) return
    for (const d of Array.isArray(docs) ? docs : [docs]) {
      const plain = typeof d?.toObject === 'function' ? d.toObject({ depopulate: true }) : d
      await assertRefsInOrg(this, plain?.orgId, refsInDocument(this.schema, plain))
    }
  })

  for (const op of QUERY_WRITES) {
    schema.pre(op as any, { query: true, document: false }, async function (this: any) {
      if (!currentRequest() || !refLeaves(this.model.schema).length) return
      const update = op === 'replaceOne' || op === 'findOneAndReplace' ? { $set: this.getUpdate?.() } : this.getUpdate?.()
      await checkQuery(this.model, this.getFilter(), update)
    })
  }

  schema.pre('bulkWrite' as any, async function (this: any, next: any, ops: any[]) {
    if (!currentRequest() || !refLeaves(this.schema).length) return
    for (const o of ops ?? []) {
      if (o.insertOne) await assertRefsInOrg(this, o.insertOne.document?.orgId, refsInDocument(this.schema, o.insertOne.document))
      else if (o.replaceOne) await checkQuery(this, o.replaceOne.filter, { $set: o.replaceOne.replacement })
      else if (o.updateOne || o.updateMany) {
        const w = o.updateOne ?? o.updateMany
        await checkQuery(this, w.filter, w.update)
      }
    }
  })
}
