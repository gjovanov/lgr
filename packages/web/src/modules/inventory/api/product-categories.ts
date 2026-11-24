import { httpClient } from 'ui-shared/composables/useHttpClient'
import { orgPath, type ListPage } from './org-path'

/** `api/src/warehouse/controllers/product-category.controller.ts`, `/org/:orgId/warehouse/product-category`. */
const BASE = '/warehouse/product-category'

/** A category as the routes answer it (the repository's entity). */
export interface ProductCategory {
  _id: string
  id: string
  name: string
  description?: string
  icon?: string
  color?: string
  parentId?: string
  sortOrder: number
  isActive: boolean
  isSystem?: boolean
}

/** The body of `POST /`, as its schema declares it. */
export interface ProductCategoryCreateBody {
  name: string
  description?: string
  icon?: string
  color?: string
  sortOrder?: number
  isActive?: boolean
}

/** The body of `PUT /:id`: the same fields, each optional. */
export type ProductCategoryUpdateBody = Partial<ProductCategoryCreateBody>

export interface ProductCategoryListParams {
  search?: string
  /** `'true'` or `'false'`: the route compares the text. */
  isActive?: 'true' | 'false'
  page?: number
  /** The route's own page is 100; 0 is every category. */
  size?: number
}

export async function listProductCategories(params?: ProductCategoryListParams): Promise<ListPage & { productCategories: ProductCategory[] }> {
  const { data } = await httpClient.get(orgPath(BASE), { params })
  return data
}

export async function getProductCategory(id: string): Promise<{ productCategory: ProductCategory }> {
  const { data } = await httpClient.get(orgPath(`${BASE}/${id}`))
  return data
}

export async function createProductCategory(body: ProductCategoryCreateBody): Promise<{ productCategory: ProductCategory }> {
  const { data } = await httpClient.post(orgPath(BASE), body)
  return data
}

export async function updateProductCategory(id: string, body: ProductCategoryUpdateBody): Promise<{ productCategory: ProductCategory }> {
  const { data } = await httpClient.put(orgPath(`${BASE}/${id}`), body)
  return data
}

/** Deactivates it; a system category, or one an article uses, is refused (400). */
export async function deleteProductCategory(id: string): Promise<{ message: string }> {
  const { data } = await httpClient.delete(orgPath(`${BASE}/${id}`))
  return data
}
