/**
 * What a route DOES, not its HTTP method (FR-20.4, plan step P0b-2).
 *
 * On a node that is not an org's home, a route that writes the org's data answers 409, and one
 * that only reads keeps working — that is what a mirror is for. So every route is one or the
 * other, decided here, once:
 * - a **GET reads**. The GETs that write anyway (a lazy insert, a number claimed on first view)
 *   are listed and handled in plan step P0b-4 ("reads that write");
 * - **anything else writes**, unless it is in `READ_ONLY_WRITES` below: the reports and exports
 *   that use POST only because their parameters do not fit a query string.
 *
 * ⚠ A route added to `READ_ONLY_WRITES` must write nothing at all — on a mirror the write guard
 * (P0b-2 part 2) makes any write inside one throw. When in doubt, leave it out: a route that is
 * wrongly gated answers 409 on a mirror, one that is wrongly let through writes mirrored data.
 *
 * Import-pure (no models), like `tenant-guard.ts` and `public-routes.ts`.
 */

/** `METHOD /path` as the route table spells it, with `/api` and the `:orgId` prefix. */
export const READ_ONLY_WRITES: ReadonlySet<string> = new Set([
  'POST /api/org/:orgId/reports/:id/run',
  'POST /api/org/:orgId/reports/:id/export',
  'POST /api/org/:orgId/invoicing/export/list',
  'POST /api/org/:orgId/invoicing/export/kind/:kind',
  'POST /api/org/:orgId/invoicing/stock-availability/check',
  // FR-20.79 (P3-6a): what stands in the way of a move, checked; nothing is written.
  'POST /api/org/:orgId/moves/preflight',
])

/**
 * FR-20.2 (plan step P2-1) — routes under `/org/:orgId/` that write GLOBAL's registry of the org's
 * servers, never the org's data. They answer whoever the org's home is, because the case they exist
 * for is the one where the home is a master: revoking a lost or stolen master, or registering the
 * one that replaces it. The home gate letting them through is the whole point.
 *
 * ⚠ A route here must write no org data. The write guard still applies inside it, so an org-data
 * write in one throws on a node that is not the org's home rather than writing mirrored data. Its
 * models (`ServerNode`, `NodeEnrollment*`) carry no tenant plugin, and on a master every one of
 * these routes is 404.
 */
export const GLOBAL_STATE_WRITES: ReadonlySet<string> = new Set([
  'POST /api/org/:orgId/nodes/:id/revoke',
  'POST /api/org/:orgId/nodes/enrollment-codes',
  'POST /api/org/:orgId/nodes/enrollment-keys',
  'DELETE /api/org/:orgId/nodes/enrollment-keys/:id',
  // FR-20.59 (P2-6): which services global relays for a master, global's own record.
  'PUT /api/org/:orgId/nodes/:id/relays',
  // FR-20.79 (P3-6a): global's record of a move and the org's home. The abort is exactly for an org
  // that is frozen, which the home gate would otherwise refuse.
  'POST /api/org/:orgId/moves/',
  'POST /api/org/:orgId/moves/:id/abort',
])

/**
 * FR-20.6 — reads that WRITE, each with what it writes and how it respects the home. A route here
 * still reads (a mirror answers it), so each one checks the home itself before writing — and
 * `reads-that-write.flow.test.ts` fails on any GET that writes and
 * is not listed. Prefer making a new writer a POST over adding it here.
 */
export const GET_WRITERS: ReadonlyMap<string, string> = new Map([
  ['GET /api/org/:orgId/invoicing/export/:id',
    'prints a companion document, allocating its number on first print; ensureCompanionNumber asserts the home (fresh) first'],
  ['GET /api/org/:orgId/apps/',
    'the App Hub inserts the OrgApp rows an org is missing; off its home it inserts nothing'],
  ['GET /api/oauth/callback/:provider',
    'a GET because OAuth redirects back with one: signs a person in, creating or linking their membership; joining an org homed elsewhere is refused (P0b-3)'],
])

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

/** Normalise a route as Elysia reports it, which may or may not carry the `/api` prefix. */
function key(method: string, route: string): string {
  const path = route.startsWith('/api/') ? route : `/api${route.startsWith('/') ? '' : '/'}${route}`
  return `${method.toUpperCase()} ${path}`
}

export function isReadOnlyRoute(method: string, route: string): boolean {
  if (READ_METHODS.has(method.toUpperCase())) return true
  return READ_ONLY_WRITES.has(key(method, route))
}

/** `METHOD /path` as the route table spells it — the key of `READ_ONLY_WRITES` and `GET_WRITERS`. */
export function routeKey(method: string, route: string): string {
  return key(method, route)
}

/** A write of global's own state, which the home gate lets through (`GLOBAL_STATE_WRITES`). */
export function isGlobalStateWrite(method: string, route: string): boolean {
  return GLOBAL_STATE_WRITES.has(key(method, route))
}

export function isListedReadWriter(method: string, route: string): boolean {
  return GET_WRITERS.has(key(method, route))
}
