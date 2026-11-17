import { describe, it, expect } from 'bun:test'
// Import-pure module (no db/models): this file must never boot Mongoose, as `email-guards.test.ts`.
import {
  EMAIL_RE, RESEND_WINDOW_MS, emailRequestBlock, internalOrderEmailAccess, internalOrderEmailSkip, invoiceEmailSkip, isValidRecipient,
  mayEmailInternalOrders, mayEmailInvoices, mayEmailOrders, orderEmailAccess, orderEmailSkip,
} from 'invoicing-api/src/lib/email-guards'
import * as docEmail from 'config/doc-email'
import { accessRuleFor, templateGrant, type CapabilityId, type Grant } from 'config/access'
import { ROLES, type Role } from 'config/constants'

/**
 * Which of a list's ticked documents go by e-mail (2026-11-16): the rule per document.
 *
 * One function decides the preview and the mail request (`lib/doc-email.ts` calls it for both), so the dialog never
 * promises a document the request then refuses. Here it is asked without a server: who, which document, in what
 * state, and in what ORDER the reasons are given, because the order is what keeps a role from learning about a kind
 * of document it does not read.
 */

const caps = (...c: string[]): Grant => ({ caps: new Set(c as CapabilityId[]) })
/** A built-in role's grant (FR-27 P3-6: the legacy model is gone; the templates are its access, pinned). */
const legacy = (role: Role) => templateGrant(role)

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

  it('by built-in role: the roles that write sales documents, and no read-only one', () => {
    const may = ROLES.filter(role => mayEmailInvoices(legacy(role)))
    for (const role of ['admin', 'manager', 'accountant'] as Role[]) expect(may, role).toContain(role)
    for (const role of ['member', 'nra_auditor'] as Role[]) expect(may, role).not.toContain(role)
    expect([...may].sort()).toEqual(['accountant', 'admin', 'manager', 'sales', 'sales_consultant', 'seller'])
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

  it('by built-in role: an admin and a manager mail orders, a read-only role none', () => {
    const access = (role: Role) => orderEmailAccess({ id: 'u', access: templateGrant(role) })
    expect(mayEmailOrders(access('admin'))).toBe(true)
    expect(mayEmailOrders(access('manager'))).toBe(true)
    expect(mayEmailOrders(access('member'))).toBe(false)
    expect(mayEmailOrders(access('nra_auditor'))).toBe(false)
  })
})

describe('a customer order\'s sheet', () => {
  const user = (...c: string[]) => ({ role: 'member', permissions: [], access: caps(...c) })
  const ALL = internalOrderEmailAccess(user('orders.view', 'orders.edit', 'sales-docs.export'))
  const order = { status: 'confirmed' }
  // The sessions that mail none: each lacks one of the three things the request takes.
  const readOnly = internalOrderEmailAccess(user('orders.view', 'sales-docs.export'))
  const noExport = internalOrderEmailAccess(user('orders.view', 'orders.create', 'orders.edit'))
  const noRead = internalOrderEmailAccess(user('orders.create', 'orders.edit', 'sales-docs.export'))

  it('takes what the sheet\'s export takes, and the work on orders that mailing is', () => {
    expect(ALL).toEqual({ reads: true, exports: true, writes: true })
    expect(mayEmailInternalOrders(ALL)).toBe(true)
    expect(mayEmailInternalOrders(internalOrderEmailAccess(user('orders.view', 'orders.create', 'sales-docs.export')))).toBe(true)
    expect(mayEmailInternalOrders(internalOrderEmailAccess({ role: 'admin', permissions: [], access: { all: true } }))).toBe(true)
    // The read asked is the one the sheet's export route is reached by, and no other.
    const rule = accessRuleFor('GET', 'invoicing/internal-orders/:id/export') as { anyOf?: readonly string[] }
    expect(rule.anyOf).toEqual(['orders.view'])
  })

  it('is read by orders.view alone: the page-less reads that reach a SUPPLIER order do not reach it', () => {
    for (const read of ['orders.browse', 'orders.lookup']) {
      const who = user(read, 'orders.edit', 'sales-docs.export')
      expect(internalOrderEmailAccess(who), read).toEqual({ reads: false, exports: true, writes: true })
      expect(mayEmailInternalOrders(internalOrderEmailAccess(who)), read).toBe(false)
      // The supplier orders' rule is as it was: neither kind was widened or narrowed to the other.
      expect(mayEmailOrders(orderEmailAccess(who)), read).toBe(true)
    }
  })

  it('a role that reads and does not write, and one that writes and may not export, mail none', () => {
    expect(readOnly).toEqual({ reads: true, exports: true, writes: false })
    expect(noExport).toEqual({ reads: true, exports: false, writes: true })
    expect(noRead).toEqual({ reads: false, exports: true, writes: true })
    expect([readOnly, noExport, noRead].map(mayEmailInternalOrders)).toEqual([false, false, false])
    // Deleting an order is not the work mailing is; nobody signed in holds nothing.
    expect(mayEmailInternalOrders(internalOrderEmailAccess(user('orders.view', 'orders.delete', 'sales-docs.export')))).toBe(false)
    expect(internalOrderEmailAccess(null)).toEqual({ reads: false, exports: false, writes: false })
    expect(mayEmailInternalOrders(internalOrderEmailAccess(undefined))).toBe(false)
    for (const access of [readOnly, noExport, noRead]) {
      // Forbidden before anything is said about the order: whether it exists is not this session's to learn.
      expect(internalOrderEmailSkip({ access, order })).toBe('forbidden')
      expect(internalOrderEmailSkip({ access, order: null })).toBe('forbidden')
      expect(internalOrderEmailSkip({ access, order: { status: 'draft' } })).toBe('forbidden')
    }
  })

  it('no such order in this org is not found', () => {
    expect(internalOrderEmailSkip({ access: ALL, order: null })).toBe('not_found')
    expect(internalOrderEmailSkip({ access: ALL, order: undefined })).toBe('not_found')
  })

  it('a draft does not go: it has no number yet, and its sheet says so', () => {
    expect(internalOrderEmailSkip({ access: ALL, order: { status: 'draft' } })).toBe('draft')
  })

  it('every other status goes, and a CANCELLED order with them', () => {
    for (const status of ['confirmed', 'partially_delivered', 'delivered', 'completed', 'cancelled']) {
      expect(internalOrderEmailSkip({ access: ALL, order: { status } }), status).toBeNull()
    }
    // ⚠ Not to be "aligned" with the stock movements, which skip a cancelled one (`movementEmailSkip`): a cancelled
    // movement moved nothing, so its sheet says nothing true. A cancelled ORDER's sheet is titled as cancelled, and
    // telling the client so is what the mail is for. The reason `cancelled` is never an order's.
    expect(docEmail.DOC_EMAIL_BLOCKS).toContain('cancelled')
    expect(internalOrderEmailSkip({ access: ALL, order: { status: 'cancelled' } })).not.toBe('cancelled')
    expect(internalOrderEmailSkip({ access: ALL, order: { status: 'cancelled' }, recentSend: true })).toBe('just_sent')
  })

  it('the reasons in their sequence: forbidden, not found, a draft, and the double-click window last', () => {
    expect(internalOrderEmailSkip({ access: ALL, order, recentSend: true })).toBe('just_sent')
    // Each earlier reason wins over the ones after it.
    expect(internalOrderEmailSkip({ access: ALL, order: { status: 'draft' }, recentSend: true })).toBe('draft')
    expect(internalOrderEmailSkip({ access: ALL, order: null, recentSend: true })).toBe('not_found')
    expect(internalOrderEmailSkip({ access: readOnly, order: null, recentSend: true })).toBe('forbidden')
    expect(internalOrderEmailSkip({ access: noExport, order: { status: 'draft' }, recentSend: true })).toBe('forbidden')
    expect(internalOrderEmailSkip({ access: noRead, order, recentSend: true })).toBe('forbidden')
  })

  it('by built-in role: the roles that work on orders and may print, and no read-only one', () => {
    const access = (role: Role) => internalOrderEmailAccess({ id: 'u', access: templateGrant(role) } as any)
    const may = ROLES.filter(role => mayEmailInternalOrders(access(role)))
    expect([...may].sort()).toEqual(['accountant', 'admin', 'manager', 'sales', 'sales_consultant'])
    // The read-only roles print the sheet and mail none: they read and export, and do not write.
    for (const role of ['member', 'nra_auditor'] as Role[]) expect(access(role), role).toEqual({ reads: true, exports: true, writes: false })
    // A Seller makes sales documents, and reads no customer order.
    expect(access('seller')).toEqual({ reads: false, exports: true, writes: false })
  })
})
