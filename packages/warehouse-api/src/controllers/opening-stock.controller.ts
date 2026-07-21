/**
 * Opening-stock import: POST /org/:orgId/warehouse/opening-stock
 *   multipart: file=<storeAvailability.xlsx>, warehouseId=<id>
 * Sets the warehouse's stock levels from the file (background job + WS progress).
 */
import { Elysia } from 'elysia'
import { AppAuthService } from '../auth/app-auth.service.js'
import { startJob, updateProgress, completeJob, failJob } from 'services/background/task.service'
import { BackgroundTask } from 'db/models'
import { parseOpeningStock, applyOpeningStock } from '../lib/opening-stock.js'

export const openingStockController = new Elysia({ prefix: '/org/:orgId/warehouse/opening-stock' })
  .use(AppAuthService)
  .post(
    '/',
    async ({ params: { orgId }, body, request, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })
      const b: any = body
      let file: File | undefined = b?.file
      let warehouseId = b?.warehouseId ? String(b.warehouseId) : ''
      if (!file || !warehouseId) {
        try {
          const form = await request.formData()
          const f = form.get('file')
          if (f instanceof File) file = f
          warehouseId = warehouseId || String(form.get('warehouseId') || '')
        } catch { /* body already parsed */ }
      }
      if (!file || !warehouseId) return status(400, { message: 'file and warehouseId are required' })

      const buf = Buffer.from(await file.arrayBuffer())
      const rows = await parseOpeningStock(buf)
      const uid = user.id
      const task = await startJob(orgId, uid, 'opening-stock', { rows: rows.length, warehouseId })

      void (async () => {
        try {
          const result = await applyOpeningStock(orgId, warehouseId, rows, uid, async i => {
            await updateProgress(task.id, Math.round((i / Math.max(rows.length, 1)) * 100), `Setting stock ${i}/${rows.length}`)
          })
          await completeJob(task.id, result)
        } catch (e: any) {
          await failJob(task.id, String(e?.message || e))
        }
      })()

      return { taskId: task.id, rows: rows.length }
    },
    { isSignIn: true },
  )
  .get(
    '/status/:taskId',
    async ({ params: { orgId, taskId }, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })
      const task: any = await BackgroundTask.findOne({ _id: taskId, orgId } as any).lean()
      if (!task) return status(404, { message: 'Task not found' })
      return { status: task.status, progress: task.progress, result: task.result, error: task.error }
    },
    { isSignIn: true },
  )
