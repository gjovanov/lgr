import { computed, reactive, type ComputedRef, type Ref } from 'vue'
import type { ReservationRow, StagedChanges } from '../order-tree/types'
import { newKey, type AllocRow, type LineRow, type ReservationChangesBody } from './supplier-order'
import type { Translate } from './shared'

/**
 * #203: the client reservations of a supplier order (ORDO), staged in the form and saved with the order
 * (`reservationChanges`). Nothing is posted until Save, and the form is never reloaded under the user's edits.
 * Moved out of `OrderFormView` (FR-32.23).
 */
export interface ClientChangeState {
  open: boolean
  contactId: string
  quantity: number
  description: string
  free: number
  warehouseId: string
  /** The row whose client the dialog changes: a saved reservation, or one staged to be made. */
  row: ReservationRow | null
}

export interface StagedReservations {
  staged: StagedChanges
  hasStaged: ComputedRef<boolean>
  clearStaged: () => void
  setRowQuantity: (row: ReservationRow, q: number) => void
  removeRow: (row: ReservationRow) => void
  toggleCancel: (resId: string) => void
  stagedRepeat: (resId: string) => boolean
  stageRepeat: (res: any) => void
  reservationChangesPayload: () => ReservationChangesBody | undefined
  /** The "change client" dialog: what is left of the reserve dialog once + Client became a row (FR-28.40). */
  reserveDialog: ClientChangeState
  openClientChange: (row: ReservationRow, line: LineRow, alloc: AllocRow) => void
  submitReservation: () => void
}

export interface StagedDeps {
  reservations: Ref<any[]>
  /** Every allocation of the order, as edited. */
  allocations: () => AllocRow[]
  /** What is still free to reserve on an allocation (the form's figures, staged changes counted). */
  allocFree: (alloc: AllocRow) => number
  showError: (text: string) => void
  t: Translate
}

export function useStagedReservations(deps: StagedDeps): StagedReservations {
  const { reservations, t } = deps
  const staged = reactive<StagedChanges>({
    creates: [],
    updates: {},
    cancels: [],
  })
  const hasStaged = computed(() => staged.creates.length > 0 || Object.keys(staged.updates).length > 0 || staged.cancels.length > 0)
  function clearStaged() {
    staged.creates = []
    staged.updates = {}
    staged.cancels = []
  }

  function setRowQuantity(row: ReservationRow, q: number) {
    if (row.createKey) {
      const c = staged.creates.find(x => x.key === row.createKey)
      if (c) c.quantity = q
      return
    }
    const original = reservations.value.find((r) => r._id === row.resId)
    const u = { ...(staged.updates[row.resId!] || {}) }
    if (original && q === Number(original.quantity)) delete u.quantity
    else u.quantity = q
    if (Object.keys(u).length) staged.updates[row.resId!] = u
    else delete staged.updates[row.resId!]
  }
  /** A staged create goes; a saved reservation is marked to cancel on save, or unmarked. */
  function removeRow(row: ReservationRow) {
    if (row.createKey) {
      staged.creates = staged.creates.filter(c => c.key !== row.createKey)
      return
    }
    toggleCancel(row.resId!)
  }
  function toggleCancel(resId: string) {
    if (staged.cancels.includes(resId)) staged.cancels = staged.cancels.filter(id => id !== resId)
    else {
      staged.cancels = [...staged.cancels, resId]
      delete staged.updates[resId]
    }
  }
  const stagedRepeat = (resId: string) => staged.creates.some(c => c.repeatOf === resId)
  /** „Резервирай отново": the cancelled reservation, staged again on its allocation if the order still has it. */
  function stageRepeat(res: any) {
    const alloc = deps.allocations().find(a => String(a._id) === String(res.allocationId))
    if (!alloc) {
      deps.showError(t('invoicing.reservations.allocationGone'))
      return
    }
    const free = deps.allocFree(alloc)
    if (free <= 0) {
      deps.showError(t('invoicing.reservations.noFreeQuantity'))
      return
    }
    staged.creates.push({ key: newKey(), alloc: { id: String(alloc._id) }, contactId: String(res.contactId), quantity: Math.min(Number(res.quantity) || 0, free), repeatOf: res._id })
  }
  /** The staged changes as the order's PUT/POST carries them. */
  function reservationChangesPayload(): ReservationChangesBody | undefined {
    if (!hasStaged.value) return undefined
    return {
      create: staged.creates.map(c => ({
        ...(c.alloc.id ? { allocationId: c.alloc.id } : { allocationKey: c.alloc.key }),
        contactId: c.contactId,
        quantity: c.quantity,
        ...(c.repeatOf ? { repeatOf: c.repeatOf } : {}),
      })),
      update: Object.entries(staged.updates).map(([id, u]) => ({ id, ...u })),
      cancel: staged.cancels.map(id => ({ id })),
    }
  }

  // ── changing the client of a reservation ──
  // A new reservation is a + Client row on the tree (FR-28.40); this dialog is what is left for "change client".
  // #203: it stages; nothing is posted until the order is saved, and the form is never reloaded under the user's edits.
  const reserveDialog = reactive<ClientChangeState>({
    open: false,
    contactId: '',
    quantity: 0,
    description: '',
    free: 0,
    warehouseId: '',
    row: null,
  })

  function openClientChange(row: ReservationRow, line: LineRow, alloc: AllocRow) {
    reserveDialog.row = row
    reserveDialog.contactId = row.contactId
    reserveDialog.quantity = row.quantity
    reserveDialog.description = line.description
    reserveDialog.free = deps.allocFree(alloc) + row.quantity
    reserveDialog.warehouseId = alloc.warehouseId
    reserveDialog.open = true
  }

  function submitReservation() {
    const row = reserveDialog.row
    if (!row) {
      reserveDialog.open = false
      return
    }
    if (row.createKey) {
      const c = staged.creates.find(x => x.key === row.createKey)
      if (c) { c.contactId = reserveDialog.contactId; c.quantity = reserveDialog.quantity }
    } else {
      const original = reservations.value.find((r) => r._id === row.resId)
      const u: { quantity?: number; contactId?: string } = {}
      if (original && reserveDialog.contactId !== String(original.contactId)) u.contactId = reserveDialog.contactId
      if (original && reserveDialog.quantity !== Number(original.quantity)) u.quantity = reserveDialog.quantity
      if (Object.keys(u).length) staged.updates[row.resId!] = u
      else delete staged.updates[row.resId!]
    }
    reserveDialog.open = false
  }

  return {
    staged, hasStaged, clearStaged, setRowQuantity, removeRow, toggleCancel, stagedRepeat, stageRepeat,
    reservationChangesPayload, reserveDialog, openClientChange, submitReservation,
  }
}
