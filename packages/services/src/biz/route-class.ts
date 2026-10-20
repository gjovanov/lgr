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
