import type { Schema } from 'mongoose'

/**
 * FR-21.26 — a collection nothing may write through its model any more.
 *
 * `postransactions` stopped taking writes in R2: the till writes cash-register documents, and
 * migrations 0008/0009 copied every row into one. R3 makes that a rule. Every write through the
 * model throws, so a forgotten writer fails loudly instead of putting a sale where no reader
 * looks first.
 *
 * Raw driver writes (`Model.collection.*`) pass, as they pass the home guard: the restore of an
 * older bundle (which converts the rows it lands), the move and the mirror write that way on
 * purpose, and `home-write-guard.flow.test.ts` lists each site.
 */
export class FrozenCollectionError extends Error {
  constructor(public collection: string, public op: string) {
    super(`${collection} is frozen (FR-21): ${op} refused`)
    this.name = 'FrozenCollectionError'
  }
}

const QUERY_WRITES = [
  'updateOne', 'updateMany', 'findOneAndUpdate', 'replaceOne', 'findOneAndReplace',
  'deleteOne', 'deleteMany', 'findOneAndDelete',
] as const

export function frozenPlugin(schema: Schema, opts: { collection: string }): void {
  const refuse = (op: string) => { throw new FrozenCollectionError(opts.collection, op) }
  schema.pre('save', function () { refuse('save') })
  schema.pre('insertMany', function () { refuse('insertMany') })
  for (const op of QUERY_WRITES) {
    schema.pre(op as any, { query: true, document: false }, function () { refuse(op) })
  }
  // `doc.deleteOne()` / `doc.updateOne()` on a loaded document.
  schema.pre(['deleteOne', 'updateOne'] as any, { document: true, query: false }, function () { refuse('doc.write') })
  schema.pre('bulkWrite' as any, function () { refuse('bulkWrite') })
}
