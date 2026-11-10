import type { CapabilityId } from './catalogue'
import { can, type Grant } from './grant'

/**
 * FR-27.6 (#529) — partitions: one collection, several features. `Invoice` holds sales documents, proforma and
 * bills (incoming documents), told apart by `direction` and `type`. A role reads the kinds whose `view` it holds and
 * writes those whose work actions it holds; a document of another kind is 404 by id and absent from every list,
 * export, ledger and summary (FR-26.6's `purchases` table, written once, as data).
 *
 * On the legacy model `sales-docs`, `proforma` and `bills` come together from the invoicing permissions, and an
 * `areas` list without `purchases` takes `bills` away: exactly today's answers (`access-differential`).
 *
 * Import-pure.
 */
export type DocKind = 'sales' | 'proforma' | 'bills'
export const DOC_KINDS: readonly DocKind[] = ['sales', 'proforma', 'bills']

const FEATURE: Record<DocKind, string> = { sales: 'sales-docs', proforma: 'proforma', bills: 'bills' }
const cap = (k: DocKind, action: string) => `${FEATURE[k]}.${action}` as CapabilityId

/** A document's kind: incoming is a bill, an outgoing proforma is proforma, the rest are sales documents. */
export function kindOfDocument(doc: { direction?: string | null; type?: string | null } | null | undefined): DocKind {
  if (doc?.direction === 'incoming') return 'bills'
  if (doc?.type === 'proforma') return 'proforma'
  return 'sales'
}

export function readsKind(grant: Grant | null | undefined, kind: DocKind): boolean {
  return !!grant && can(grant, cap(kind, 'view'))
}

/** May this grant do this to a document of this kind: `create`, `edit` (any change but deleting) or `delete`. */
export function writesKind(grant: Grant | null | undefined, kind: DocKind, action: 'create' | 'edit' | 'delete'): boolean {
  if (!grant) return false
  if (action === 'edit') return can(grant, [cap(kind, 'create'), cap(kind, 'edit')])
  return can(grant, cap(kind, action))
}

export function readableKinds(grant: Grant | null | undefined): DocKind[] {
  return DOC_KINDS.filter(k => readsKind(grant, k))
}

const CONDITION: Record<DocKind, Record<string, unknown>> = {
  sales: { direction: 'outgoing', type: { $ne: 'proforma' } },
  proforma: { direction: 'outgoing', type: 'proforma' },
  bills: { direction: 'incoming' },
}

/**
 * The filter a list adds for this grant: null when it reads every kind; `{ direction }` when the kinds are one
 * side (what FR-26.6 did); else an `$or` of the kinds. A grant that reads none matches nothing.
 */
export function partitionFilter(grant: Grant | null | undefined): Record<string, unknown> | null {
  const kinds = readableKinds(grant)
  if (kinds.length === DOC_KINDS.length) return null
  if (kinds.length === 2 && kinds.includes('sales') && kinds.includes('proforma')) return { direction: 'outgoing' }
  if (kinds.length === 1 && kinds[0] === 'bills') return { direction: 'incoming' }
  if (!kinds.length) return { direction: { $in: [] } }
  return { $or: kinds.map(k => CONDITION[k]) }
}

/** The one side a summary, a ledger or an export may cover: undefined for both, null for neither. */
export function readableDirection(grant: Grant | null | undefined): 'outgoing' | 'incoming' | undefined | null {
  const out = readsKind(grant, 'sales') || readsKind(grant, 'proforma')
  const inc = readsKind(grant, 'bills')
  if (out && inc) return undefined
  if (out) return 'outgoing'
  if (inc) return 'incoming'
  return null
}
