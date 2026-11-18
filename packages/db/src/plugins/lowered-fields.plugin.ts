import type { Schema } from 'mongoose'
import { searchFieldPlugin, type SearchFieldConfig } from './search-field.js'

export interface LoweredFieldsConfig {
  /** Source-field → target lowered-field map. Target should also be added to the schema. */
  fields: Record<string, string>
  /** Locale for `toLocaleLowerCase`. Defaults to 'bg' so Cyrillic case-folding works deterministically. */
  locale?: string
  /** FR-30.11: the mirrors joined into one indexed search field, kept beside them (`search-field.ts`). */
  joined?: SearchFieldConfig
}

function lower(value: unknown, locale: string): string | string[] | undefined {
  if (typeof value === 'string') return value.toLocaleLowerCase(locale)
  // A list of strings (a contact's other names) is mirrored entry by entry, so a search reads it like any name.
  if (Array.isArray(value)) return Array.from(value).filter((v): v is string => typeof v === 'string').map((v) => v.toLocaleLowerCase(locale))
  return undefined
}

/**
 * Maintains lowercased mirror fields for case-insensitive search across Cyrillic and other
 * non-ASCII alphabets where MongoDB's regex `i` flag isn't reliable.
 *
 * Hooks save/insertMany/findOneAndUpdate/updateOne/updateMany so a mirror follows every write that
 * gives its source the whole value.
 *
 * An update can do that in three places, and each is read on its own (#759): at the top level, which
 * Mongoose takes as a `$set`, under `$set`, and under `$setOnInsert`. The mirror is written beside its
 * source, in the same place, so the update stays the one the caller wrote. A source the update removes
 * (`$unset`) loses its mirror, and one set to `null` gets a `null` mirror: either way the search stops
 * finding the old text.
 *
 * ⚠ Never "`$set`, or else the update itself". On a schema with `timestamps: true` Mongoose has already
 * put a `$set` of its own (the `updatedAt`) into the update when this hook runs, so that reading never
 * looked at the top level, and the repositories' by-id `update` names every field there.
 *
 * A source field may be a list of strings (`Contact.aliases`): its mirror is the list, lowered entry by
 * entry. ⚠ Only a write that sets the whole list is mirrored (a save, a `$set`, a top-level field of an
 * update); a `$push` or `$addToSet` into the source would leave the mirror behind.
 *
 * ⚠ Not mirrored, because there is nothing here to read: an aggregation-pipeline update (its values are
 * worked out in the database), a field an upsert takes from its filter, and `bulkWrite`, which runs no
 * hook at all (its callers set the mirrors themselves).
 */
export function loweredFieldsPlugin(schema: Schema, config: LoweredFieldsConfig) {
  const locale = config.locale ?? 'bg'
  const entries = Object.entries(config.fields)

  schema.pre('save', function () {
    for (const [src, tgt] of entries) {
      if (this.isModified(src)) {
        this[tgt] = lower(this[src], locale)
      }
    }
  })

  schema.pre('insertMany', function (next: any, docs: any[]) {
    if (Array.isArray(docs)) {
      for (const doc of docs) {
        for (const [src, tgt] of entries) {
          if (doc?.[src] !== undefined) doc[tgt] = lower(doc[src], locale)
        }
      }
    }
    next()
  })

  const names = (place: unknown, field: string): place is Record<string, unknown> =>
    !!place && typeof place === 'object' && !Array.isArray(place) && Object.prototype.hasOwnProperty.call(place, field)
  // A `null` source empties its mirror. `undefined` would not: Mongoose drops it from the update, and the
  // mirror would keep the text the source no longer has.
  const mirrorOf = (value: unknown) => (value === null ? null : lower(value, locale))

  function applyToUpdate(this: any) {
    const update = this.getUpdate()
    if (!update || Array.isArray(update)) return
    for (const [src, tgt] of entries) {
      for (const place of [update, update.$set, update.$setOnInsert]) {
        if (names(place, src)) place[tgt] = mirrorOf(place[src])
      }
      if (names(update.$unset, src)) update.$unset[tgt] = update.$unset[src]
    }
    this.setUpdate(update)
  }

  schema.pre('findOneAndUpdate', applyToUpdate)
  schema.pre('updateOne', applyToUpdate)
  schema.pre('updateMany', applyToUpdate)

  // After the mirrors' hooks: the joined field is built from them.
  if (config.joined) searchFieldPlugin(schema, config.joined, entries.map(([src]) => src))
}
