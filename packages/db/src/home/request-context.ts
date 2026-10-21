import { AsyncLocalStorage } from 'node:async_hooks'

/**
 * The request a write is made in, as far as the write guard needs to know (FR-20.4/FR-20.6, plan
 * step P0b-4): is it a READ-ONLY route, which org it is for, and is it a listed "read that writes".
 *
 * A read-only route that writes anyway is how a mirror becomes a second writer — printing a
 * document on a mirror must never allocate a number (FR-20.6). The write guard therefore looks at
 * this context on every write:
 * - the route is in `GET_WRITERS` (`services/biz/route-class.ts`): the write is expected — each
 *   such writer checks the home itself;
 * - otherwise, when the request's org is not home here: refused;
 * - otherwise (home): logged once per route, and the route-table test fails on it. Refusing there
 *   too would turn an unlisted write on some path no test reached into a production outage.
 *
 * ⚠ Under Bun, entered from an Elysia hook only SYNCHRONOUSLY (`onTransform`), never after an
 * `await`: a store entered in an async continuation is not seen by the handler. And it outlives the
 * request in its own execution context (a test that calls `app.handle()` and then writes directly
 * would inherit it), so `leaveRequest` resets it once the response is sent. Measured; see #169.
 */
export interface RequestContext {
  readOnly: boolean
  /** `METHOD /path` as the route table spells it. */
  route: string
  orgId?: string
  /** In `GET_WRITERS`: a read that is known, and allowed, to write. */
  listedWriter: boolean
}

const storage = new AsyncLocalStorage<RequestContext | null>()

export function enterRequest(ctx: RequestContext): void {
  storage.enterWith(ctx)
}

export function leaveRequest(): void {
  storage.enterWith(null)
}

export function currentRequest(): RequestContext | null {
  return storage.getStore() ?? null
}

/** Run `fn` as if inside a request. For tests and for code that replays a request's work. */
export function runInRequest<T>(ctx: RequestContext, fn: () => Promise<T>): Promise<T> {
  return storage.run(ctx, fn)
}

/**
 * Writes seen inside read-only requests, by route — `model.op` names. The route-table test reads it
 * to assert that only the listed routes write; in production it is what the warning reports.
 */
export const readOnlyWrites = new Map<string, Set<string>>()

export function noteReadOnlyWrite(ctx: RequestContext, what: string): void {
  let set = readOnlyWrites.get(ctx.route)
  if (!set) readOnlyWrites.set(ctx.route, (set = new Set()))
  set.add(what)
}
