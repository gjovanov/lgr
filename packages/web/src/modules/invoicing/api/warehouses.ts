import { httpClient } from 'ui-shared/composables/useHttpClient'
import { orgPath, type ListPage } from './org-path'

/** `api/src/warehouse/controllers/warehouse.controller.ts`, `/org/:orgId/warehouse/warehouse`: the pickers' list. */
const BASE = '/warehouse/warehouse'

/** A warehouse as the list answers it (the repository's entity): what the pickers name and choose it by. */
export interface Warehouse {
  _id: string
  id: string
  code: string
  name: string
  type: string
  isDefault: boolean
  isActive: boolean
  /** Another site's warehouse, named for transfers. Unasked, the list answers only the ones that keep stock. */
  isExternal?: boolean
}

export interface WarehouseListParams {
  page?: number
  /** 0 is every warehouse. */
  size?: number
}

export async function listWarehouses(params?: WarehouseListParams): Promise<ListPage & { warehouses: Warehouse[] }> {
  const { data } = await httpClient.get(orgPath(BASE), { params })
  return data
}
