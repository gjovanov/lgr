import { Elysia } from 'elysia'
import { AppAuthService } from '../auth/app-auth.service.js'
import { mongoose } from 'db/connection'
import {
  storeDocuments,
  listDocuments,
  listDatesSummary,
  getVersions,
  resolveDownload,
  ocrDocument,
  runCompareForSnapshot,
} from 'services/biz/files/doc-store.service'
import { analyzeDocFile, commitDocFile, analyzeDocFilesBatch, commitDocFilesBatch, ocrDocFilesBatch, storedAnalyses } from 'services/biz/files/doc-pipeline.service'
import { deleteDocFiles } from 'services/biz/files/doc-delete.service'
import { reconcileDocFile } from 'services/biz/files/doc-reconcile.service'
import { queryAuditLogs } from 'services/biz/audit-log.service'
import { startJob, updateProgress, completeJob, failJob } from 'services/background/task.service'
import { taskStore } from 'services/background/task.store'
import { BackgroundTask } from 'db/models'
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
      // The UI uploads a day folder at a time and knows its date; a PDF cannot derive one
      // from its filename, so without this every PDF would sit in "inbox" until OCR.
      const bodyDate = (body as any)?.docDate
      const docDate = typeof bodyDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(bodyDate) ? bodyDate : undefined
      const results = await storeDocuments(orgId, user!.id, files, {
        correlationId,
        docDate,
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

  // ── Batch OCR (own step; analyze also does it on demand) ──────────────────────────
  .post(
    '/ocr-batch',
    async ({ params: { orgId }, body, user, status }) => {
      const denied = gate(user, status); if (denied) return denied
      const b: any = body || {}
      const ids: string[] = Array.isArray(b.docFileIds) ? b.docFileIds : []
      if (!ids.length) return status(400, { message: 'docFileIds required' })
      if (ids.length > MAX_BATCH) return status(400, { message: `At most ${MAX_BATCH} documents per batch (got ${ids.length})` })
      const task = await startJob(orgId, user!.id, 'files-ocr-batch', { count: ids.length })
      void (async () => {
        try {
          const results = await ocrDocFilesBatch(orgId, user!.id, ids, { force: b.force },
            (d, tot, label) => updateProgress(task.id, tot ? Math.round((d / tot) * 100) : 100, `${d}/${tot} ${label}`))
          await completeJob(task.id, { results })
        } catch (e: any) { await failJob(task.id, String(e?.message || e)) }
      })()
      return { taskId: task.id }
    },
    { isSignIn: true, body: t.Object({ docFileIds: t.Array(t.String()), force: t.Optional(t.Boolean()) }) },
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

  // ── Per-date roll-up for the grouped Documents view (one aggregation) ───────────────
  .get(
    '/dates',
    async ({ params: { orgId }, query, user, status }) => {
      const denied = gate(user, status); if (denied) return denied
      return listDatesSummary(orgId, { docType: query.docType, status: query.status, search: query.search })
    },
    { isSignIn: true },
  )

  // ── Batch analyze (selection) — ONE job over N docs, 4-way, batched writes → per-doc summary ─
  .post(
    '/analyze-batch',
    async ({ params: { orgId }, body, user, status }) => {
      const denied = gate(user, status); if (denied) return denied
      const b: any = body || {}
      const ids: string[] = Array.isArray(b.docFileIds) ? b.docFileIds : []
      if (!ids.length) return status(400, { message: 'docFileIds required' })
      if (ids.length > MAX_BATCH) return status(400, { message: `At most ${MAX_BATCH} documents per batch (got ${ids.length})` })
      const task = await startJob(orgId, user!.id, 'files-analyze-batch', { count: ids.length })
      void (async () => {
        try {
          const results = await analyzeDocFilesBatch(orgId, user!.id, ids, { force: !!b.force },
            (d, tot, label) => updateProgress(task.id, tot ? Math.round((d / tot) * 100) : 100, `${d}/${tot} ${label}`))
          await completeJob(task.id, { results })
        } catch (e: any) { await failJob(task.id, String(e?.message || e)) }
      })()
      return { taskId: task.id }
    },
    { isSignIn: true, body: t.Object({ docFileIds: t.Array(t.String()), force: t.Optional(t.Boolean()) }) },
  )

  // ── Batch commit (selection) — ONE job, serial (stock-safe), batched stamps → per-doc result ─
  .post(
    '/commit-batch',
    async ({ params: { orgId }, body, user, status }) => {
      const denied = gate(user, status); if (denied) return denied
      const b: any = body || {}
      const ids: string[] = Array.isArray(b.docFileIds) ? b.docFileIds : []
      if (!ids.length) return status(400, { message: 'docFileIds required' })
      if (ids.length > MAX_BATCH) return status(400, { message: `At most ${MAX_BATCH} documents per batch (got ${ids.length})` })
      const task = await startJob(orgId, user!.id, 'files-commit-batch', { count: ids.length })
      void (async () => {
        try {
          const results = await commitDocFilesBatch(orgId, user!.id, ids, { convert: b.convert, adjustStock: b.adjustStock, allowDuplicate: b.allowDuplicate },
            (d, tot, label) => updateProgress(task.id, tot ? Math.round((d / tot) * 100) : 100, `${d}/${tot} ${label}`))
          await completeJob(task.id, { results })
        } catch (e: any) { await failJob(task.id, String(e?.message || e)) }
      })()
      return { taskId: task.id }
    },
    { isSignIn: true, body: t.Object({ docFileIds: t.Array(t.String()), convert: t.Optional(t.Boolean()), adjustStock: t.Optional(t.Boolean()), allowDuplicate: t.Optional(t.Boolean()) }) },
  )

  // ── Read back the stored review rows for a selection or a whole date. Runs NO engine: opening
  //    the review must never re-analyze or cost a sidecar call. Every status is included. ────────
  .post(
    '/analysis',
    async ({ params: { orgId }, body, user, status }) => {
      const denied = gate(user, status); if (denied) return denied
      const b: any = body || {}
      const ids: string[] = Array.isArray(b.docFileIds) ? b.docFileIds : []
      if (!ids.length && !b.docDate) return status(400, { message: 'docFileIds or docDate required' })
      return { results: await storedAnalyses(orgId, { docFileIds: ids, docDate: b.docDate, docType: b.docType, status: b.status }) }
    },
    {
      isSignIn: true,
      body: t.Object({
        docFileIds: t.Optional(t.Array(t.String())),
        docDate: t.Optional(t.String()), docType: t.Optional(t.String()), status: t.Optional(t.String()),
      }),
    },
  )

  // ── Batch delete + rollback (selection). DRY-RUN unless `execute` — it returns the manifest of
  //    what would be voided / reversed / deactivated / deleted plus the resulting stock impact. ──
  .post(
    '/delete-batch',
    async ({ params: { orgId }, body, user, status }) => {
      const denied = gate(user, status); if (denied) return denied
      const b: any = body || {}
      const ids: string[] = Array.isArray(b.docFileIds) ? b.docFileIds : []
      if (!ids.length) return status(400, { message: 'docFileIds required' })
      if (ids.length > MAX_BATCH) return status(400, { message: `At most ${MAX_BATCH} documents per batch (got ${ids.length})` })
      const task = await startJob(orgId, user!.id, 'files-delete-batch', { count: ids.length, execute: !!b.execute })
      void (async () => {
        try {
          const result = await deleteDocFiles(orgId, user!.id, ids,
            { rollback: b.rollback !== false, removeProducts: !!b.removeProducts, force: !!b.force, execute: !!b.execute },
            (d, tot, label) => updateProgress(task.id, tot ? Math.round((d / tot) * 100) : 100, `${d}/${tot} ${label}`))
          await completeJob(task.id, result as any)
        } catch (e: any) { await failJob(task.id, String(e?.message || e)) }
      })()
      return { taskId: task.id }
    },
    {
      isSignIn: true,
      body: t.Object({
        docFileIds: t.Array(t.String()),
        rollback: t.Optional(t.Boolean()), removeProducts: t.Optional(t.Boolean()),
        force: t.Optional(t.Boolean()), execute: t.Optional(t.Boolean()),
      }),
    },
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

  // ── OCR-if-needed → analyze via the engine (BACKGROUND JOB — the sidecar draft can take ~50s,
  //    well past the front proxy's read timeout). Returns a taskId; poll GET /task/:taskId. ──────
  .post(
    '/:id/analyze',
    async ({ params: { orgId, id }, user, status }) => {
      const denied = gate(user, status); if (denied) return denied
      const task = await startJob(orgId, user!.id, 'files-analyze', { docFileId: id })
      void (async () => {
        try {
          const { target, analyzed } = await analyzeDocFile(orgId, user!.id, id)
          await completeJob(task.id, {
            target, docKind: analyzed.docKind, direction: (analyzed as any).direction, uncertain: (analyzed as any).uncertain,
            duplicate: analyzed.duplicate, validation: (analyzed as any).validation,
            lines: analyzed.diagnostics?.perLine || [], warnings: analyzed.diagnostics?.warnings || [],
            error: (analyzed as any).error, mapped: analyzed.mapped, extraMovements: (analyzed as any).extraMovements,
          })
        } catch (e: any) { await failJob(task.id, String(e?.message || e)) }
      })()
      return { taskId: task.id }
    },
    { isSignIn: true },
  )

  // ── Commit the stored analysis (book stock / issue doc). BACKGROUND JOB → taskId. ─────────────
  .post(
    '/:id/commit',
    async ({ params: { orgId, id }, body, user, status }) => {
      const denied = gate(user, status); if (denied) return denied
      const b: any = body || {}
      const task = await startJob(orgId, user!.id, 'files-commit', { docFileId: id })
      void (async () => {
        try {
          const result = await commitDocFile(orgId, user!.id, id, { convert: b.convert, adjustStock: b.adjustStock, allowDuplicate: b.allowDuplicate })
          await completeJob(task.id, result)
        } catch (e: any) { await failJob(task.id, String(e?.message || e)) }
      })()
      return { taskId: task.id }
    },
    { isSignIn: true, body: t.Optional(t.Object({ convert: t.Optional(t.Boolean()), adjustStock: t.Optional(t.Boolean()), allowDuplicate: t.Optional(t.Boolean()) })) },
  )

  // ── Idempotent create/update/DELETE reconcile of a re-uploaded MOVEMENT doc. DRY-RUN unless
  //    `?execute=true`. BACKGROUND JOB (re-analysis hits the slow sidecar) → taskId. ─────────────
  .post(
    '/:id/reconcile',
    async ({ params: { orgId, id }, query, user, status }) => {
      const denied = gate(user, status); if (denied) return denied
      const execute = query.execute === 'true'
      const task = await startJob(orgId, user!.id, 'files-reconcile', { docFileId: id, execute })
      void (async () => {
        try { await completeJob(task.id, await reconcileDocFile(orgId, user!.id, id, { execute })) }
        catch (e: any) { await failJob(task.id, String(e?.message || e)) }
      })()
      return { taskId: task.id }
    },
    { isSignIn: true },
  )

  // ── Job status (analyze/commit/reconcile). Falls back to the persisted row after a pod restart ─
  .get(
    '/task/:taskId',
    async ({ params: { orgId, taskId }, user, status }) => {
      const denied = gate(user, status); if (denied) return denied
      const live = taskStore.get(taskId)
      if (live && String(live.orgId) === String(orgId)) {
        return { status: live.status, progress: live.progress, logs: live.logs.slice(-20), result: live.result, error: live.error }
      }
      const doc: any = await BackgroundTask.findOne({ _id: taskId, orgId } as any).lean()
      if (!doc) return status(404, { message: 'Task not found' })
      return { status: doc.status, progress: doc.progress, logs: (doc.logs || []).slice(-20), result: doc.result, error: doc.error }
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
