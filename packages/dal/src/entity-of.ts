import type { Document, Types } from 'mongoose'
import type { TenantEntity } from './types.js'

/**
 * FR-32.15 (#797): an entity's type comes from its model, never written out a second time.
 *
 * The model's interface (`db/models/*.model.ts`, the generic of its `Schema`) is the one description of a document.
 * A repository returns that document as a plain object: `toEntity` turns `_id` into `id`, and every `ObjectId` into its
 * string (`dal-mongo/base.repository.ts`). `Plain` says the same of the type, so a field added to a model is a field the
 * repository knows without a second edit (`unit/entity-types.test.ts` proves it for `Invoice`).
 *
 * Type-only: `dal` imports nothing of `db` or `mongoose` at run time.
 */
export type Plain<T> = T extends Types.ObjectId
  ? string
  : T extends Date
    ? T
    : T extends readonly (infer U)[]
      ? Plain<U>[]
      : T extends (...args: never[]) => unknown
        ? T
        : T extends object
          ? { [K in keyof T]: Plain<T[K]> }
          : T

/** What a model's interface has that is Mongoose's, not the document's: the `Document` methods and the raw ids. */
type DocumentKeys = keyof Document | '_id' | '__v' | 'orgId' | 'createdAt' | 'updatedAt'

/** The entity a repository returns for a model `M` of an org: its fields as plain values, with `id` and the stamps. */
export type EntityOf<M> = Plain<Omit<M, DocumentKeys>> & TenantEntity
