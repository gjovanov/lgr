/**
 * Why the API refused a movement, a bill made from receipts or a bill's receiving, in the user's language (#168).
 *
 * The services answer in English with a `code`, and whatever the refusal names beside it
 * (`movementNumber`). The screens that show one of these codes show this sentence; any other refusal
 * shows the API's message, as before. `unit/stock-refusals.test.ts` holds the list to the codes the
 * server sends.
 */
export const STOCK_REFUSAL_CODES = [
  'dispatch_with_to_warehouse',
  'receipt_with_from_warehouse',
  'receipt_without_supplier',
  'receipt_not_a_delivery',
  'supplier_not_found',
  'supplier_mismatch',
  'mixed_suppliers',
  'receipt_already_billed',
  'bill_not_empty',
  'bill_on_order',
  'bill_not_draft',
  'bill_already_linked',
  'nothing_to_bill',
  'stock_line_without_product',
  'stock_line_without_warehouse',
] as const

type Translate = (key: string, params?: Record<string, unknown>) => string

export function stockRefusalMessage(e: any, t: Translate): string {
  const body = e?.response?.data
  const code = body?.code
  if (typeof code === 'string' && (STOCK_REFUSAL_CODES as readonly string[]).includes(code)) {
    return t(`warehouse.refusals.${code}`, body)
  }
  return body?.message || e?.message || t('common.operationFailed')
}
