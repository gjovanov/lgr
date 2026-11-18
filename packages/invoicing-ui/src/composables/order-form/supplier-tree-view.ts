import type { TreeActionType, TreeColumn, TreeNode } from '../order-tree/types'
import { resStatusColor, type Translate } from './shared'

/**
 * FR-28.39: what the supplier order's tree says in its columns, beside what the node model computes
 * (`composables/order-tree`). Moved out of `OrderFormView` (FR-32.23).
 */

export function supplierTreeColumns(t: Translate, isEdit: boolean): TreeColumn[] {
  return [
    { key: 'item', title: t('invoicing.tree.item') },
    { key: 'qty', title: t('invoicing.qty'), align: 'end', width: '64px' },
    { key: 'unit', title: t('invoicing.unit'), width: '68px' },
    { key: 'price', title: t('invoicing.tree.price'), align: 'end', width: '76px' },
    { key: 'reserved', title: t('invoicing.tree.reserved'), align: 'end', width: '80px' },
    { key: 'free', title: t('invoicing.freeQty'), hint: t('invoicing.tree.freeHint'), align: 'end', width: '56px' },
    ...(isEdit
      ? ([
          { key: 'received', title: t('invoicing.tree.received'), align: 'end', width: '82px' },
          { key: 'invoiced', title: t('invoicing.tree.invoiced'), align: 'end', width: '74px' },
          { key: 'dispatched', title: t('invoicing.tree.dispatched'), align: 'end', width: '90px', optional: true },
        ] as TreeColumn[])
      : []),
    { key: 'status', title: t('common.status'), width: '96px' },
    { key: 'actions', title: '', width: '144px' },
  ]
}

/** The tooltip of Invoiced while Dispatched has no column of its own (a narrow screen): both figures, so neither is lost. */
export function invoicedAndDispatched(t: Translate, f: { invoiced: number; dispatched: number }): string {
  return `${t('invoicing.tree.invoiced')} ${f.invoiced} · ${t('invoicing.tree.dispatched')} ${f.dispatched}`
}

export interface SupplierStatusChip { key: string; text: string; color?: string; variant?: 'tonal' | 'outlined'; label?: boolean }
/**
 * What a row says about itself. A reservation: its status, or that it is new, changed or cancelled on save. A
 * line or a warehouse: its own flags while open; closed, also what is flagged below it, so folding hides nothing.
 * (The chip over a closed parent says "unsaved", never "unsaved changes": that is the Reservations card's.)
 */
export function supplierStatusChips(t: Translate, node: TreeNode, open: boolean): SupplierStatusChip[] {
  const out: SupplierStatusChip[] = []
  const r = node.reservation
  if (node.kind === 'reservation' && r) {
    if (r.cancelled) out.push({ key: 'cancel', text: t('invoicing.reservations.willCancel'), color: 'error' })
    else if (r.createKey) out.push({ key: 'new', text: t('invoicing.reservations.new'), color: 'success' })
    else {
      if (r.status) out.push({ key: 'status', text: t(`invoicing.status.${r.status}`), color: resStatusColor(r.status), label: true })
      if (r.changed) out.push({ key: 'changed', text: t('invoicing.tree.changed'), color: 'warning' })
    }
    return out
  }
  const flags = open ? node.flags : node.rolledFlags
  if (flags.includes('overAllocated')) out.push({ key: 'over', text: t('invoicing.tree.overAllocated'), color: 'error' })
  if (flags.includes('unallocated')) out.push({ key: 'unalloc', text: t('invoicing.tree.unallocated', { n: node.figures.free ?? 0 }), variant: 'outlined' })
  if (flags.some((f) => f === 'new' || f === 'changed' || f === 'cancelledOnSave')) out.push({ key: 'unsaved', text: t('invoicing.tree.unsaved'), color: 'warning' })
  return out
}

export const supplierActionText = (t: Translate, type: TreeActionType): string =>
  t(type === 'addWarehouse' ? 'invoicing.tree.addWarehouse' : 'invoicing.tree.addClient')
export const supplierActionIcon = (type: TreeActionType): string =>
  ({ remove: 'mdi-close', cancel: 'mdi-close', undo: 'mdi-undo', changeClient: 'mdi-account-switch-outline' } as Record<string, string>)[type]
export const supplierActionTitle = (t: Translate, type: TreeActionType): string =>
  t(({ remove: 'common.remove', cancel: 'invoicing.cancelReservation', undo: 'invoicing.reservations.keep', changeClient: 'invoicing.reservations.changeClient' } as Record<string, string>)[type])
