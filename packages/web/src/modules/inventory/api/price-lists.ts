import { httpClient } from 'ui-shared/composables/useHttpClient'
import { orgPath } from './org-path'

/** `warehouse-api/src/controllers/price-list.controller.ts`, `/org/:orgId/warehouse/price-list`. */
const BASE = '/warehouse/price-list'

export interface PriceListItem {
  productId: string
  price: number
  minQuantity?: number
  discount?: number
}

/** A price list as the routes answer it (the repository's entity). */
export interface PriceList {
  _id: string
  id: string
  name: string
  currency: string
  isDefault?: boolean
  validFrom?: string
  validTo?: string
  items: PriceListItem[]
  isActive: boolean
}

/**
 * The body of `POST /` and `PUT /:id`. Their schemas take any object (`clientCreate` / `clientUpdate` then hold it to
 * the model, FR-32.18), so these are the model's fields the form sends. An empty date is sent as `''`, as the form
 * always sent it.
 */
export interface PriceListBody {
  name: string
  currency: string
  validFrom?: string
  validTo?: string
  isActive?: boolean
  items: PriceListItem[]
}

export async function getPriceList(id: string): Promise<{ priceList: PriceList }> {
  const { data } = await httpClient.get(orgPath(`${BASE}/${id}`))
  return data
}

export async function createPriceList(body: PriceListBody): Promise<{ priceList: PriceList }> {
  const { data } = await httpClient.post(orgPath(BASE), body)
  return data
}

export async function updatePriceList(id: string, body: PriceListBody): Promise<{ priceList: PriceList }> {
  const { data } = await httpClient.put(orgPath(`${BASE}/${id}`), body)
  return data
}

/** Deactivates it (the route keeps the record). */
export async function deletePriceList(id: string): Promise<{ message: string }> {
  const { data } = await httpClient.delete(orgPath(`${BASE}/${id}`))
  return data
}
