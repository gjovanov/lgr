import type { Schema } from 'mongoose'

export interface LoweredFieldsConfig {
  /** Source-field → target lowered-field map. Target should also be added to the schema. */
  fields: Record<string, string>
  /** Locale for `toLocaleLowerCase`. Defaults to 'bg' so Cyrillic case-folding works deterministically. */
  locale?: string
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
 * Hooks save/findOneAndUpdate/updateOne/updateMany so the lowered fields stay in sync
 * regardless of how the document is mutated.
 *
 * A source field may be a list of strings (`Contact.aliases`): its mirror is the list, lowered entry by
 * entry. ⚠ Only a write that sets the whole list is mirrored (a save, a `$set`, a top-level field of an
 * update); a `$push` or `$addToSet` into the source would leave the mirror behind.
 */
export function loweredFieldsPlugin(schema: Schema, config: LoweredFieldsConfig) {
  const locale = config.locale ?? 'bg'
  const entries = Object.entries(config.fields)

  schema.pre('save', function () {
    for (const [src, tgt] of entries) {
      if (this.isModified(src)) {
        // @ts-expect-error dynamic field access
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

  function applyToUpdate(this: any) {
    const update = this.getUpdate()
    if (!update) return
    const set = update.$set ?? update
    for (const [src, tgt] of entries) {
      if (Object.prototype.hasOwnProperty.call(set, src)) {
        set[tgt] = lower(set[src], locale)
      }
    }
    if (update.$set) update.$set = set
    this.setUpdate(update)
  }

  schema.pre('findOneAndUpdate', applyToUpdate)
  schema.pre('updateOne', applyToUpdate)
  schema.pre('updateMany', applyToUpdate)
}
