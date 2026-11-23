import { httpClient } from 'ui-shared/composables/useHttpClient'
import { orgPath } from './org-path'

/**
 * FR-28.7 / FR-28.9: an article's suppliers (`warehouse-api/src/controllers/product-supplier.controller.ts`). What
 * the documents say is read; what a person recorded is written, a supplier at a time.
 */

/** A supplier the documents name: the last purchase, how much was bought, in how many documents. */
export interface SupplierFact {
  supplierId: string
  supplierName: string
  lastPurchasedAt: string
  /** Left out for a caller who may not see costs (FR-28.6). */
  lastUnitPrice?: number
  currency?: string
  quantity: number
  documents: number
  lastDocument: { kind: 'bill' | 'receipt'; id: string; number: string }
}

/** What a person recorded about a supplier of the article. */
export interface RecordedSupplier {
  supplierId: string
  supplierName: string
  supplierActive: boolean
  preferred: boolean
  supplierSku?: string
  leadTimeDays?: number
  note?: string
}

/** One of the last documents behind the facts. */
export interface SupplierDocument {
  kind: 'bill' | 'receipt'
  id: string
  number: string
  date: string
  supplierId: string
  supplierName: string
  quantity: number
  unitPrice?: number
  currency?: string
}

/** `GET /warehouse/product-supplier/:productId`; a role that reads no bills is refused (403). */
export async function getProductSuppliers(productId: string): Promise<{ suppliers: SupplierFact[]; documents: SupplierDocument[]; recorded: RecordedSupplier[] }> {
  const { data } = await httpClient.get(orgPath(`/warehouse/product-supplier/${productId}`))
  return data
}

/**
 * The body of `PUT /warehouse/product/:id/suppliers/:supplierId`, as its schema declares it: the recorded fields,
 * replaced as a whole. `null` or left out clears one.
 */
export interface RecordedSupplierBody {
  preferred?: boolean
  supplierSku?: string | null
  leadTimeDays?: number | null
  note?: string | null
}

const recordPath = (productId: string, supplierId: string) => orgPath(`/warehouse/product/${productId}/suppliers/${supplierId}`)

/** Records a supplier of the article, or replaces what is recorded. A refusal names its `code`. */
export async function recordSupplier(productId: string, supplierId: string, body: RecordedSupplierBody): Promise<{ supplier: RecordedSupplier }> {
  const { data } = await httpClient.put(recordPath(productId, supplierId), body)
  return data
}

/** Clears what is recorded. A supplier the documents name stays listed with its facts. */
export async function clearRecordedSupplier(productId: string, supplierId: string): Promise<{ deleted: boolean }> {
  const { data } = await httpClient.delete(recordPath(productId, supplierId))
  return data
}
