import { describe, it, expect } from 'bun:test'
// Import-pure module (no db/models): this file must never boot Mongoose, as `email-guards.test.ts`.
import {
  EMAIL_RE, RESEND_WINDOW_MS, emailRequestBlock, invoiceEmailSkip, isValidRecipient, mayEmailInvoices, mayEmailOrders, orderEmailAccess,
  orderEmailSkip,
} from 'invoicing-api/src/lib/email-guards'
import * as docEmail from 'config/doc-email'
import { compileLegacy, type CapabilityId, type Grant } from 'config/access'
import { DEFAULT_ROLE_PERMISSIONS, ROLES, type Role } from 'config/constants'

/**
 * Which of a list's ticked documents go by e-mail (2026-11-16): the rule per document.
 *
 * One function decides the preview and the mail request (`lib/doc-email.ts` calls it for both), so the dialog never
 * promises a document the request then refuses. Here it is asked without a server: who, which document, in what
 * state, and in what ORDER the reasons are given, because the order is what keeps a role from learning about a kind
 * of document it does not read.
 */

const caps = (...c: string[]): Grant => ({ caps: new Set(c as CapabilityId[]) })
const legacy = (role: Role) => compileLegacy({ role, permissions: [...DEFAULT_ROLE_PERMISSIONS[role]] })

const SALES = caps('sales-docs.view', 'sales-docs.edit')
const invoice = { direction: 'outgoing', type: 'invoice', status: 'sent' }
const bill = { direction: 'incoming', type: 'invoice', status: 'received' }
const proforma = { direction: 'outgoing', type: 'proforma', status: 'sent' }
const offer = { direction: 'outgoing', type: 'offer', status: 'sent' }

describe('what the single route reads', () => {
  it('is still exported where it was, and the address pattern is the one the dialog reads', () => {
    expect(EMAIL_RE).toBe(docEmail.EMAIL_RE)
    expect(isValidRecipient).toBe(docEmail.isValidRecipient)
    expect(RESEND_WINDOW_MS).toBe(60_000)
    expect(typeof emailRequestBlock).toBe('function')
  })
})

describe('a document of the invoice collection', () => {
  it('an issued document of a kind the session works on goes', () => {
    expect(invoiceEmailSkip({ grant: SALES, invoice })).toBeNull()
    expect(invoiceEmailSkip({ grant: caps('sales-docs.view', 'sales-docs.create'), invoice })).toBeNull()
    expect(invoiceEmailSkip({ grant: { all: true }, invoice: bill })).toBeNull()
  })

  it('no such document, and a kind the session does not read, are the same answer', () => {
    expect(invoiceEmailSkip({ grant: SALES, invoice: null })).toBe('not_found')
    expect(invoiceEmailSkip({ grant: SALES, invoice: undefined })).toBe('not_found')
    // A sales role and a supplier's bill: it is told nothing a missing id would not tell it.
    expect(invoiceEmailSkip({ grant: SALES, invoice: bill })).toBe('not_found')
    expect(invoiceEmailSkip({ grant: SALES, invoice: proforma })).toBe('not_found')
    expect(invoiceEmailSkip({ grant: null, invoice })).toBe('not_found')
  })

  it('a kind the session reads and does not work on is forbidden', () => {
    const reader = caps('sales-docs.view', 'bills.view', 'bills.edit')
    expect(invoiceEmailSkip({ grant: reader, invoice })).toBe('forbidden')
    expect(invoiceEmailSkip({ grant: reader, invoice: bill })).toBeNull()
    // Deleting is not the work mailing is.
    expect(invoiceEmailSkip({ grant: caps('sales-docs.view', 'sales-docs.delete'), invoice })).toBe('forbidden')
  })

  it('an incoming document goes: a bill to the accountant, which the single route never allowed', () => {
    const buyer = caps('bills.view', 'bills.edit')
    expect(invoiceEmailSkip({ grant: buyer, invoice: bill })).toBeNull()
    expect(invoiceEmailSkip({ grant: buyer, invoice: { direction: 'incoming', type: 'credit_note', status: 'received' } })).toBeNull()
    expect(invoiceEmailSkip({ grant: buyer, invoice })).toBe('not_found')
  })

  it('a quote is the proforma kind: the offer and the proforma go by the proforma capabilities', () => {
    const quotes = caps('proforma.view', 'proforma.edit')
    expect(invoiceEmailSkip({ grant: quotes, invoice: proforma })).toBeNull()
    expect(invoiceEmailSkip({ grant: quotes, invoice: offer })).toBeNull()
    expect(invoiceEmailSkip({ grant: quotes, invoice })).toBe('not_found')
  })

  it('every type of the collection is a kind: the till\'s documents and the notes are sales documents', () => {
    for (const type of ['invoice', 'credit_note', 'debit_note', 'cash_sale', 'cash_storno', 'payment_receipt', 'payment_storno']) {
      expect(invoiceEmailSkip({ grant: SALES, invoice: { direction: 'outgoing', type, status: 'paid' } }), type).toBeNull()
    }
  })

  it('a draft does not go, in any kind; every other status does', () => {
    expect(invoiceEmailSkip({ grant: SALES, invoice: { ...invoice, status: 'draft' } })).toBe('draft')
    expect(invoiceEmailSkip({ grant: { all: true }, invoice: { ...bill, status: 'draft' } })).toBe('draft')
    for (const status of ['sent', 'received', 'partially_paid', 'paid', 'overdue', 'voided', 'cancelled', 'converted']) {
      expect(invoiceEmailSkip({ grant: SALES, invoice: { ...invoice, status } }), status).toBeNull()
    }
  })

  it('the double-click window is the last reason given', () => {
    expect(invoiceEmailSkip({ grant: SALES, invoice, recentSend: true })).toBe('just_sent')
    // Each earlier reason wins over it, in order.
    expect(invoiceEmailSkip({ grant: SALES, invoice: { ...invoice, status: 'draft' }, recentSend: true })).toBe('draft')
    expect(invoiceEmailSkip({ grant: caps('sales-docs.view'), invoice: { ...invoice, status: 'draft' }, recentSend: true })).toBe('forbidden')
    expect(invoiceEmailSkip({ grant: caps('bills.view', 'bills.edit'), invoice: { ...invoice, status: 'draft' }, recentSend: true })).toBe('not_found')
    expect(invoiceEmailSkip({ grant: SALES, invoice: null, recentSend: true })).toBe('not_found')
  })

  it('the request is refused only for a session that works on no kind at all', () => {
    expect(mayEmailInvoices(SALES)).toBe(true)
    expect(mayEmailInvoices(caps('bills.view', 'bills.create'))).toBe(true)
    expect(mayEmailInvoices(caps('proforma.edit'))).toBe(true)
    expect(mayEmailInvoices(caps('sales-docs.view', 'proforma.view', 'bills.view', 'sales-docs.export'))).toBe(false)
    expect(mayEmailInvoices(caps('sales-docs.delete'))).toBe(false)
    expect(mayEmailInvoices(null)).toBe(false)
  })

  it('by role, on the legacy model: the roles the single route lets mail, and no read-only one', () => {
    const may = ROLES.filter(role => mayEmailInvoices(legacy(role)))
    for (const role of ['admin', 'manager', 'accountant'] as Role[]) expect(may, role).toContain(role)
    for (const role of ['member', 'nra_auditor'] as Role[]) expect(may, role).not.toContain(role)
    // A role that mails holds the invoicing write, and the other way round.
    for (const role of ROLES) {
      const writes = role === 'admin' || DEFAULT_ROLE_PERMISSIONS[role].includes('invoicing.write')
      expect({ role, may: may.includes(role) }).toEqual({ role, may: writes })
    }
  })
})

describe('a supplier order\'s sheet', () => {
  const user = (...c: string[]) => ({ role: 'member', permissions: [], access: caps(...c) })
  const ALL = orderEmailAccess(user('orders.view', 'orders.edit', 'sales-docs.export'))
  const order = { status: 'sent' }
  const group = { _id: 'g1' }

  it('takes what the sheet\'s export takes, and the work on orders that mailing is', () => {
    expect(ALL).toEqual({ reads: true, exports: true, writes: true })
    expect(mayEmailOrders(ALL)).toBe(true)
    // The page-less reads reach the export route too.
    expect(mayEmailOrders(orderEmailAccess(user('orders.lookup', 'orders.create', 'sales-docs.export')))).toBe(true)
    expect(mayEmailOrders(orderEmailAccess(user('orders.browse', 'orders.edit', 'sales-docs.export')))).toBe(true)
  })

  it('a session the export would answer 403, or that only reads orders, mails none', () => {
    const noExport = orderEmailAccess(user('orders.view', 'orders.edit'))
    const readOnly = orderEmailAccess(user('orders.view', 'sales-docs.export'))
    const noRead = orderEmailAccess(user('orders.edit', 'sales-docs.export'))
    expect([noExport, readOnly, noRead].map(mayEmailOrders)).toEqual([false, false, false])
    expect(mayEmailOrders(orderEmailAccess(null))).toBe(false)
    for (const access of [noExport, readOnly, noRead]) {
      // Forbidden before anything is said about the order: whether it exists is not this session's to learn.
      expect(orderEmailSkip({ access, order, group })).toBe('forbidden')
      expect(orderEmailSkip({ access, order: null, group: undefined })).toBe('forbidden')
    }
  })

  it('no such order, or a group that is not this order\'s, is not found', () => {
    expect(orderEmailSkip({ access: ALL, order: null, group: undefined })).toBe('not_found')
    expect(orderEmailSkip({ access: ALL, order, group: undefined })).toBe('not_found')
    expect(orderEmailSkip({ access: ALL, order, group: null })).toBe('not_found')
  })

  it('a draft does not go; an issued one does, whatever became of it', () => {
    expect(orderEmailSkip({ access: ALL, order: { status: 'draft' }, group })).toBe('draft')
    for (const status of ['sent', 'partially_received', 'received', 'completed', 'cancelled']) {
      expect(orderEmailSkip({ access: ALL, order: { status }, group }), status).toBeNull()
    }
  })

  it('the double-click window is the last reason given', () => {
    expect(orderEmailSkip({ access: ALL, order, group, recentSend: true })).toBe('just_sent')
    expect(orderEmailSkip({ access: ALL, order: { status: 'draft' }, group, recentSend: true })).toBe('draft')
    expect(orderEmailSkip({ access: ALL, order: null, group, recentSend: true })).toBe('not_found')
  })

  it('by role, on the legacy model: an admin and a manager mail orders, a read-only role none', () => {
    const access = (role: Role) => orderEmailAccess({ role, permissions: [...DEFAULT_ROLE_PERMISSIONS[role]] })
    expect(mayEmailOrders(access('admin'))).toBe(true)
    expect(mayEmailOrders(access('manager'))).toBe(true)
    expect(mayEmailOrders(access('member'))).toBe(false)
    expect(mayEmailOrders(access('nra_auditor'))).toBe(false)
  })
})
