/**
 * FR-23 — what the person at the counter reads when a payment's receipt is refused or does not
 * print. The server's own message is English and names no way out; these are the org's language.
 *
 * Import-pure: the payment dialog, the issue flow and a unit test read it.
 */

/** A refusal's message key, or null when it is none of the receipt's and the server's text will do. */
export function receiptRefusalKey(data: { code?: string; noSession?: boolean; deviceConfigured?: boolean } | null | undefined): string | null {
  switch (data?.code) {
    case 'fiscal_device_not_connected':
      if (data.noSession) return 'cashRegister.receipt.noSession'
      return data.deviceConfigured === false ? 'pos.printerRequired.notConfigured' : 'pos.printerRequired.notConnected'
    case 'payment_in_progress': return 'cashRegister.receipt.inProgress'
    case 'document_claimed': return 'cashRegister.receipt.documentClaimed'
    case 'document_changed': return 'cashRegister.receipt.documentChanged'
    case 'fiscally_paid': return 'cashRegister.receipt.fiscallyPaid'
    case 'receipt_currency': return 'cashRegister.receipt.currency'
    case 'receipt_not_printable': return 'cashRegister.receipt.notPrintable'
    case 'document_not_issued': return 'cashRegister.receipt.notIssued'
    case 'no_receipt_owed': return 'cashRegister.receipt.noneOwed'
    case 'receipt_in_doubt': return 'cashRegister.receipt.inDoubtRefused'
    case 'storno_in_doubt': return 'cashRegister.receipt.stornoInDoubtRefused'
    case 'receipt_open_on_device': return 'cashRegister.receipt.openOnDevice'
    case 'sale_receipt_in_doubt': return 'cashRegister.receipt.saleInDoubtRefused'
    case 'receipt_number_required': return 'cashRegister.receipt.numberRequired'
    case 'receipt_number_taken': return 'cashRegister.receipt.numberTaken'
    case 'delivery_receipt_owed': return 'cashRegister.receipt.deliveryOwed'
    case 'receipts_unfinished': return 'cashRegister.receipt.unfinished'
    default: return null
  }
}

/** Whether the answer says the print failed, so that a second press is a retry worth offering. */
export function isFailedPrint(data: { code?: string } | null | undefined): boolean {
  return data?.code === 'fiscal_error'
}

/** The receipts a refusal names: the one in doubt, or the ones a session cannot close over. */
export function receiptRefusalParams(data: { receipt?: { number?: string }; document?: string; receipts?: Array<{ number?: string | null; invoice?: string }> } | null | undefined): { number: string; numbers: string } {
  const numbers = (data?.receipts ?? []).map(r => r.number ?? r.invoice ?? '').filter(Boolean).join(', ')
  return { number: data?.receipt?.number ?? data?.document ?? '', numbers }
}

/** The message for a refused request: the receipt's own, the server's, or `fallback`. */
export function receiptRefusalMessage(t: (key: string, params?: Record<string, unknown>) => string, e: any, fallback: string): string {
  const data = e?.response?.data
  const key = receiptRefusalKey(data)
  return key ? t(key, receiptRefusalParams(data)) : data?.message || fallback
}
