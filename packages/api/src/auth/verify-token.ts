import { Elysia } from 'elysia'
import jwt from '@elysiajs/jwt'
import { config } from 'config'

/**
 * Verify a JWT from somewhere that is not an HTTP route — a WebSocket message, say.
 *
 * ## Why this exists
 *
 * `AuthService` gets its verifier from the `@elysiajs/jwt` plugin, which reaches a handler
 * through the route context. A WebSocket handler has no such context: `setupFiscalBridgeWS` is
 * handed the raw app, the upgrade is mounted outside `createApiApp()`, and the credential arrives
 * in the socket's first *message* rather than in a header the plugin could read.
 *
 * ⚠ It is the **same plugin with the same secret**, deliberately, rather than a second JWT
 * implementation. A socket that verified tokens differently from the routes — a different
 * algorithm allow-list, a different clock skew, a different idea of what an expired token is —
 * is exactly the kind of divergence that ends with one surface accepting what the other refuses.
 * The only thing taken from the plugin is its verifier; no Elysia instance is served.
 */
const verifier = (new Elysia().use(jwt({ name: 'jwt', secret: config.jwt.secret })) as any).decorator.jwt

/**
 * The claims of a valid token, or `false`.
 *
 * ⚠ It returns `false` — not `null`, not a throw — for every invalid token, matching the
 * plugin's own contract. Callers must test the result, because `false` is falsy but an empty
 * payload object would not be.
 */
export async function verifyToken(token: unknown): Promise<Record<string, any> | false> {
  if (typeof token !== 'string' || !token) return false
  try {
    const payload = await verifier.verify(token)
    return payload && typeof payload === 'object' ? (payload as Record<string, any>) : false
  } catch {
    // A malformed token throws rather than returning false in some jose paths. Either way it
    // is not a credential.
    return false
  }
}
