import { ref, watch } from 'vue'
import { useRoute } from 'vue-router'

/**
 * Which document a form view shows, as a `:key` for its form (FR-22.16).
 *
 * Vue Router reuses a view when only the route's params or query change, so `/invoices/A/edit` →
 * `/invoices/B/edit` — or → `/invoices/new?type=credit_note&relatedInvoiceId=A`, or „+ Нов" on an
 * open document — kept the form that was mounted, showing A under B's address. `formKey` changes
 * when a different document arrives, so a form keyed on it mounts fresh.
 *
 * One move is NOT a different document: a new one the form has just saved, moving onto its own
 * edit route. The form says so first (`adopt`) and keeps its state — it goes on issuing or
 * printing the document it has just created.
 */
export function useDocumentRouteKey() {
  const route = useRoute()

  function documentOf(): string {
    const id = route.params.id
    if (id) return String(id)
    // A new document is defined by what it starts from: a related invoice, one it copies, or the
    // article it was opened from (FR-22.47).
    return `new:${route.query.relatedInvoiceId || ''}:${route.query.copyOf || ''}:${route.query.productId || ''}`
  }

  /** Bumped when a different document arrives: what the form's `:key` follows. */
  const formKey = ref(0)
  let shown = documentOf()
  let adopted: string | null = null

  /** The mounted form created document `id` and is about to move onto its edit route. */
  function adopt(id: string) {
    adopted = String(id)
  }

  watch(documentOf, (next) => {
    if (next === shown) return
    const same = adopted !== null && next === adopted
    adopted = null
    shown = next
    if (!same) formKey.value++
  })

  return { formKey, adopt }
}
