import type { Schema } from 'mongoose'

/**
 * Adds `orgId` to a schema. That is ALL it does.
 *
 * ⚠ It does NOT filter queries by tenant, despite the comment below it and despite CLAUDE.md
 * having told every controller author for years that it "auto-filters all queries". The three
 * `pre` hooks are guard clauses with no body — they inspect the filter, return, and change
 * nothing. A `find({})` on a model using this plugin returns every organisation's rows.
 *
 * That belief is why `const filter = { orgId }` — with `orgId` read straight out of the URL —
 * looked like a sufficient tenancy check to 67 controllers, of which exactly one compares the
 * caller's org to the one in the path. See gjovanov/lgr#31 for the measured blast radius, and
 * `tests/src/integration/tenant-isolation.flow.test.ts` for the 73 routes that leak today.
 *
 * Do not "fix" the hooks here in passing. Filtering at this layer would silently change the
 * result of every query in the codebase, including the legitimate cross-org ones (seeding,
 * the digest scheduler's org sweep, migrations) — which is why the chosen fix is a guard at
 * the auth layer, tracked separately. Until that lands, these hooks are dead code that lies.
 */
export function tenantPlugin(schema: Schema) {
  schema.add({
    orgId: {
      type: 'ObjectId',
      ref: 'Org',
      required: true,
      index: true,
    },
  })

  // ⚠ These three do nothing. See the header — they are NOT an auto-filter.
  schema.pre('find', function () {
    if (!this.getFilter().orgId) return
  })

  schema.pre('findOne', function () {
    if (!this.getFilter().orgId) return
  })

  schema.pre('countDocuments', function () {
    if (!this.getFilter().orgId) return
  })
}
