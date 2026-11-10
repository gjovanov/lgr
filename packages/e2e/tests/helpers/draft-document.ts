import { expect } from '@playwright/test'
import { apiLogin, apiGet, apiPost } from './api'

/**
 * A draft document of the kind a document form edits, made through the API: a one-line service
 * document for the seeded customer (outgoing) or supplier (incoming). The seed has no proformas,
 * so a spec that needs one makes it here.
 *
 * Nothing is deleted afterwards: the specs run against a seeded throwaway database, and a draft
 * is what the lists already hold.
 */
export interface DraftDocument {
  id: string
  invoiceNumber: string
  contact: any
}

export async function draftDocument(
  type: 'invoice' | 'proforma',
  direction: 'incoming' | 'outgoing',
  description = `E2E draft ${Date.now().toString(36)}`,
): Promise<DraftDocument> {
  const session = await apiLogin()
  const side = direction === 'incoming' ? 'supplier' : 'customer'
  const { contacts } = await apiGet(session, `/invoicing/contact?type=${side}&size=1`)
  expect(contacts?.[0], `a seeded ${side}`).toBeTruthy()
  const res = await apiPost(session, '/invoices', {
    type,
    direction,
    contactId: contacts[0]._id,
    issueDate: new Date().toISOString().split('T')[0],
    currency: 'EUR',
    exchangeRate: 1,
    paymentMethod: 'bank_transfer',
    lines: [{ description, quantity: 1, unit: 'pcs', unitPrice: 100, discount: 0, taxRate: 20, taxAmount: 20, lineTotal: 120 }],
    subtotal: 100,
    discountTotal: 0,
    taxTotal: 20,
    total: 120,
  })
  expect(res.status, `setup ${direction} ${type}: ${res.status}`).toBeLessThan(300)
  const { invoice } = await res.json()
  return { id: String(invoice.id || invoice._id), invoiceNumber: invoice.invoiceNumber, contact: contacts[0] }
}
