import { httpClient } from 'ui-shared/composables/useHttpClient'
import { orgPath, type ListPage } from './org-path'

/** `api/src/warehouse/controllers/warehouse.controller.ts`, `/org/:orgId/warehouse/warehouse`. */
const BASE = '/warehouse/warehouse'

/** The four kinds the create and update schemas accept. */
export type WarehouseType = 'warehouse' | 'store' | 'production' | 'transit'

export interface WarehouseAddress {
  street?: string
  city?: string
  state?: string
  postalCode?: string
  country?: string
}

/** A warehouse as the routes answer it (the repository's entity). A record written before the schema may hold its address as text. */
export interface Warehouse {
  _id: string
  id: string
  code: string
  name: string
  type: WarehouseType
  address?: WarehouseAddress | string
  manager?: string
  managerId?: string
  isDefault: boolean
  /** Another site's warehouse, named for transfers. It keeps no stock in this organization. */
  isExternal?: boolean
  isActive: boolean
  tags?: string[]
}

/** The body of `POST /`, as its schema declares it. */
export interface WarehouseCreateBody {
  name: string
  code: string
  type: WarehouseType
  address?: WarehouseAddress | string
  manager?: string
  managerId?: string
  isDefault?: boolean
  isExternal?: boolean
  isActive?: boolean
  tags?: string[]
}

/** The body of `PUT /:id`: every field of the create, each optional. */
export type WarehouseUpdateBody = Partial<WarehouseCreateBody>

export interface WarehouseListParams {
  search?: string
  tags?: string
  page?: number
  size?: number
  /**
   * ⚠ Unasked, the route answers only the warehouses that keep stock. `include` answers the external ones too (the
   * Warehouses page, the movement form and the movements filter), `only` those alone.
   */
  external?: 'include' | 'only'
}

export async function listWarehouses(params?: WarehouseListParams): Promise<ListPage & { warehouses: Warehouse[] }> {
  const { data } = await httpClient.get(orgPath(BASE), { params })
  return data
}

export async function getWarehouse(id: string): Promise<{ warehouse: Warehouse }> {
  const { data } = await httpClient.get(orgPath(`${BASE}/${id}`))
  return data
}

export async function createWarehouse(body: WarehouseCreateBody): Promise<{ warehouse: Warehouse }> {
  const { data } = await httpClient.post(orgPath(BASE), body)
  return data
}

export async function updateWarehouse(id: string, body: WarehouseUpdateBody): Promise<{ warehouse: Warehouse }> {
  const { data } = await httpClient.put(orgPath(`${BASE}/${id}`), body)
  return data
}

/** Deactivates it (the route keeps the record). */
export async function deleteWarehouse(id: string): Promise<{ message: string }> {
  const { data } = await httpClient.delete(orgPath(`${BASE}/${id}`))
  return data
}
