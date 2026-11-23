/**
 * Batch OCR → draft purchase invoices. **Legacy surface, kept verbatim.**
 *   POST /org/:orgId/bills/import/extract  (multipart files[] + warehouseId) → per-file OCR text
 *   POST /org/:orgId/bills/import/draft    ({ warehouseId, items[] }) → background job → draft bills
 *   POST /org/:orgId/bills/import/convert  ({ invoiceIds[] }) → receive (post + move stock)
 *
 * The UI moved to `/org/:orgId/doc-import/*`, but all five migration CLI skills drive THESE
 * paths against the deployed API, so the request/response shapes must not drift. The
 * mapping, persistence and OCR calls are now the shared `services/biz/doc-import` engine —
 * this module is only the old envelope around it.
 */
import { Elysia, t } from 'elysia'
import { createHash } from 'node:crypto'
import { AppAuthService } from '../auth/app-auth.service.js'
import { config } from 'config'
import { startJob, updateProgress, completeJob, failJob } from 'services/background/task.service'
import { File as FileModel } from 'db/models'
import { ocrExtract, ocrDraft } from 'services/biz/doc-import/ocr-client'
import { toStored } from 'services/biz/files/stored-path'
import { createDraftInvoice, convertDraftInvoice } from '../lib/bill-import.js'
import { containedJoin, stampedUploadPath } from 'services/biz/files/safe-path'
import { mkdirSync, writeFileSync } from 'node:fs'

export const billImportController = new Elysia({ prefix: '/org/:orgId/bills/import' })
  .use(AppAuthService)

  // ── Step 1: upload PDFs, extract text (synchronous — extraction is fast) ──
  .post(
    '/extract',
    async ({ params: { orgId }, body, request, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })
      // Read multipart files robustly — Elysia's t.Files() validator is brittle,
      // so we take whatever it parsed onto body.files, else re-parse the form.
      const raw = (body as any)?.files
      let files: File[] = raw ? (Array.isArray(raw) ? raw : [raw]).filter((f: any) => f && typeof f.arrayBuffer === 'function') : []
      if (!files.length) {
        try {
          const form = await request.formData()
          files = form.getAll('files').filter((f): f is File => f instanceof File)
        } catch { /* body stream already consumed */ }
      }
      if (!files.length) return status(400, { message: 'No PDF files provided' })
      const dir = containedJoin(config.upload.dir, orgId, 'bill-ocr')
      mkdirSync(dir, { recursive: true })

      const results: any[] = []
      for (const f of files) {
        const buf = Buffer.from(await f.arrayBuffer())
        // ⚠ `f.name` is the caller's: a path in it must never reach the filesystem.
        const storagePath = stampedUploadPath(dir, f.name)
        writeFileSync(storagePath, buf)
        let extract: { text: string; method: string; pages: number } | undefined
        let error: string | undefined
        try {
          extract = await ocrExtract(buf, f.name, { orgId })
        } catch (e: any) {
          error = String(e?.message || e)
        }
        const fileDoc: any = await FileModel.create({
          orgId,
          uploadedBy: user.id,
          originalName: f.name,
          storagePath: toStored(storagePath), // FR-20.24: relative to the upload root
          storageProvider: 'local',
          mimeType: 'application/pdf',
          size: buf.length,
          sha256: createHash('sha256').update(buf).digest('hex'),
          module: 'bill-ocr',
          aiRecognition: extract
            ? { status: 'completed', extractedData: { text: extract.text, method: extract.method, pages: extract.pages }, processedAt: new Date() }
            : { status: 'failed' },
        })
        results.push({ fileId: String(fileDoc._id), filename: f.name, method: extract?.method, pages: extract?.pages, chars: extract?.text?.length ?? 0, text: extract?.text ?? '', error })
      }
      return { files: results }
    },
    { isSignIn: true },
  )

  // ── Step 2: draft bills from (possibly edited) text — background job ──
  .post(
    '/draft',
    async ({ params: { orgId }, body, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })
      const uid = user.id
      const items = body.items
      const warehouseId = body.warehouseId
      const task = await startJob(orgId, uid, 'bill-ocr-draft', { count: items.length, warehouseId })
      const batchId = task.id

      void (async () => {
        const created: any[] = []
        try {
          for (let i = 0; i < items.length; i++) {
            const it = items[i]
            await updateProgress(task.id, Math.round((i / items.length) * 100), `Drafting bill ${i + 1}/${items.length}`)
            try {
              const draft = await ocrDraft(it.text, undefined, { orgId })
              const { invoice, contact, perLine, direction, uncertain, orderGroupMatched } = await createDraftInvoice(orgId, uid, draft, warehouseId, batchId, it.text, { orderId: body.orderId })
              created.push({
                fileId: it.fileId,
                invoiceId: invoice.id,
                invoiceNumber: invoice.invoiceNumber,
                direction,
                uncertain,
                contact: contact?.name ?? null,
                contactCreated: contact?.created ?? false,
                validation: draft.validation?.status,
                lines: perLine.length,
                matched: perLine.filter(p => p.matched).length,
                orderGroupMatched,
              })
            } catch (e: any) {
              created.push({ fileId: it.fileId, error: String(e?.message || e) })
            }
          }
          await completeJob(task.id, { batchId, created })
        } catch (e: any) {
          await failJob(task.id, String(e?.message || e))
        }
      })()

      return { taskId: task.id, batchId }
    },
    {
      isSignIn: true,
      body: t.Object({
        warehouseId: t.String(),
        // ORD-aware import: match lines against this order's supplier group and
        // split received quantities across its warehouse allocations.
        orderId: t.Optional(t.String()),
        items: t.Array(t.Object({ fileId: t.String(), text: t.String() })),
      }),
    },
  )

  // ── Step 3: convert selected/all drafts → received (posts + moves stock) ──
  .post(
    '/convert',
    async ({ params: { orgId }, body, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })
      const results: any[] = []
      for (const id of body.invoiceIds) {
        try {
          results.push({ invoiceId: id, ...(await convertDraftInvoice(orgId, id, user.id, { adjustStock: body.adjustStock !== false })) })
        } catch (e: any) {
          results.push({ invoiceId: id, ok: false, error: String(e?.message || e) })
        }
      }
      return { results, converted: results.filter(r => r.ok).length }
    },
    { isSignIn: true, body: t.Object({ invoiceIds: t.Array(t.String()), adjustStock: t.Optional(t.Boolean()) }) },
  )
