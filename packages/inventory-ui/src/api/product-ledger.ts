import { httpClient } from 'ui-shared/composables/useHttpClient'
import { orgPath } from './org-path'

/** A row of an article's ledger (`services/biz/product-ledger.service.ts#ProductLedgerEntry`). */
export interface ProductLedgerEntry {
  date: string
  documentRef: string
  documentId: string
  documentType: 'movement' | 'inventory_count'
  eventType: string
  warehouseId: string
  warehouseName: string
  contactId?: string
  contactName?: string
  quantityChange: number
  /** The costs are left out for a role without the cost figures (FR-27.11.C.1). */
  unitCost?: number
  lineTotalCost?: number
  startQty: number
  endQty: number
  runningQty: number
  runningValue?: number
  invoiceId?: string
  invoiceNumber?: string
  reference?: string
  movementType?: string
}

/**
 * The ledger's totals (`ProductLedgerResult['summary']`). ⚠ `currentValue` is absent for a role without the cost
 * figures (the route takes it off); the page shows it only to a role that has them.
 */
export interface ProductLedgerSummary {
  totalIn: number
  totalOut: number
  currentQty: number
  currentValue: number
  totalCashRegisterSales: number
  totalInvoiceSales: number
  totalSales: number
}

/** Filters, sort and page as the route reads them: text, as the address carries them. */
export interface ProductLedgerParams {
  page?: string
  size?: string
  warehouseId?: string
  dateFrom?: string
  dateTo?: string
  contactId?: string
  /** Comma-separated. */
  eventTypes?: string
  sortBy?: string
  sortOrder?: string
}

/** `GET /warehouse/product-ledger/:productId` (`warehouse-api/src/controllers/product-ledger.controller.ts`). */
export async function getProductLedger(
  productId: string,
  params: ProductLedgerParams,
): Promise<{ entries: ProductLedgerEntry[]; total: number; page: number; size: number; totalPages: number; summary: ProductLedgerSummary }> {
  const { data } = await httpClient.get(orgPath(`/warehouse/product-ledger/${productId}`), { params })
  return data
}
