import { Elysia } from 'elysia'
import { nodeRole } from 'config'
import { NodeError, loadActiveNode, verifyNodeToken } from 'services/biz/node/node.service'
import { isPublicRoute } from 'services/biz/public-routes'
import type { IServerNode } from 'db/models'

/**
 * Authentication for `/api/node/v1/*`, the routes whose principal is a registered MASTER, not a
 * user or a desktop (FR-20.2, plan step P2-1). Built like `DesktopAuth`, for its reasons:
 *
 * - ⚠ **An unconditional `onBeforeHandle`, never a macro a route opts into.** Nothing about a route
 *   turns the check on, so nothing can turn it off; the only way out is `public-routes.ts`.
 * - ⚠ **The row is the revocation list.** `loadActiveNode` re-reads it on every request, so a node
 *   taken off its last org, or registered again with a new key, is refused on its next call
 *   whatever its token's remaining life.
 * - **Global only.** A master registers nodes nowhere: every route here is 404 on one, before any
 *   credential is looked at.
 */
export const NodeAuth = new Elysia({ name: 'Service.NodeAuth' })
  .derive({ as: 'scoped' }, async ({ headers }) => {
    if (nodeRole() !== 'global') return { node: null as IServerNode | null, nodeError: null as NodeError | null }
    const raw = headers.authorization
    const token = raw?.startsWith('Bearer ') ? raw.slice(7) : raw
    const claims = verifyNodeToken(token)
    if (!claims) return { node: null as IServerNode | null, nodeError: null as NodeError | null }
    try {
      return { node: await loadActiveNode(claims), nodeError: null as NodeError | null }
    } catch (e) {
      // Carried, so the guard answers `node_revoked` or `key_rotated`: the master deletes its
      // registration on the first and only re-authenticates on the second.
      return { node: null as IServerNode | null, nodeError: e instanceof NodeError ? e : null }
    }
  })
  .onBeforeHandle({ as: 'scoped' }, ({ node, nodeError, status, request, route }) => {
    if (nodeRole() !== 'global') return status(404, { message: 'Not found' })
    if (node) return
    if (nodeError) return status(nodeError.statusCode, { code: nodeError.code, message: nodeError.message })
    // Fails CLOSED: an unexpected route value makes everything non-public.
    if (!isPublicRoute(request.method, route)) {
      return status(401, { code: 'unauthenticated', message: 'A server credential is required.' })
    }
  })
