import type { LookupMatch } from 'config/document-lookup'

/**
 * FR-31.22 (#796, slice B5): where a document the top bar found opens, what it is called and its icon, and the key
 * that focuses the field (D-7). Pure, so `unit/document-jump.test.ts` holds it without a browser.
 */

export interface DocumentRoute {
  name: string
  params: { id: string }
}

/**
 * The page a match opens, by route name (the names the e2e suite and the column choice depend on, FR-31.23). A till
 * document opens as the cash-register journal opens it (`web/src/modules/invoicing/pos/till-rules.ts#journalRoute`): a cash sale
 * made in the back office in its form for whoever reads the documents, anything else on its journal page.
 */
export function documentRoute(m: LookupMatch, readsDocuments: boolean): DocumentRoute {
  const params = { id: m.id }
  switch (m.family) {
    case 'sales': return { name: 'invoicing.sales.edit', params }
    case 'proforma': return { name: m.type === 'offer' ? 'invoicing.offer.edit' : 'invoicing.proforma.edit', params }
    case 'bill': return { name: 'invoicing.purchases.edit', params }
    case 'cash':
      return readsDocuments && m.type === 'cash_sale' && m.origin !== 'pos'
        ? { name: 'invoicing.cash-sales.edit', params }
        : { name: 'invoicing.cash-sales.view', params }
    case 'supplierOrder': return { name: 'invoicing.orders.edit', params }
    case 'customerOrder': return { name: 'invoicing.internalOrders.edit', params }
    case 'reservation': return { name: 'invoicing.reservations.detail', params }
    case 'movement': return { name: 'inventory.movements.view', params }
  }
}

/** The kind of document a match is, as a catalogue key (`shell.jump.kind.*`). */
export function documentKindKey(m: LookupMatch): string {
  switch (m.family) {
    case 'sales':
      return m.type === 'credit_note' ? 'shell.jump.kind.creditNote' : m.type === 'debit_note' ? 'shell.jump.kind.debitNote' : 'shell.jump.kind.invoice'
    case 'proforma': return m.type === 'offer' ? 'shell.jump.kind.offer' : 'shell.jump.kind.proforma'
    case 'bill': return 'shell.jump.kind.bill'
    case 'cash':
      if (m.type === 'cash_storno') return 'shell.jump.kind.cashStorno'
      if (m.type === 'payment_receipt') return 'shell.jump.kind.paymentReceipt'
      if (m.type === 'payment_storno') return 'shell.jump.kind.paymentStorno'
      return 'shell.jump.kind.cashSale'
    case 'supplierOrder': return 'shell.jump.kind.supplierOrder'
    case 'customerOrder': return 'shell.jump.kind.customerOrder'
    case 'reservation': return 'shell.jump.kind.reservation'
    case 'movement': return 'shell.jump.kind.movement'
  }
}

/** The icon of a match: its list's, as the menus show it (`ui-shared/nav/page-registry.ts`). */
export function documentIcon(m: LookupMatch): string {
  switch (m.family) {
    case 'sales': return 'mdi-receipt-text-outline'
    case 'proforma': return m.type === 'offer' ? 'mdi-file-sign' : 'mdi-file-document-outline'
    case 'bill': return 'mdi-receipt-text'
    case 'cash': return 'mdi-cash-register'
    case 'supplierOrder': return 'mdi-clipboard-list-outline'
    case 'customerOrder': return 'mdi-account-clock-outline'
    case 'reservation': return 'mdi-lock-clock'
    case 'movement': return 'mdi-swap-horizontal'
  }
}

/** The parts of a key event the shortcut reads. */
export interface JumpKeyEvent {
  key: string
  code?: string
  ctrlKey: boolean
  metaKey: boolean
  altKey: boolean
  shiftKey: boolean
  isComposing?: boolean
}

/**
 * Ctrl+K (⌘K on a Mac) focuses the field, from any screen (D-7). The document line table's own keys are Tab, Enter
 * and the arrows (`useGridNavigation`), and a form's are Ctrl+S and Ctrl+Enter (`form-shortcuts.ts`): none is K. With
 * a Cyrillic layout `key` is „к" or „л", so the physical key decides, as for Ctrl+S. Alt is AltGr on a European
 * keyboard, where it types a character, so it is never the shortcut.
 */
export function isJumpShortcut(e: JumpKeyEvent): boolean {
  if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey || e.isComposing) return false
  if (/^[a-z]$/i.test(e.key)) return e.key.toLowerCase() === 'k'
  return e.code === 'KeyK'
}
