import { httpClient } from 'ui-shared/composables/useHttpClient'
import { orgPath, type ListPage } from './org-path'

/** `warehouse-api/src/controllers/product-category.controller.ts`, `/org/:orgId/warehouse/product-category`. */
const BASE = '/warehouse/product-category'

/** A category as the list answers it (the repository's entity). */
export interface ProductCategory {
  _id: string
  id: string
  name: string
  description?: string
  parentId?: string
  sortOrder: number
  isActive: boolean
}

export interface ProductCategoryListParams {
  /** The route's own page is 100; 0 is every category. */
  size?: number
}

export async function listProductCategories(params: ProductCategoryListParams): Promise<ListPage & { productCategories: ProductCategory[] }> {
  const { data } = await httpClient.get(orgPath(BASE), { params })
  return data
}
