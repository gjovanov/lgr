/**
 * A script that writes must not build indexes, and must not write without the ones it relies on.
 *
 * Mongoose builds every compiled model's indexes and collections on connect. From a checkout ahead of prod
 * that is an unreleased schema change made by a CLI: on 2026-11-05 it would have built two indexes prod did
 * not have (one on employee names). So a writing script connects with `connectDB({ readOnly: true })`, which
 * only turns that off, and then calls this: the unique indexes of the collections it writes are its safety net
 * against duplicates, and the deployed app is what builds them. (`migrate-identities.ts` is the first instance.)
 */
import type { Model } from 'mongoose'

/** Refuse to go on unless every unique index these models declare, field-level ones included, is on the database. */
export async function requireUniqueIndexes(models: readonly Model<any>[]): Promise<void> {
  const missing: string[] = []
  for (const M of models) {
    const held = new Set((await M.collection.indexes().catch(() => [])).filter((i: any) => i.unique).map((i: any) => JSON.stringify(i.key)))
    for (const [key, options] of M.schema.indexes()) {
      if (options?.unique && !held.has(JSON.stringify(key))) missing.push(`${M.collection.collectionName} ${JSON.stringify(key)}`)
    }
  }
  if (missing.length) {
    throw new Error(`refusing to write: unique index missing (${missing.join('; ')}). The app builds them when it starts: deploy or start it first.`)
  }
}
