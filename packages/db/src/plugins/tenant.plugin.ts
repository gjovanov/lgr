import type { Schema } from 'mongoose'
import { homeWriteGuard } from '../home/write-guard.js'

/**
 * Adds `orgId` to a schema, and (FR-20.4) the write guard that refuses writes to an org whose home
 * is elsewhere — see `home/write-guard.ts`. It still does NOT filter queries:
 *
 * ⚠ It does NOT filter queries by tenant, and never did. Until gjovanov/lgr#41 this function
 * also registered `pre('find')`, `pre('findOne')` and `pre('countDocuments')` hooks whose
 * bodies were a guard clause and nothing else (`if (!this.getFilter().orgId) return`). They
 * changed no query, but CLAUDE.md described them as an auto-filter — so `const filter =
 * { orgId }`, with `orgId` read straight out of the URL, looked like a sufficient tenancy
 * check to 67 controllers. It was not: #31 measured 73 of 83 probeable GET routes returning
 * another organisation's data.
 *
 * **#41 DELETED the three hooks rather than implementing them**, for two reasons:
 *
 *   1. Deleting changes nothing at runtime — they were no-ops — so it carries no risk, while
 *      implementing them would silently change the result of EVERY query in the codebase,
 *      including the legitimately cross-org ones: seeding, the digest scheduler's org sweep,
 *      migrations, `backup-runner`, the `din_catalog` reads. Each would need an opt-out, and
 *      an opt-out that 67 call sites can reach is not a tenancy boundary.
 *   2. A Mongoose hook cannot answer the question that actually leaked. The queries WERE
 *      filtered by an orgId; it was the wrong one — the caller's URL rather than the caller's
 *      token. Only something holding the request's identity can compare the two.
 *
 * Tenancy is enforced at the auth layer instead: `services/biz/tenant-guard.ts#isForeignOrg`,
 * registered as a `beforeHandle` hook by `portal-api/src/auth/auth.service.ts` and the seven
 * `services/http/app-auth.service.ts` (one since FR-24.30), rejects any request whose `:orgId` differs from the token's.
 * It applies to every route of every controller that authenticates, with nothing to opt into.
 * `tests/src/integration/tenant-isolation.flow.test.ts` asserts the property over the real
 * route table, so a controller added next year is covered the day it is mounted.
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
  // FR-20.4: a write to an org whose home is elsewhere is refused, whatever makes it.
  homeWriteGuard(schema)
}
