import { Elysia } from 'elysia'
import { AppAuthService } from '../auth/app-auth.service.js'
import { mongoose } from 'db/connection'
import {
  storeDocuments,
  listDocuments,
  getVersions,
  resolveDownload,
  ocrDocument,
  runCompareForSnapshot,
} from 'services/biz/files/doc-store.service'
import { analyzeDocFile, commitDocFile } from 'services/biz/files/doc-pipeline.service'
import { reconcileDocFile } from 'services/biz/files/doc-reconcile.service'
import { queryAuditLogs } from 'services/biz/audit-log.service'
import { t } from 'elysia'

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
      // Auto-diff: a freshly-uploaded storeAvailability snapshot is compared to the live catalog
      // + stock and the CSV/TXT dumped into its date folder — the headline requirement.
      const compareBy: Record<string, any> = {}
      for (const r of results) {
        if (r.docFile.docType === 'store_availability' && !r.duplicate) {
          try { compareBy[String(r.docFile._id)] = (await runCompareForSnapshot(orgId, user!.id, String(r.docFile._id))).summary }
          catch (e) { compareBy[String(r.docFile._id)] = { error: (e as Error).message } }
        }
      }
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
          compare: compareBy[String(r.docFile._id)],
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

  // ── OCR a stored PDF → extract text, refine type, resolve date, move out of inbox ─────
  .post(
    '/:id/ocr',
    async ({ params: { orgId, id }, user, status }) => {
      const denied = gate(user, status); if (denied) return denied
      try {
        const r = await ocrDocument(orgId, user!.id, id)
        return { skipped: r.skipped, method: r.method, chars: r.chars, docKind: (r as any).docKind, docType: r.docFile.docType, docDate: r.docFile.docDate, status: r.docFile.status }
      } catch (e) { return status(422, { message: (e as Error).message }) }
    },
    { isSignIn: true },
  )

  // ── Re-run the storeAvailability auto-diff for a stored snapshot (dumps CSV/TXT beside it) ─
  .post(
    '/:id/compare',
    async ({ params: { orgId, id }, user, status }) => {
      const denied = gate(user, status); if (denied) return denied
      try { const res = await runCompareForSnapshot(orgId, user!.id, id); return { summary: res.summary, warehouse: res.warehouse, rows: res.rows.slice(0, 200) } }
      catch (e) { return status(422, { message: (e as Error).message }) }
    },
    { isSignIn: true },
  )

  // ── OCR-if-needed → analyze via the doc-import engine → persist the mapped form + diagnostics ─
  .post(
    '/:id/analyze',
    async ({ params: { orgId, id }, user, status }) => {
      const denied = gate(user, status); if (denied) return denied
      try {
        const { target, analyzed } = await analyzeDocFile(orgId, user!.id, id)
        return {
          target, docKind: analyzed.docKind, direction: (analyzed as any).direction, uncertain: (analyzed as any).uncertain,
          duplicate: analyzed.duplicate, validation: (analyzed as any).validation,
          lines: analyzed.diagnostics?.perLine || [], warnings: analyzed.diagnostics?.warnings || [],
          error: (analyzed as any).error,
          mapped: analyzed.mapped, extraMovements: (analyzed as any).extraMovements,
        }
      } catch (e) { return status(422, { message: (e as Error).message }) }
    },
    { isSignIn: true },
  )

  // ── Commit the stored analysis via the engine (book stock / issue doc), stamp the DocFile ────
  .post(
    '/:id/commit',
    async ({ params: { orgId, id }, body, user, status }) => {
      const denied = gate(user, status); if (denied) return denied
      try {
        const b: any = body || {}
        const result = await commitDocFile(orgId, user!.id, id, { convert: b.convert, adjustStock: b.adjustStock, allowDuplicate: b.allowDuplicate })
        if (!result?.ok) return status(422, { message: result?.error || 'Commit failed', ...result })
        return result
      } catch (e) { return status(422, { message: (e as Error).message }) }
    },
    { isSignIn: true, body: t.Optional(t.Object({ convert: t.Optional(t.Boolean()), adjustStock: t.Optional(t.Boolean()), allowDuplicate: t.Optional(t.Boolean()) })) },
  )

  // ── Idempotent create/update/DELETE reconcile of a re-uploaded MOVEMENT doc. DRY-RUN by ──────
  //    default; `?execute=true` books the compensating delta and verifies each product's stock.
  .post(
    '/:id/reconcile',
    async ({ params: { orgId, id }, query, user, status }) => {
      const denied = gate(user, status); if (denied) return denied
      try { return await reconcileDocFile(orgId, user!.id, id, { execute: query.execute === 'true' }) }
      catch (e) { return status(422, { message: (e as Error).message }) }
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
