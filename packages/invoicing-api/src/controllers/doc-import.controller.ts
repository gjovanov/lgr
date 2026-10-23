/**
 * Document import — one API for every surface that can be fed a PDF or a spreadsheet.
 *
 *   POST /org/:orgId/doc-import/extract    (multipart files[] [+ forceOcr]) → per-file text
 *   POST /org/:orgId/doc-import/analyze    ({ target, items[], context })   → job → AnalyzedDoc[]
 *   GET  /org/:orgId/doc-import/task/:id                                    → job status/result
 *   POST /org/:orgId/doc-import/commit     ({ target, items[] })            → job → created docs
 *   POST /org/:orgId/doc-import/convert    ({ target, ids[] })              → issue/confirm
 *
 * Analysis is a job even for a single file: drafting runs a model and routinely takes ~30s,
 * which is past the point where holding an HTTP request open is reasonable. Clients get a
 * taskId and follow it over the existing `/ws/tasks` socket, polling `task/:id` as a
 * fallback.
 */
import { Elysia, t } from 'elysia'
import { createHash } from 'node:crypto'
import { AppAuthService } from '../auth/app-auth.service.js'
import { config } from 'config'
import { startJob, updateProgress, completeJob, failJob } from 'services/background/task.service'
import { taskStore } from 'services/background/task.store'
import { BackgroundTask, File as FileModel } from 'db/models'
import { ocrExtract, mapWithConcurrency } from 'services/biz/doc-import/ocr-client'
import { toStored } from 'services/biz/files/stored-path'
import { parseSpreadsheet } from 'services/biz/doc-import/xlsx'
import { analyzeDocuments, type AnalyzeItem } from 'services/biz/doc-import/analyze'
import { commitDocuments, type CommitItem } from 'services/biz/doc-import/commit'
import { convertDraftInvoice } from 'services/biz/doc-import/persist'
import { confirmMovement } from 'services/biz/warehouse.service'
import type { ImportTarget } from 'services/biz/doc-import/types'
import { containedJoin, stampedUploadPath } from 'services/biz/files/safe-path'
import { mkdirSync, writeFileSync } from 'node:fs'

/** Uploading and analysing is a write on the surface being imported into. */
const PERMISSION_BY_TARGET: Record<ImportTarget, string> = {
  sales_invoice: 'invoicing.write',
  bill: 'invoicing.write',
  cash_sale: 'invoicing.write',
  movement: 'inventory.write',
}

const TARGETS = ['sales_invoice', 'bill', 'cash_sale', 'movement'] as const

/** Ceiling on one batch. The sidecar drafts serially at ~30s/doc; past this it is a script's job. */
export const MAX_BATCH_FILES = 40

/** Concurrency for the extract stage only — poppler/tesseract, no model involved. */
const EXTRACT_CONCURRENCY = 4

const targetSchema = t.Union(TARGETS.map(v => t.Literal(v)) as any)

/** Files an import accepts. XLSX support is wired per-target as the parsers land. */
function fileKind(name: string): 'pdf' | 'xlsx' | 'unsupported' {
  const lower = (name || '').toLowerCase()
  if (lower.endsWith('.pdf')) return 'pdf'
  if (lower.endsWith('.xlsx') || lower.endsWith('.xls')) return 'xlsx'
  return 'unsupported'
}

/**
 * Read multipart files robustly — Elysia's `t.Files()` validator is brittle, so take
 * whatever it parsed onto `body.files`, else re-parse the form.
 */
async function readUploadedFiles(body: any, request: Request): Promise<File[]> {
  const raw = body?.files
  let files: File[] = raw
    ? (Array.isArray(raw) ? raw : [raw]).filter((f: any) => f && typeof f.arrayBuffer === 'function')
    : []
  if (!files.length) {
    try {
      const form = await request.formData()
      files = form.getAll('files').filter((f): f is File => f instanceof File)
    } catch { /* body stream already consumed */ }
  }
  return files
}

export const docImportController = new Elysia({ prefix: '/org/:orgId/doc-import' })
  .use(AppAuthService)

  // ── Step 1: upload, extract text (synchronous — extraction is fast) ──
  .post(
    '/extract',
    async ({ params: { orgId }, body, request, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })
      const files = await readUploadedFiles(body, request)
      if (!files.length) return status(400, { message: 'No files provided' })
      if (files.length > MAX_BATCH_FILES) {
        return status(400, { message: `At most ${MAX_BATCH_FILES} files per batch (got ${files.length})` })
      }
      const forceOcr = String((body as any)?.forceOcr ?? '') === 'true'

      const dir = containedJoin(config.upload.dir, orgId, 'doc-import')
      mkdirSync(dir, { recursive: true })

      const results = await mapWithConcurrency(files, EXTRACT_CONCURRENCY, async (f) => {
        const kind = fileKind(f.name)
        const buf = Buffer.from(await f.arrayBuffer())
        // ⚠ `f.name` is the caller's: a path in it must never reach the filesystem.
        const storagePath = stampedUploadPath(dir, f.name)
        writeFileSync(storagePath, buf)

        let text = ''
        let method: string | undefined
        let pages: number | undefined
        let parsed: any
        let error: string | undefined

        if (kind === 'pdf') {
          try {
            const extract = await ocrExtract(buf, f.name, { forceOcr })
            text = extract.text
            method = extract.method
            pages = extract.pages
          } catch (e: any) {
            error = String(e?.message || e)
          }
        } else if (kind === 'xlsx') {
          // Spreadsheets never reach the model — they are deterministic layouts with
          // their own validation gates.
          try {
            parsed = await parseSpreadsheet(buf)
            text = parsed.text
            method = 'spreadsheet'
          } catch (e: any) {
            error = String(e?.message || e)
          }
        } else {
          error = 'unsupported file type — upload a PDF or an .xlsx export'
        }

        const fileDoc: any = await FileModel.create({
          orgId,
          uploadedBy: user.id,
          originalName: f.name,
          storagePath: toStored(storagePath), // FR-20.24: relative to the upload root
          storageProvider: 'local',
          mimeType: kind === 'pdf' ? 'application/pdf' : f.type || 'application/octet-stream',
          size: buf.length,
          sha256: createHash('sha256').update(buf).digest('hex'),
          module: 'doc-import',
          aiRecognition: error
            ? { status: 'failed' }
            : { status: 'completed', extractedData: { text, method, pages }, processedAt: new Date() },
        })

        return {
          fileId: String(fileDoc._id),
          filename: f.name,
          kind,
          method,
          pages,
          chars: text.length,
          text,
          parsed,
          error,
        }
      })

      return { files: results }
    },
    { isSignIn: true },
  )

  // ── Step 2: analyze (background job — nothing is persisted) ──
  .post(
    '/analyze',
    async ({ params: { orgId }, body, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })
      const target = body.target as ImportTarget
      const permission = PERMISSION_BY_TARGET[target]
      if (permission && !user.permissions?.includes(permission)) {
        return status(403, { message: `Permission required: ${permission}` })
      }
      if (body.items.length > MAX_BATCH_FILES) {
        return status(400, { message: `At most ${MAX_BATCH_FILES} documents per batch` })
      }

      const task = await startJob(orgId, user.id, 'doc-import-analyze', { target, count: body.items.length })
      const batchId = task.id

      void (async () => {
        try {
          const results = await analyzeDocuments(
            orgId,
            target,
            body.items as AnalyzeItem[],
            body.context || {},
            { createMissingContact: body.options?.createMissingContact !== false, batchId },
            (done, total, label) => updateProgress(task.id, total ? Math.round((done / total) * 100) : 100, label),
          )
          await completeJob(task.id, { batchId, target, results })
        } catch (e: any) {
          await failJob(task.id, String(e?.message || e))
        }
      })()

      return { taskId: task.id, batchId }
    },
    {
      isSignIn: true,
      body: t.Object({
        target: targetSchema,
        items: t.Array(t.Object({
          fileId: t.String(),
          filename: t.Optional(t.String()),
          text: t.Optional(t.String()),
          parsed: t.Optional(t.Any()),
          profile: t.Optional(t.String()),
        })),
        context: t.Optional(t.Object({
          warehouseId: t.Optional(t.String()),
          orderId: t.Optional(t.String()),
          contactId: t.Optional(t.String()),
          movementType: t.Optional(t.String()),
          date: t.Optional(t.String()),
        })),
        options: t.Optional(t.Object({
          createMissingContact: t.Optional(t.Boolean()),
        })),
      }),
    },
  )

  // ── Job status. Falls back to the persisted row when the in-memory store is gone ──
  .get(
    '/task/:taskId',
    async ({ params: { orgId, taskId }, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })
      const live = taskStore.get(taskId)
      if (live && String(live.orgId) === String(orgId)) {
        return {
          status: live.status,
          progress: live.progress,
          logs: live.logs.slice(-20),
          result: live.result,
          error: live.error,
        }
      }
      // A pod restart drops the in-memory task; the BackgroundTask document survives it.
      const doc: any = await BackgroundTask.findOne({ _id: taskId, orgId } as any).lean()
      if (!doc) return status(404, { message: 'Task not found' })
      return {
        status: doc.status,
        progress: doc.progress,
        logs: (doc.logs || []).slice(-20),
        result: doc.result,
        error: doc.error,
      }
    },
    { isSignIn: true },
  )

  // ── Step 3: commit the reviewed mappings (background job) ──
  .post(
    '/commit',
    async ({ params: { orgId }, body, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })
      const target = body.target as ImportTarget
      const permission = PERMISSION_BY_TARGET[target]
      if (permission && !user.permissions?.includes(permission)) {
        return status(403, { message: `Permission required: ${permission}` })
      }

      const task = await startJob(orgId, user.id, 'doc-import-commit', { target, count: body.items.length })
      void (async () => {
        try {
          const results = await commitDocuments(
            orgId,
            user.id,
            target,
            body.items as CommitItem[],
            (done, total, label) => updateProgress(task.id, total ? Math.round((done / total) * 100) : 100, label),
          )
          await completeJob(task.id, {
            target,
            results,
            created: results.filter(r => r.ok).length,
            failed: results.filter(r => !r.ok).length,
          })
        } catch (e: any) {
          await failJob(task.id, String(e?.message || e))
        }
      })()

      return { taskId: task.id }
    },
    {
      isSignIn: true,
      body: t.Object({
        target: targetSchema,
        items: t.Array(t.Object({
          fileId: t.Optional(t.String()),
          mapped: t.Any(),
          extraMovements: t.Optional(t.Array(t.Any())),
          options: t.Optional(t.Object({
            convert: t.Optional(t.Boolean()),
            adjustStock: t.Optional(t.Boolean()),
            createMissingProducts: t.Optional(t.Boolean()),
            allowDuplicate: t.Optional(t.Boolean()),
          })),
        })),
      }),
    },
  )

  // ── Step 4: issue drafts / confirm movements ──
  .post(
    '/convert',
    async ({ params: { orgId }, body, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })
      const target = (body.target || 'bill') as ImportTarget
      const permission = PERMISSION_BY_TARGET[target]
      if (permission && !user.permissions?.includes(permission)) {
        return status(403, { message: `Permission required: ${permission}` })
      }
      const results: any[] = []
      for (const id of body.ids) {
        try {
          if (target === 'movement') {
            // Confirming is what writes stock — the movement equivalent of issuing a draft.
            const m = await confirmMovement(id)
            results.push({ id, ok: true, invoiceNumber: (m as any)?.movementNumber, status: (m as any)?.status })
          } else {
            results.push({ id, ...(await convertDraftInvoice(orgId, id, user.id, { adjustStock: body.adjustStock !== false })) })
          }
        } catch (e: any) {
          results.push({ id, ok: false, error: String(e?.message || e) })
        }
      }
      return { results, converted: results.filter(r => r.ok).length }
    },
    {
      isSignIn: true,
      body: t.Object({
        target: t.Optional(targetSchema),
        ids: t.Array(t.String()),
        adjustStock: t.Optional(t.Boolean()),
      }),
    },
  )
