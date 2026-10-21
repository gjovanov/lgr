import type { Schema } from 'mongoose'
import { anyOrgAwayFromHome, assertHomeIsHere } from './home.js'

/**
 * FR-20.4 — the second guard, below the routes: a write to an org-scoped document whose org's
 * home is elsewhere is refused, wherever it comes from — a service, a sweep, an event handler, a
 * script, a route without `:orgId`. The route gate (`services/biz/home-gate.ts`) answers 409
 * first for the routes it sees; this catches everything else.
 *
 * Installed by `tenantPlugin`, so every org-scoped model has it and a new one cannot forget it.
 *
 * ⚠ What it does not see, by design or by necessity:
 * - raw driver writes (`Model.collection.*`). The few in the application are listed, and guarded
 *   or exempted with a reason, in `tests/src/integration/home-write-guard.flow.test.ts`; a new one
 *   fails that test. The mirror applier (P3) writes this way on purpose;
 * - `Org` itself, which has no `orgId` path.
 *
 * Cost on global today: none worth measuring. No org has a node, so `anyOrgAwayFromHome()` is a
 * cached `false` and a write that names its org is one cached `homeOf`.
 */

const QUERY_WRITES = [
  'updateOne', 'updateMany', 'findOneAndUpdate', 'replaceOne', 'findOneAndReplace',
  'deleteOne', 'deleteMany', 'findOneAndDelete',
] as const

/** The org ids a filter or a document names, if it names them. Undefined: it does not say. */
function orgIdsIn(value: any): string[] | undefined {
  const v = value?.orgId
  if (v === undefined || v === null) return undefined
  if (typeof v === 'object' && !('_bsontype' in v) && !(typeof v.toHexString === 'function')) {
    if (Array.isArray(v.$in)) return v.$in.map(String)
    if (v.$eq !== undefined) return [String(v.$eq)]
    return undefined // another operator: it does not say which org
  }
  return [String(v)]
}

/**
 * Models whose writes draw a legal number. They ask the home record FRESH, never the five-second
 * cache: a move freezes the org first, and a number must not be drawn after the freeze (FR-20.4).
 */
const LEGAL_NUMBERING = new Set(['Sequence'])

async function assertAll(ids: Iterable<string>, fresh = false): Promise<void> {
  for (const id of new Set(ids)) await assertHomeIsHere(id, { fresh })
}

/** Check the orgs a write touches; resolve them from the data only when the write does not say. */
async function guardFilter(model: any, filter: any, update?: any): Promise<void> {
  // An update that MOVES documents into an org must be allowed to write that org too.
  const target = orgIdsIn(update?.$set) ?? orgIdsIn(update)
  if (target) await assertAll(target)

  const fresh = LEGAL_NUMBERING.has(model?.modelName)
  const named = orgIdsIn(filter)
  if (named) return assertAll(named, fresh)
  if (!(await anyOrgAwayFromHome())) return
  const touched = await model.distinct('orgId', filter ?? {})
  await assertAll(touched.map(String), fresh)
}

export function homeWriteGuard(schema: Schema): void {
  schema.pre('save', async function () {
    if ((this as any).orgId) await assertHomeIsHere((this as any).orgId)
  })

  schema.pre('insertMany', async function (next: any, docs: any) {
    const list = Array.isArray(docs) ? docs : [docs]
    await assertAll(list.map((d: any) => d?.orgId).filter(Boolean).map(String))
  })

  for (const op of QUERY_WRITES) {
    schema.pre(op as any, { query: true, document: false }, async function (this: any) {
      await guardFilter(this.model, this.getFilter(), this.getUpdate?.())
    })
  }
  // `doc.deleteOne()` / `doc.updateOne()` on a loaded document.
  schema.pre(['deleteOne', 'updateOne'] as any, { document: true, query: false }, async function (this: any) {
    if (this.orgId) await assertHomeIsHere(this.orgId)
  })

  schema.pre('bulkWrite' as any, async function (this: any, next: any, ops: any[]) {
    const model = this
    for (const op of ops ?? []) {
      if (op.insertOne) await assertAll(orgIdsIn(op.insertOne.document) ?? [])
      else if (op.replaceOne) {
        await assertAll(orgIdsIn(op.replaceOne.replacement) ?? [])
        await guardFilter(model, op.replaceOne.filter)
      } else {
        const w = op.updateOne ?? op.updateMany ?? op.deleteOne ?? op.deleteMany
        if (w) await guardFilter(model, w.filter, w.update)
      }
    }
  })
}
