import type { Schema } from 'mongoose'

/**
 * FR-30.11: one indexed search field, the lowered mirrors joined.
 *
 * A product search tested a pattern on five lowered fields, which no index serves, so every search read the whole
 * catalogue (23 050 articles), whether it found anything or not. Joined into one field with an index on
 * `{ orgId, <field> }`, the pattern is tested on the index's keys and only the matches are fetched.
 *
 * The parts are joined by `SEARCH_FIELD_SEPARATOR`, a control character nobody types: a keyword never contains it,
 * so no keyword can match across two parts (the end of the name and the start of the SKU).
 *
 * Kept by the lowered-fields plugin (`joined`), after the mirrors it is built from:
 * - a save and an `insertMany` compute it from the document;
 * - an update that names a source or a mirror (`$set`, the top level, `$setOnInsert`, `$unset`) refreshes it after the
 *   update, in the database, from the stored mirrors, in the update's session (`refreshSearchField`);
 * - a `bulkWrite` that names one gets the same refresh after it, in its session (the model's own `bulkWrite`).
 * A document the field is missing on (a raw driver write, a row from before the backfill) is still found: the search
 * reads such a document by its mirrors (`services/biz/search.utils#buildProductSearchFilter`), and
 * `scripts/backfill-product-search-field.ts` fills them.
 */

/** ASCII unit separator: never typed, never in a keyword. */
export const SEARCH_FIELD_SEPARATOR = '\u001f'

export interface SearchFieldConfig {
  /** The joined field, e.g. `searchLower`. */
  field: string
  /** The mirrors it joins, in order. */
  parts: string[]
}

/** The field's value for a document whose mirrors are known. */
export function joinedValue(doc: Record<string, unknown>, parts: readonly string[]): string {
  return parts.map((p) => (typeof doc[p] === 'string' ? (doc[p] as string) : '')).join(SEARCH_FIELD_SEPARATOR)
}

/** The same value, as the database computes it from the stored mirrors. */
export function joinedExpression(parts: readonly string[]): Record<string, unknown> {
  const pieces: unknown[] = []
  parts.forEach((p, i) => {
    if (i) pieces.push(SEARCH_FIELD_SEPARATOR)
    pieces.push({ $cond: [{ $eq: [{ $type: `$${p}` }, 'string'] }, `$${p}`, ''] })
  })
  return { $concat: pieces }
}

/** A filter for the documents of `scope` whose field is missing or no longer what their mirrors say. */
export function staleSearchField(cfg: SearchFieldConfig, scope: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...scope, $expr: { $ne: [{ $ifNull: [`$${cfg.field}`, null] }, joinedExpression(cfg.parts)] } }
}

/** The update that sets the field from the stored mirrors (an aggregation pipeline: the database computes it). */
export function searchFieldUpdate(cfg: SearchFieldConfig): Record<string, unknown>[] {
  return [{ $set: { [cfg.field]: joinedExpression(cfg.parts) } }]
}

/**
 * Set the field on every document of `scope` where it is missing or stale; the count of documents written. Idempotent:
 * a second run writes nothing. A scope that names no org takes only the orgs homed here (FR-20.5).
 */
export async function refreshSearchField(model: any, cfg: SearchFieldConfig, scope: Record<string, unknown>, opts: { session?: unknown } = {}): Promise<number> {
  let where = scope
  if (!('_id' in scope) && !('orgId' in scope)) {
    const { homeScope } = await import('../home/home.js')
    where = { ...scope, ...(await homeScope()) }
  }
  const res = await model.updateMany(staleSearchField(cfg, where), searchFieldUpdate(cfg), opts.session ? { session: opts.session } : {}).exec()
  return Number(res?.modifiedCount ?? 0)
}

/** The narrowest scope a filter names: its document, its org, or none. */
function scopeOf(filter: Record<string, any> | undefined): Record<string, unknown> {
  if (filter?._id !== undefined) return { _id: filter._id }
  if (filter?.orgId !== undefined) return { orgId: filter.orgId }
  return {}
}

export function searchFieldPlugin(schema: Schema, cfg: SearchFieldConfig, sources: readonly string[]): void {
  const watched = new Set([...sources, ...cfg.parts])
  const names = (place: unknown): boolean =>
    !!place && typeof place === 'object' && !Array.isArray(place) && Object.keys(place as object).some((k) => watched.has(k))
  const touches = (update: any): boolean =>
    !!update && !Array.isArray(update) && (names(update) || names(update.$set) || names(update.$setOnInsert) || names(update.$unset))

  // Registered after the mirrors' own hooks, so the mirrors are already set.
  schema.pre('save', function () {
    const self = this as any
    if (self.isNew || [...watched].some((f) => self.isModified(f))) self[cfg.field] = joinedValue(self, cfg.parts)
  })

  schema.pre('insertMany', function (next: any, docs: any[]) {
    if (Array.isArray(docs)) for (const doc of docs) if (doc && typeof doc === 'object') doc[cfg.field] = joinedValue(doc, cfg.parts)
    next()
  })

  function mark(this: any) {
    if (touches(this.getUpdate())) this._searchFieldTouched = true
  }
  schema.pre('findOneAndUpdate', mark)
  schema.pre('updateOne', mark)
  schema.pre('updateMany', mark)

  async function refreshAfter(this: any, res: any) {
    if (!this._searchFieldTouched) return
    const session = this.getOptions?.().session ?? this.options?.session
    const doc = res && typeof res === 'object' && '_id' in res ? res : null
    const scope = doc ? { _id: doc._id } : scopeOf(this.getFilter())
    await refreshSearchField(this.model, cfg, scope, { session })
  }
  schema.post('findOneAndUpdate', refreshAfter)
  schema.post('updateOne', refreshAfter)
  schema.post('updateMany', refreshAfter)

  // A bulkWrite runs no query hook: the model's own `bulkWrite` refreshes after it, in its session (inside its
  // transaction). The caller's list of operations is left as it is: callers read it again afterwards.
  schema.statics.bulkWrite = async function (this: any, ops: any[], options?: any) {
    let touched = false
    const ids: unknown[] = []
    const orgs: unknown[] = []
    let everyById = true
    for (const op of Array.isArray(ops) ? ops : []) {
      const [kind, body] = Object.entries(op ?? {})[0] ?? []
      if (!kind || !body) continue
      const b = body as any
      if (kind === 'insertOne') { if (b.document && typeof b.document === 'object') b.document[cfg.field] = joinedValue(b.document, cfg.parts); continue }
      if (kind === 'replaceOne') { if (b.replacement) b.replacement[cfg.field] = joinedValue(b.replacement, cfg.parts); continue }
      if (kind === 'deleteOne' || kind === 'deleteMany' || !touches(b.update)) continue
      touched = true
      if (b.filter?._id !== undefined) ids.push(b.filter._id)
      else everyById = false
      if (b.filter?.orgId !== undefined) orgs.push(b.filter.orgId)
    }
    const { Model } = await import('mongoose')
    const res = await (Model as any).bulkWrite.call(this, ops, options)
    if (touched) {
      const scope = everyById && ids.length ? { _id: { $in: ids } } : orgs.length ? { orgId: { $in: orgs } } : {}
      await refreshSearchField(this, cfg, scope, { session: options?.session })
    }
    return res
  }
}
