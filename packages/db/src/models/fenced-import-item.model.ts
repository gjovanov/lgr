import { Schema, model, type Types } from 'mongoose'
import { replicate } from '../replication/declare.js'

/**
 * One document of a fenced export, as the audited import left it (FR-20.84, plan step P3-6e): brought
 * into the org, or left for a person, and why. The import's memory: a crash, a restart or a second
 * pod repeats nothing a row says is done.
 *
 * Global's own (class N): it is the import's progress, not the org's data. The documents it brought
 * in carry their own `importedFrom`.
 */
export const FENCED_IMPORT_OUTCOMES = ['imported', 'skipped', 'failed'] as const
export type FencedImportOutcome = (typeof FENCED_IMPORT_OUTCOMES)[number]

export interface IFencedImportItem {
  _id: Types.ObjectId
  exportId: Types.ObjectId
  orgId: Types.ObjectId
  coll: string
  /** The document's id as a string (an ObjectId's hex, or the string id itself). */
  docKey: string
  outcome: FencedImportOutcome
  /** Why it was not imported, or what the import did with it. */
  reason?: string
  detail?: string
  /** A sale's number, as the site gave it. */
  number?: string
  /** A till sale's session, whatever became of the sale: its journal entry waits for all of them. */
  sessionKey?: string
  at: Date
}

const fencedImportItemSchema = new Schema<IFencedImportItem>(
  {
    exportId: { type: Schema.Types.ObjectId, required: true },
    orgId: { type: Schema.Types.ObjectId, required: true },
    coll: { type: String, required: true, maxlength: 100 },
    docKey: { type: String, required: true, maxlength: 200 },
    outcome: { type: String, enum: FENCED_IMPORT_OUTCOMES, required: true },
    reason: { type: String, maxlength: 100 },
    detail: { type: String, maxlength: 2000 },
    number: { type: String, maxlength: 100 },
    sessionKey: { type: String, maxlength: 100 },
    at: { type: Date, required: true },
  },
  { collection: 'fenced_import_items' },
)
fencedImportItemSchema.index({ exportId: 1, coll: 1, docKey: 1 }, { unique: true })
fencedImportItemSchema.index({ orgId: 1, exportId: 1, outcome: 1 })

replicate(fencedImportItemSchema, { class: 'N' })

export const FencedImportItem = model<IFencedImportItem>('FencedImportItem', fencedImportItemSchema)
