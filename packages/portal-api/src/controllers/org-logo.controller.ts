import { Elysia } from 'elysia'
import { AuthService } from '../auth/auth.service.js'
import { createAuditEntry } from 'services/biz/audit-log.service'
import {
  OrgLogoError,
  deleteOrgLogo,
  getOrgLogoBytes,
  getOrgLogoMeta,
  saveOrgLogo,
} from 'services/biz/org-logo.service'

/**
 * The tenant's letterhead: upload, serve, remove.
 *
 * Serving the bytes from an endpoint (rather than inlining them on the org record) keeps the
 * org document small and lets the browser cache the image forever — the URL carries the content
 * hash, so a replaced logo is simply a different URL.
 */

/**
 * Read the single uploaded file. Elysia's `t.File()` validator is brittle with multipart bodies
 * (same reason `doc-import.controller.ts` re-parses), so take whatever it managed to put on the
 * body and fall back to parsing the form ourselves.
 */
async function readUploadedFile(body: any, request: Request): Promise<File | null> {
  const raw = body?.file ?? body?.logo
  if (raw && typeof raw.arrayBuffer === 'function') return raw as File
  try {
    const form = await request.formData()
    const found = form.get('file') ?? form.get('logo')
    return found instanceof File ? found : null
  } catch {
    // Body stream already consumed by the validator — nothing more we can do.
    return null
  }
}

export const orgLogoController = new Elysia({ prefix: '/org/:orgId/logo' })
  .use(AuthService)

  // ── Upload / replace ──
  .post(
    '/',
    async ({ params: { orgId }, body, request, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })
      if (user.role !== 'admin') return status(403, { message: 'Admin only' })

      const file = await readUploadedFile(body, request)
      if (!file) return status(400, { message: 'No file provided' })

      const buf = Buffer.from(await file.arrayBuffer())
      try {
        const meta = await saveOrgLogo(orgId, buf, file.type, user.id)

        createAuditEntry({
          orgId,
          userId: user.id,
          operatorCode: user.operatorCode,
          action: 'update',
          module: 'admin',
          entityType: 'organization-logo',
          entityId: orgId,
          entityName: file.name,
        })

        return { logo: meta }
      } catch (e: any) {
        if (e instanceof OrgLogoError) return status(e.statusCode, { message: e.message })
        throw e
      }
    },
    { isSignIn: true },
  )

  // ── Serve ──
  .get('/', async ({ params: { orgId }, request, user, status, set }) => {
    if (!user) return status(401, { message: 'Unauthorized' })

    const meta = await getOrgLogoMeta(orgId)
    // 404 is the "this org uses the bundled logo" answer — the UI shows its placeholder.
    if (!meta) return status(404, { message: 'No logo' })

    const etag = `"${meta.hash}"`
    if (request.headers.get('if-none-match') === etag) {
      set.status = 304
      set.headers['etag'] = etag
      return new Response(null, { status: 304, headers: { etag } })
    }

    const full = await getOrgLogoBytes(orgId)
    if (!full) return status(404, { message: 'No logo' })

    set.headers['content-type'] = full.mimeType
    set.headers['etag'] = etag
    // Immutable: the URL changes whenever the bytes do (?v=<hash>).
    set.headers['cache-control'] = 'private, max-age=31536000, immutable'
    return new Response(full.data)
  }, { isSignIn: true })

  // ── Remove ──
  .delete('/', async ({ params: { orgId }, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    if (user.role !== 'admin') return status(403, { message: 'Admin only' })

    const removed = await deleteOrgLogo(orgId)
    if (!removed) return status(404, { message: 'No logo' })

    createAuditEntry({
      orgId,
      userId: user.id,
      operatorCode: user.operatorCode,
      action: 'delete',
      module: 'admin',
      entityType: 'organization-logo',
      entityId: orgId,
    })

    return { message: 'Logo removed' }
  }, { isSignIn: true })
