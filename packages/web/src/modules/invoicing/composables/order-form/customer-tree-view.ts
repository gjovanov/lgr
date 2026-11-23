import type { TreeActionType, TreeColumn, TreeNode } from '../order-tree/types'
import { coverageColor } from './customer-order'
import { resStatusColor, type Translate } from './shared'

/**
 * FR-28.44: what the customer order's tree says in its columns, beside what the node model computes
 * (`composables/order-tree/customer-order-tree.ts`). Moved out of `InternalOrderFormView` (FR-32.23).
 */

/**
 * The widths of the two figures the user types: a quantity of five digits and a price to 9,999.99 are read whole at 1366 px
 * (the right panel open or folded) and at 1920 px, which `customer-order-tree.spec.ts` measures on the fields. They rest on
 * the number-field rules of `OrderTree.vue` (no spin buttons, no padding in the field): with those a digit takes 9 px.
 * The price column also holds the line's „Select price" before the field: the button's 20 px and the 4 px between them
 * are added to the 84 px the column had, so the field is as wide as it was. The article's column pays for it, and still
 * has more than its minimum at 1366 px with the right panel open.
 */
const QTY_COL = '68px'
const PRICE_COL = '108px'

/**
 * The columns are the supplier order's, with what a customer order says in them: Free is what is still SHORT, and Delivered
 * (not Dispatched) is the goods that left. A new order has nothing to show in the figures, so it has only the line's own fields.
 */
export function customerTreeColumns(t: Translate, isEdit: boolean): TreeColumn[] {
  return [
    { key: 'item', title: t('invoicing.tree.itemOrder') },
    { key: 'qty', title: t('invoicing.qty'), align: 'end', width: QTY_COL },
    { key: 'unit', title: t('invoicing.unit'), width: '68px' },
    { key: 'price', title: t('invoicing.tree.price'), align: 'end', width: PRICE_COL },
    ...(isEdit
      ? ([
          { key: 'reserved', title: t('invoicing.tree.reserved'), align: 'end', width: '80px' },
          { key: 'free', title: t('invoicing.shortQty'), hint: t('invoicing.tree.shortHint'), align: 'end', width: '60px' },
          { key: 'invoiced', title: t('invoicing.tree.invoiced'), align: 'end', width: '74px' },
          { key: 'dispatched', title: t('invoicing.tree.delivered'), align: 'end', width: '90px', optional: true },
          { key: 'status', title: t('common.status'), width: '142px' },
        ] as TreeColumn[])
      : []),
    // + Reserve and the remove button side by side, in the longest of the four languages (Reservieren, 104 px).
    { key: 'actions', title: '', width: isEdit ? '152px' : '64px' },
  ]
}

/** The tooltip of Invoiced while Delivered has no column of its own (a narrow screen): both figures, so neither is lost. */
export function invoicedAndDelivered(t: Translate, f: { invoiced: number; dispatched: number }): string {
  return `${t('invoicing.tree.invoiced')} ${f.invoiced} · ${t('invoicing.tree.delivered')} ${f.dispatched}`
}

/**
 * A line not saved yet (or the blank one waiting for an article) has no figures to show: nothing is reserved or invoiced against it.
 * A reservation shows its own invoiced and dispatched, but no Reserved or Free (its quantity is its own column).
 */
export function figureOf(node: TreeNode, value: number | null | undefined, ownToo = false): string | number {
  if (node.kind === 'line' && !node.coverage) return ''
  if (node.kind === 'reservation' && !ownToo) return ''
  return value ?? ''
}

/** EXACTLY what the line's chip has always said: 'Reserved Qty: 4/4', or 'Ordered: 4/4' while the cover waits on a supplier order not sent. */
function coverageText(t: Translate, node: TreeNode): string {
  const label = node.coverage?.status === 'ordered' ? t('invoicing.coverage.ordered') : t('invoicing.reservedQty')
  return `${label}: ${node.figures.reserved}/${node.figures.quantity}`
}

export interface CustomerStatusChip { key: string; text: string; color?: string; label?: boolean; icon?: string; title?: string }
/**
 * A reservation says its status (and that it is late); a line says how far it is covered, and, while it is closed, what
 * is wrong below it (`rolledFlags`), so folding a line never hides the thing that needs a look.
 */
export function customerStatusChips(t: Translate, node: TreeNode, open: boolean): CustomerStatusChip[] {
  const lateChip: CustomerStatusChip = { key: 'late', text: t('invoicing.tree.late'), color: 'error', icon: 'mdi-clock-alert-outline', title: t('invoicing.lateDelivery') }
  if (node.kind === 'reservation' && node.reservation) {
    const status = node.reservation.status || ''
    const chips: CustomerStatusChip[] = [{ key: 'status', text: t(`invoicing.status.${status}`), color: resStatusColor(status), label: true }]
    if (node.reservation.late) chips.push(lateChip)
    return chips
  }
  if (node.kind !== 'line' || !node.coverage) return []
  const chips: CustomerStatusChip[] = [{
    key: 'coverage',
    text: coverageText(t, node),
    color: coverageColor(node.coverage.status),
    // FR-22.44: a line whose cover waits on a supplier order not sent yet reads "Ordered".
    title: node.coverage.onUnsentOrder > 0 ? t('invoicing.onUnsentOrder', { count: node.coverage.onUnsentOrder }) : undefined,
  }]
  const flags = open ? node.flags : node.rolledFlags
  if (flags.includes('overReserved')) chips.push({ key: 'overReserved', text: t('invoicing.tree.overReserved'), color: 'error' })
  if (flags.includes('late')) chips.push(lateChip)
  return chips
}

// The controls of a row. The labels are the ones the buttons have always had: specs and walks look them up by name.
export function customerActionIcon(type: TreeActionType): string {
  return ({ remove: 'mdi-close', editQuantity: 'mdi-pencil', release: 'mdi-close', reserveAgain: 'mdi-restore' } as Record<string, string>)[type] || 'mdi-dots-horizontal'
}
export function customerActionColor(type: TreeActionType): string | undefined {
  return type === 'release' || type === 'remove' ? 'error' : type === 'reserveAgain' ? 'primary' : undefined
}
export function customerActionTitle(t: Translate, type: TreeActionType): string {
  return ({
    remove: t('common.remove'),
    editQuantity: t('invoicing.reservations.changeQuantity'),
    release: t('invoicing.reservations.release'),
    reserveAgain: t('invoicing.reservations.reserveAgain'),
  } as Record<string, string>)[type] || ''
}
