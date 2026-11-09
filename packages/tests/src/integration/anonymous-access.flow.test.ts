import { describe, it, expect } from 'bun:test'
import { Elysia, t } from 'elysia'
import { createApiApp } from '../../../portal-api/src/api.js'
import { isPublicRoute, PUBLIC_ROUTE_KEYS } from 'services/biz/public-routes'

/**
 * Can a caller with NO token reach a handler?
 *
 * ── Why this file exists ─────────────────────────────────────────────────────────────────
 *
 * Until it did, nothing asked. `tenant-isolation.flow.test.ts` probes the same route table
 * with a token belonging to the WRONG org — a thorough answer to a different question, and
 * one that passes happily on a route which would have served a caller holding no token at
 * all. Authentication was assumed to be the `isSignIn` macro's job and was never measured.
 *
 * ⚠ The macro had stopped working. The auth plugins declared it through the Elysia 1.0
 * function form — `.macro(({ onBeforeHandle }) => ({ isSignIn … }))` — which on the installed
 * Elysia 1.4 is accepted, never invoked, and reports nothing: no throw, no warning, no type
 * error. Every `isSignIn: true` in the codebase had silently become a comment. Measured over
 * this same table at the commit before the fix: of 366 routes, **172 answered anonymously**,
 * among them payroll payslips, bank accounts, tax returns and stock levels. The 194 that did
 * answer 401 did so from an explicit `if (!user)` inside the handler — the check CLAUDE.md
 * called "load-bearing" without anyone knowing it had become the only one.
 *
 * ── What this file is ────────────────────────────────────────────────────────────────────
 *
 * A PROPERTY over the real route table, in the shape of its sibling: mount `createApiApp()`
 * — the table `unified.ts` actually serves — walk every route, send it a request carrying no
 * cookie and no Authorization header, and assert the handler was not reached. A controller
 * mounted next year is covered the day it appears, with no edit here.
 *
 * The property is "the handler did not run", and since S-15 (2026-11-09) also "the status was
 * 401": Elysia runs body validation BEFORE `beforeHandle`, so until the auth plugins refused in
 * their transform hook too, a POST with a schema answered 422 to an anonymous caller, with its
 * schema, and never reached the guard.
 *
 * ⚠ No database. The guard runs before any handler touches Mongo, so a route that is properly
 * guarded never needs one — and that is exactly what makes the probe sharp. An UNGUARDED
 * route reaches its handler, hits a disconnected mongoose, and throws: a 500. So "no route
 * answers 5xx" is a precise reading of "no handler ran", and it needs no fixtures to be true.
 */

/** Every route, with `:param` filled in so the router matches. */
function probeTargets(app: any): { method: string; route: string; url: string }[] {
  return (app.routes || [])
    .filter((r: any) => r.method !== 'WS' && r.method !== 'ALL')
    .map((r: any) => ({
      method: r.method,
      route: r.path,
      url:
        'http://localhost' +
        r.path.replace(/:orgId/g, '000000000000000000000001').replace(/:[A-Za-z]+/g, '1'),
    }))
}

async function probeAnonymously(app: any, t: { method: string; url: string }) {
  return app.handle(
    new Request(t.url, {
      method: t.method,
      headers: { 'content-type': 'application/json' },
      body: t.method === 'GET' || t.method === 'HEAD' ? undefined : '{}',
    }),
  )
}

describe('anonymous access', () => {
  const app: any = createApiApp()
  const targets = probeTargets(app)

  it('has a route table to probe', () => {
    expect(targets.length).toBeGreaterThan(300)
  })

  /**
   * The regression bar. A 5xx means the handler ran — the guard did not stop the request and
   * only the missing database did. A route that appears here is an authentication bypass.
   */
  it('reaches no handler without a token', async () => {
    const reached: string[] = []
    for (const target of targets) {
      if (isPublicRoute(target.method, target.route)) continue
      const res = await probeAnonymously(app, target)
      if (res.status >= 500) reached.push(`${target.method} ${target.route} -> ${res.status}`)
    }
    expect(reached).toEqual([])
  })

  /**
   * S-15: 401 and nothing else. Until 2026-11-09 the 401 came from a `beforeHandle` hook, which
   * Elysia runs AFTER body validation, so ~74 routes answered an anonymous caller 422 with their
   * whole body schema. The auth plugins now refuse in their transform hook, before validation.
   */
  it('answers 401 on every non-public route, never the route\'s schema', async () => {
    const wrong: string[] = []
    for (const target of targets) {
      if (isPublicRoute(target.method, target.route)) continue
      const res = await probeAnonymously(app, target)
      if (res.status !== 401) wrong.push(`${target.method} ${target.route} -> ${res.status}`)
    }
    expect(wrong).toEqual([])
  })

  /**
   * The ordering, on a route of the same shape: an invalid body and a valid one are refused
   * alike, and the refusal names no field. Without this, a guard moved back after validation
   * would show up only as a table of 422s again.
   */
  it('rejects the anonymous caller before the body is validated', async () => {
    const { AuthService } = await import('../../../portal-api/src/auth/auth.service.js')
    const guarded = new Elysia({ prefix: '/api' }).use(
      new Elysia({ prefix: '/org/:orgId/probe' })
        .use(AuthService as any)
        .post('/', () => ({ ok: 'HANDLER REACHED' }), { body: t.Object({ name: t.String() }) } as any),
    )
    const call = (body: string) =>
      guarded.handle(
        new Request('http://localhost/api/org/000000000000000000000001/probe/', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body,
        }),
      )

    const invalid = await call('{}')
    expect(invalid.status).toBe(401)
    expect(await invalid.json()).toEqual({ message: 'Unauthorized' })
    const valid = await call('{"name":"x"}')
    expect(valid.status).toBe(401)
    expect(await valid.json()).toEqual({ message: 'Unauthorized' })
  })

  /**
   * The allow-list asserted in BOTH directions, for the reason its sibling gives about
   * `KNOWN_LEAKS`: a list that is only ever added to is a list nobody trusts.
   *
   * Deleting a public route without deleting its entry leaves a stale exemption sitting in
   * the table looking authoritative — and the next route to be given that path inherits an
   * exemption nobody granted it.
   */
  it('has no public-route entry that is not a real route', () => {
    const real = new Set(targets.map(t => `${t.method} ${t.route}`))
    const stale = PUBLIC_ROUTE_KEYS.filter(k => !real.has(k))
    expect(stale).toEqual([])
  })

  /**
   * ⚠ Raced against a timeout, and a timeout counts as PASSING. Some of these routes do real
   * outbound I/O once they are past the guard — the Stripe webhook verifies a signature with
   * Stripe, the OAuth callbacks redeem a code with the provider — so against no network they
   * hang rather than answer. Hanging inside the handler is proof the guard let the request
   * through, which is the whole of what this asserts. Waiting for the answer would only be
   * asserting that the test machine has no internet.
   */
  it('serves every public route without a token', async () => {
    const refused: string[] = []
    for (const target of targets) {
      if (!isPublicRoute(target.method, target.route)) continue
      const status = await Promise.race([
        probeAnonymously(app, target).then((r: Response) => r.status),
        new Promise<number>(resolve => setTimeout(() => resolve(0), 1000)),
      ])
      // Anything but 401 — these are reached and then judged on their own terms (a 400 for a
      // missing OAuth code, a 422 for an empty login body). 401 would mean the guard bit.
      if (status === 401) refused.push(`${target.method} ${target.route}`)
    }
    expect(refused).toEqual([])
  }, 20_000)

  it('matches on the route pattern, not the request path', () => {
    // A caller-supplied parameter must never be able to spell its way into an exemption.
    expect(isPublicRoute('GET', '/api/invite/:code')).toBe(true)
    expect(isPublicRoute('GET', '/api/invite/anything')).toBe(false)
    expect(isPublicRoute('POST', '/api/auth/login')).toBe(true)
    expect(isPublicRoute('DELETE', '/api/auth/login')).toBe(false) // method is part of the key
  })

  it('fails closed on a missing or malformed route', () => {
    expect(isPublicRoute('GET', undefined)).toBe(false)
    expect(isPublicRoute('GET', '')).toBe(false)
    expect(isPublicRoute(undefined, '/api/auth/login')).toBe(false)
  })
})
