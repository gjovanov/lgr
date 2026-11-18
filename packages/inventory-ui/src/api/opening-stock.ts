import { httpClient } from 'ui-shared/composables/useHttpClient'
import { orgPath } from './org-path'

/** `warehouse-api/src/controllers/opening-stock.controller.ts`, `/org/:orgId/warehouse/opening-stock`. */
const BASE = '/warehouse/opening-stock'

/**
 * Uploads a spreadsheet of opening quantities for one warehouse; the import runs as a background task. The form is
 * multipart: the route reads `file` and `warehouseId` from it, so it has no body schema (`unit/write-route-bodies`).
 * An external warehouse is refused (422 `external_warehouse`).
 */
export async function startOpeningStockImport(file: File, warehouseId: string): Promise<{ taskId: string; rows: number }> {
  const fd = new FormData()
  fd.append('file', file)
  fd.append('warehouseId', warehouseId)
  // The browser sets the multipart boundary itself: the client's JSON content type is taken off.
  const { data } = await httpClient.post(orgPath(BASE), fd, { headers: { 'Content-Type': undefined } })
  return data
}

/** The task's state; `result` once it completed, `error` once it failed. */
export interface OpeningStockStatus {
  status: string
  progress?: number
  result?: Record<string, unknown>
  error?: string
}

export async function getOpeningStockStatus(taskId: string): Promise<OpeningStockStatus> {
  const { data } = await httpClient.get(orgPath(`${BASE}/status/${taskId}`))
  return data
}
