import { httpClient } from 'ui-shared/composables/useHttpClient'
import { orgPath, type ListPage } from './org-path'

/** `warehouse-api/src/controllers/movement.controller.ts`, `/org/:orgId/warehouse/movement`: a contact's movements. */
const BASE = '/warehouse/movement'

/** A movement as the list answers it: the entity without its lines, with the names the grid shows. */
export interface StockMovementRow {
  _id: string
  id: string
  movementNumber: string
  /** The movement's number again, as the grid's column reads it. */
  number: string
  type: string
  status: string
  date: string
  reference?: string
  fromWarehouseName: string
  toWarehouseName: string
  contactName: string
  lineCount: number
  /** Its lines' costs summed. Left out for a role without the cost figures (FR-27.11.C.2). */
  total?: number
}

export interface ContactMovementsQuery {
  contactId: string
  page: number
  size: number
}

/** The query is written as the contact form's dialog always wrote it, in this order. */
export async function listContactMovements(q: ContactMovementsQuery): Promise<ListPage & { stockMovements: StockMovementRow[] }> {
  const params = new URLSearchParams({ contactId: q.contactId, page: String(q.page), size: String(q.size) })
  const { data } = await httpClient.get(orgPath(`${BASE}?${params.toString()}`))
  return data
}
