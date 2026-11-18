import { computed, nextTick, reactive, ref, type ComputedRef, type Ref } from 'vue'
import type { OrderFigures } from '../order-tree/figures'
import type { AddingRow, StagedChanges, SupplierOrderTree, TreeNode } from '../order-tree/types'
import { newKey, type AllocRow, type LineRow } from './supplier-order'
import type { Translate } from './shared'

/**
 * FR-28.40: + Warehouse and + Client are rows of the supplier order's tree, not dialogs. A row appears under its parent
 * with what it needs; Enter adds it (staged, marked new, the figures move) and Escape drops it. Nothing is sent until
 * Save: a reservation is still staged and saved with the order. Moved out of `OrderFormView` (FR-32.23).
 */
export interface DraftRow { warehouseId: string; contactId: string; quantity: number; menu: boolean; showErrors: boolean }

export interface AddingRowEditor {
  adding: Ref<AddingRow | null>
  draft: DraftRow
  draftMessages: ComputedRef<{ warehouse: string[]; client: string[]; qty: string[] }>
  startAdding: (node: TreeNode | undefined) => void
  commitAdding: () => void
  cancelAdding: () => void
  onEditorKeydown: (e: KeyboardEvent) => void
  focusDraftQuantity: () => void
}

export interface AddingRowDeps {
  /** The tree and the figures are built with the row being added, so they are read when needed. */
  tree: () => SupplierOrderTree
  figures: () => OrderFigures
  lineOf: (node: TreeNode) => LineRow
  allocOf: (node: TreeNode) => AllocRow
  staged: StagedChanges
  /** Opens the row in its supplier's tree. */
  openRow: (node: TreeNode) => void
  t: Translate
}

export function useAddingRow(deps: AddingRowDeps): AddingRowEditor {
  const { lineOf, allocOf, t } = deps
  const adding = ref<AddingRow | null>(null)
  const draft = reactive<DraftRow>({ warehouseId: '', contactId: '', quantity: 0, menu: false, showErrors: false })

  function startAdding(node: TreeNode | undefined) {
    if (!node || (node.kind !== 'line' && node.kind !== 'allocation')) return
    const forWarehouse = node.kind === 'line'
    draft.warehouseId = ''
    draft.contactId = ''
    draft.showErrors = false
    draft.menu = false
    // It starts at what is left to place on the line, or to reserve on the warehouse.
    draft.quantity = forWarehouse ? (deps.figures().line(lineOf(node)).figures.free ?? 0) : (deps.figures().allocation(allocOf(node)).free ?? 0)
    adding.value = { parentId: node.id, kind: forWarehouse ? 'allocation' : 'reservation' }
    // The row opens its parent, and the parent stays open once the row has been added.
    deps.openRow(node)
    void nextTick(() => {
      document.querySelector<HTMLInputElement>('[data-tree-editor] input')?.focus()
      draft.menu = true
    })
  }

  /** What is wrong with the row being added, by field: the checks of the dialog it replaces, and one more. */
  const draftProblems = computed(() => {
    const out = { warehouse: '', client: '', qty: '' }
    const a = adding.value
    const parent = a ? deps.tree().index.get(a.parentId) : undefined
    if (!a || !parent) return out
    const q = Number(draft.quantity) || 0
    if (a.kind === 'allocation') {
      if (!draft.warehouseId) out.warehouse = t('invoicing.tree.chooseWarehouse')
      const f = deps.figures().line(lineOf(parent))
      if (!(q > 0)) out.qty = t('invoicing.tree.qtyAboveZero')
      else if (f.allocated + q > f.figures.quantity) out.qty = t('invoicing.overAllocated')
    } else {
      if (!draft.contactId) out.client = t('invoicing.tree.chooseClient')
      const free = deps.figures().allocation(allocOf(parent)).free ?? 0
      if (!(q > 0)) out.qty = t('invoicing.tree.qtyAboveZero')
      else if (q > free) out.qty = t('invoicing.tree.exceedsFree', { free })
    }
    return out
  })
  /** Said beside the field, but only once the row has been tried: a row nobody has touched is not an error. */
  const draftMessages = computed(() => ({
    warehouse: draft.showErrors && draftProblems.value.warehouse ? [draftProblems.value.warehouse] : [],
    client: draft.showErrors && draftProblems.value.client ? [draftProblems.value.client] : [],
    qty: draft.showErrors && draftProblems.value.qty ? [draftProblems.value.qty] : [],
  }))

  function commitAdding() {
    const a = adding.value
    const parent = a ? deps.tree().index.get(a.parentId) : undefined
    if (!a || !parent) return
    const p = draftProblems.value
    if (p.warehouse || p.client || p.qty) {
      draft.showErrors = true
      return
    }
    const quantity = Number(draft.quantity)
    if (a.kind === 'allocation') {
      lineOf(parent).allocations.push({ _key: newKey(), warehouseId: draft.warehouseId, quantity })
    } else {
      const alloc = allocOf(parent)
      deps.staged.creates.push({ key: newKey(), alloc: alloc._id ? { id: String(alloc._id) } : { key: alloc._key }, contactId: draft.contactId, quantity })
    }
    adding.value = null
  }
  function cancelAdding() { adding.value = null }

  /**
   * Enter adds, Escape drops: unless a list is open, which answers both itself (Enter picks, Escape closes it).
   * Listened to in the CAPTURE phase, before the field sees the key: by the time a bubbling listener runs, the
   * field has already closed its list and Vue has already written that to `aria-expanded`, so the same Enter
   * that picked a warehouse would add the row with the quantity it started with.
   */
  function onEditorKeydown(e: KeyboardEvent) {
    if (e.key !== 'Enter' && e.key !== 'Escape') return
    if ((e.target as HTMLElement | null)?.getAttribute?.('aria-expanded') === 'true') return
    e.preventDefault()
    e.stopPropagation() // an Enter on a closed list would open it again
    if (e.key === 'Enter') commitAdding()
    else cancelAdding()
  }
  /** After a warehouse or a client is chosen the cursor is in the quantity, ready to be typed over. */
  function focusDraftQuantity() {
    void nextTick(() => {
      const input = document.querySelector<HTMLInputElement>('[data-tree-editor-qty] input')
      input?.focus()
      input?.select()
    })
  }

  return { adding, draft, draftMessages, startAdding, commitAdding, cancelAdding, onEditorKeydown, focusDraftQuantity }
}
