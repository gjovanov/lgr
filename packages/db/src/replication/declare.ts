/**
 * What replicates, declared on each model (FR-20.62, plan step P3-1a, Part A.5.3).
 *
 * Every model makes the decision itself, next to its schema: `replicate(schema, { class: 'R' })`.
 * `bun run gen:replication-meta` reads them into `meta.generated.ts`, and
 * `unit/replication-meta.test.ts` fails the build when a model has none, when the committed file
 * differs, or when a split model leaves a field without exactly one owner.
 *
 * - **R** replicated: written on the org's home, the mirror applies the whole document. A document
 *   with no `orgId` is never journaled (an `ExchangeRate` with `orgId: null` is reference data).
 * - **S** split: each field has an owner, the home, global or the node, declared on dotted paths;
 *   the most specific path decides (`settings` is the home's, `settings.integrations` global's). The
 *   master sends only the home's fields, and the mirror writes only those (FR-20.63).
 * - **N** node-local: never leaves the node that wrote it (claims, codes, the journal itself).
 * - **G** global-only: people's or everyone's (identities, invites, reference data). A master holds
 *   at most a sanitised cache, and never writes it.
 *
 * Import-pure: no models, no mongoose import, so the metadata can be read anywhere.
 */
export type ReplicationClass = 'R' | 'S' | 'N' | 'G'

export type ReplicationDecl =
  | { class: 'R' | 'N' | 'G'; orgPath?: '_id' }
  | {
      class: 'S'
      /** Where the org is when it is not `orgId`: `Org` itself, whose `_id` is the org. */
      orgPath?: '_id'
      /** Written on the home and mirrored: dotted paths, a path covering everything under it. */
      home: string[]
      /** Global's own (the org's slug, its subscription): never overwritten by a page. */
      global: string[]
      /** True only where it was written (a device's live status, a desktop's presence). */
      node: string[]
    }

/** The schema option the decision is kept under. */
export const REPLICATION_OPTION = 'replication'

/** Declare what of this schema's documents replicates. */
export function replicate<S extends { set: (...args: any[]) => unknown }>(schema: S, decl: ReplicationDecl): S {
  // Mongoose keeps unknown options as they are; its types list only its own, hence the cast.
  ;(schema.set as (key: string, value: unknown) => unknown).call(schema, REPLICATION_OPTION, decl)
  return schema
}

/** Paths every document has and no one owns: its id, its version key, its org (the route itself). */
export const STRUCTURAL_PATHS: ReadonlySet<string> = new Set(['_id', '__v', 'orgId'])

/**
 * The owner of `leaf` in a split declaration: the longest declared path that is the leaf or an
 * ancestor of it. `null` when none covers it.
 */
export function ownerOf(decl: Extract<ReplicationDecl, { class: 'S' }>, leaf: string): { owner: 'home' | 'global' | 'node'; path: string } | null {
  let best: { owner: 'home' | 'global' | 'node'; path: string } | null = null
  for (const owner of ['home', 'global', 'node'] as const) {
    for (const p of decl[owner]) {
      if ((leaf === p || leaf.startsWith(`${p}.`)) && (!best || p.length > best.path.length)) best = { owner, path: p }
    }
  }
  return best
}
