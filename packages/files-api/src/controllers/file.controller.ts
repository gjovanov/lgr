import { Elysia } from 'elysia'
import { AppAuthService } from '../auth/app-auth.service.js'
import { mongoose } from 'db/connection'
import {
  storeDocuments,
  listDocuments,
  getVersions,
  resolveDownload,
} from 'services/biz/files/doc-store.service'
import { queryAuditLogs } from 'services/biz/audit-log.service'

/**
 * Files app (#7) — Phase 1: the versioned, audited document store. Gated on `admin.settings`
 * (admin + manager). The `isSignIn` macro does not actually reject anonymous callers on these
 * app controllers (verified on reports), so every handler does an explicit auth+permission gate.
 */

const MAX_BATCH = 60

/** Explicit auth + `admin.settings` gate. Returns a 401/403 Response to short-circuit, or null. */
function gate(user: any, status: any) {
  if (!user) return status(401, { message: 'Unauthorized' })
  if (user.role !== 'admin' && !user.permissions?.includes('admin.settings')) {
    return status(403, { message: 'Administrator access required' })
  }
  return null
}

/** Elysia's `t.Files()` validator is brittle — take what it parsed, else re-parse the form. */
async function readUploadedFiles(body: any, request: Request): Promise<File[]> {
  const raw = body?.files
  let files: File[] = Array.isArray(raw) ? raw : raw ? [raw] : []
  files = files.filter((f): f is File => f instanceof File)
  if (!files.length) {
    try {
      const form = await request.formData()
      files = form.getAll('files').filter((f): f is File => f instanceof File)
    } catch { /* not multipart */ }
  }
  return files
}

export const filesController = new Elysia({ prefix: '/org/:orgId/files' })
  .use(AppAuthService)

  // ── Batch upload → versioned PV store ─────────────────────────────────────────────
  .post(
    '/upload',
    async ({ params: { orgId }, body, request, user, status }) => {
      const denied = gate(user, status); if (denied) return denied
      const files = await readUploadedFiles(body, request)
      if (!files.length) return status(400, { message: 'No files provided' })
      if (files.length > MAX_BATCH) return status(400, { message: `At most ${MAX_BATCH} files per batch (got ${files.length})` })
      const correlationId = new mongoose.Types.ObjectId().toString()
      const results = await storeDocuments(orgId, user!.id, files, {
        correlationId,
        ip: request.headers.get('x-forwarded-for') || undefined,
        ua: request.headers.get('user-agent') || undefined,
      })
      return {
        correlationId,
        results: results.map((r) => ({
          name: r.name,
          docFileId: String(r.docFile._id),
          docType: r.docFile.docType,
          docNumber: r.docFile.docNumber,
          docDate: r.docFile.docDate,
          version: r.docFile.version,
          status: r.docFile.status,
          outcome: r.duplicate ? 'duplicate' : r.isNew ? 'created' : `overwrote v${r.replacedVersion}`,
        })),
      }
    },
    { isSignIn: true },
  )

  // ── List documents (filters) ──────────────────────────────────────────────────────
  .get(
    '/',
    async ({ params: { orgId }, query, user, status }) => {
      const denied = gate(user, status); if (denied) return denied
      return listDocuments(orgId, {
        docType: query.docType, docDate: query.docDate, status: query.status, search: query.search,
        page: query.page ? Number(query.page) : 0, size: query.size ? Number(query.size) : 50,
      })
    },
    { isSignIn: true },
  )

  // ── Version history for a document ──────────────────────────────────────────────────
  .get(
    '/:id/versions',
    async ({ params: { orgId, id }, user, status }) => {
      const denied = gate(user, status); if (denied) return denied
      return getVersions(orgId, id)
    },
    { isSignIn: true },
  )

  // ── Download the current canonical file, or a named archived version ────────────────
  .get(
    '/:id/download',
    async ({ params: { orgId, id }, query, user, status, set }) => {
      const denied = gate(user, status); if (denied) return denied
      const hit = await resolveDownload(orgId, id, query.version)
      if (!hit) return status(404, { message: 'Not found' })
      const file = Bun.file(hit.path)
      if (!(await file.exists())) return status(404, { message: 'File missing on disk' })
      set.headers['content-disposition'] = `attachment; filename="${encodeURIComponent(hit.name)}"`
      set.headers['content-type'] = hit.mime || 'application/octet-stream'
      return file
    },
    { isSignIn: true },
  )

  // ── Upload / overwrite / reconcile audit trail (compact list; detailed = full changes[]) ─
  .get(
    '/audit',
    async ({ params: { orgId }, query, user, status }) => {
      const denied = gate(user, status); if (denied) return denied
      return queryAuditLogs(orgId, {
        module: 'files', action: query.action, entityType: query.entityType,
        dateFrom: query.dateFrom, dateTo: query.dateTo,
        page: query.page ? Number(query.page) : 0, size: query.size ? Number(query.size) : 50,
      })
    },
    { isSignIn: true },
  )
